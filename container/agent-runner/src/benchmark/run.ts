import fs from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createSecTools } from '../financial/sec-tools.js';
import { adaptClaudeMcpToolsToPi } from '../runtime/pi/pi-tools.js';
import { PiRuntimeAdapter } from '../runtime/pi/pi-runtime.js';
import { RequestBudget } from './budget.js';
import { taskInput, hash } from './input.js';
import type { Task, Trace, ToolCall } from './types.js';

export function redact(text: string, secrets: string[] = []) {
  let safe = text;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    safe = safe.split(secret).join('[redacted]');
  return safe
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/(?:sk-|gh[opusr]_)[A-Za-z0-9_-]{12,}/g, '[redacted-key]')
    .replace(/https?:\/\/[^\s"<>]+/g, (url) => {
      try {
        if (url === 'http://www.w3.org/2000/svg') return url;
        return [
          'www.sec.gov',
          'data.sec.gov',
          'www.annualreports.com',
          'github.com',
        ].includes(new URL(url.replace(/[),.;]+$/, '')).hostname)
          ? url
          : '[redacted-url]';
      } catch {
        return '[redacted-url]';
      }
    });
}
export function promptFor(task: Task) {
  return `${task.question}\n数据模式=${task.mode}；截至=${task.asOf}；来源=${task.source}。只使用提供的 SEC 工具。调用 fetch_sec_financials 时 company=${task.company}, years=${task.years}。报告 findings 只需一条，直接事实必须选择工具代码事实及完整证据；解释须标明未核验和具体资料缺口。不要重试数据源故障，不要读取其他会话。\n最终回答严格为 JSON 对象：{"status":"completed|partial|failed","dataMode":"${task.mode}","filingBodyRead":false,"summary":"简短说明交付或失败，不重复指标数表","limitations":["尚缺资料或限制"],"artifacts":["实际交付相对文件路径"]}。保存报告后不要再调用工具。`;
}
export async function executeTask(options: {
  task: Task;
  taskSetVersion: string;
  taskSetSha256: string;
  directory: string;
  fixtures: string;
  budget: RequestBudget;
  provider: {
    model: string;
    endpointKind: 'official' | 'custom';
    baseUrl: string;
    apiKey: string;
  };
  secrets: string[];
}): Promise<Trace> {
  const { task, directory, budget, provider, secrets } = options;
  await fs.mkdir(directory, { recursive: true });
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  const input = await taskInput(task, options.fixtures);
  const prompt = promptFor(task);
  const trace: Trace = {
    version: 1,
    task,
    taskSetVersion: options.taskSetVersion,
    taskSetSha256: options.taskSetSha256,
    inputSha256: input.inputSha256,
    prompt,
    sessionId: 'unavailable',
    entry: 'pi_runtime_adapter',
    modelAlias: 'configured-model-1',
    status: 'executed',
    tools: [],
    finalAnswer: '',
    elapsedMs: 0,
    modelRequests: 0,
    usage: {
      input: 'unavailable',
      output: 'unavailable',
      cacheRead: 'unavailable',
      cacheWrite: 'unavailable',
      cost: 'unavailable',
    },
    artifacts: [],
    datasetIds: [],
  };
  if (budget.exhausted) {
    trace.status = 'not_executed';
    trace.reason = 'batch_budget_exhausted';
    return trace;
  }
  const counts = {
    requests: budget.requests,
    input: budget.input,
    output: budget.output,
    cacheRead: budget.cacheRead,
    cacheWrite: budget.cacheWrite,
  };
  let taskUnknown = false;
  const started = Date.now();
  const checkpoint = () => {
    trace.elapsedMs = Date.now() - started;
    trace.modelRequests = budget.requests - counts.requests;
    trace.knownUsage = {
      input: budget.input - counts.input,
      output: budget.output - counts.output,
      cacheRead: budget.cacheRead - counts.cacheRead,
      cacheWrite: budget.cacheWrite - counts.cacheWrite,
    };
    const temporary = path.join(directory, 'checkpoint.tmp');
    writeFileSync(
      temporary,
      redact(
        JSON.stringify(
          {
            trace,
            budget: {
              chargedRequests: budget.requests,
              chargedOutputTokens: budget.chargedOutput,
              knownOutputTokens: budget.output,
              usageUnavailable: budget.unavailable,
            },
          },
          null,
          2,
        ),
        secrets,
      ) + '\n',
    );
    renameSync(temporary, path.join(directory, 'checkpoint.json'));
  };
  checkpoint();
  const runtime = new PiRuntimeAdapter({
    beforeRequest: () => {
      if (budget.requests - counts.requests >= 4)
        throw new Error('BENCHMARK_TASK_REQUEST_LIMIT');
      const allocation = budget.beforeRequest();
      checkpoint();
      return allocation;
    },
    onResponse: (status) => {
      (trace.modelHttpStatuses ??= []).push(status);
      checkpoint();
    },
    onMessage: (message) => {
      budget.onMessage(message);
      const m = message as any;
      if (!m.usage || ['error', 'aborted'].includes(m.stopReason))
        taskUnknown = true;
      trace.stopReason = m.stopReason;
      trace.finalAnswer = redact(
        (m.content ?? [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join(''),
        secrets,
      );
      if (m.errorMessage)
        trace.reason =
          /BENCHMARK_[A-Z_]+/.exec(m.errorMessage)?.[0] ??
          'provider_or_runtime_error';
      checkpoint();
    },
  });
  let session:
    | Awaited<ReturnType<PiRuntimeAdapter['createSession']>>
    | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const tools = createSecTools(workspace, input.request, input.clock);
    // Mode is exposed to the real model at the dependency boundary, never disguised as live.
    tools[0].description = `[Benchmark data mode: ${task.mode}; source: ${task.source}] ${tools[0].description}`;
    const customTools = adaptClaudeMcpToolsToPi(tools, {
      namespace: 'mcp__miniclaw',
    });
    session = await runtime.createSession({
      cwd: workspace,
      sessionDir: path.join(directory, 'runtime', 'sessions'),
      systemPrompt:
        '你是 FinTrace 金融研究 Agent。依据 SEC 工具数据完成用户任务，缺失不造数；证据不足的定性判断保留限制，未读取正文不能宣称正文核验。使用工具交付真实文件。',
      model: provider.model,
      provider,
      customTools,
      allowedTools: customTools.map((t) => t.name),
      autoCompactEnabled: false,
    });
    trace.sessionId = session.sessionId;
    checkpoint();
    const calls = new Map<string, ToolCall>();
    session.subscribe((event) => {
      if (event.type !== 'tool_start' && event.type !== 'tool_end') return;
      const id = event.toolCallId;
      if (!id) return;
      let call = calls.get(id);
      if (!call) {
        call = {
          order: trace.tools.length + 1,
          id,
          name: event.toolName,
          args: {},
          status: 'started',
        };
        calls.set(id, call);
        trace.tools.push(call);
      }
      if (event.input)
        call.args = JSON.parse(redact(JSON.stringify(event.input), secrets));
      if (event.type === 'tool_end' && event.result !== undefined) {
        call.status = event.isError ? 'failed' : 'succeeded';
        const text =
          (event.result as any)?.content
            ?.filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('') ?? '';
        if (event.isError)
          call.errorCode =
            /\b(?:SEC|BENCHMARK)_[A-Z_0-9]+/.exec(text)?.[0] ?? 'TOOL_ERROR';
        else {
          try {
            const result = JSON.parse(text);
            if (result.datasetId) {
              call.datasetId = result.datasetId;
              trace.datasetIds.push(result.datasetId);
            }
            if (result.saved === true) call.saved = true;
          } catch {
            call.status = 'failed';
            call.errorCode = 'UNREADABLE_TOOL_RESULT';
          }
        }
      }
      checkpoint();
    });
    timeout = setTimeout(() => {
      trace.reason = 'task_timeout';
      void session?.abort();
    }, 300_000);
    await session.prompt({ text: prompt });
  } catch (error) {
    if (budget.requests > counts.requests) taskUnknown = true;
    trace.reason =
      /BENCHMARK_[A-Z_]+/.exec(String(error))?.[0] ??
      'provider_or_runtime_error';
    trace.stopReason = 'error';
  } finally {
    if (timeout) clearTimeout(timeout);
    session?.dispose();
    trace.elapsedMs = Date.now() - started;
    trace.modelRequests = budget.requests - counts.requests;
    if (!taskUnknown)
      trace.usage = {
        input: budget.input - counts.input,
        output: budget.output - counts.output,
        cacheRead: budget.cacheRead - counts.cacheRead,
        cacheWrite: budget.cacheWrite - counts.cacheWrite,
        cost: 'unavailable',
      };
  }
  for (const id of trace.datasetIds) {
    if (!/^\d{10}-[0-9a-f-]{36}$/.test(id))
      throw new Error('BENCHMARK_BAD_DATASET_ID');
    const dir = path.join(workspace, 'financial-research', id);
    for (const name of await fs.readdir(dir)) {
      const bytes = await fs.readFile(path.join(dir, name));
      // Only public SEC artifacts created by this task; never copy private session logs.
      if (bytes.toString() !== redact(bytes.toString(), secrets)) {
        trace.reason = 'BENCHMARK_ARTIFACT_PRIVACY_CHECK';
        trace.stopReason = 'error';
        checkpoint();
        return trace;
      }
      trace.artifacts.push({
        path: `financial-research/${id}/${name}`,
        sha256: hash(bytes),
      });
    }
  }
  checkpoint();
  return trace;
}
