import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  RequestBudget,
  recoverBudgetLedger,
} from '../container/agent-runner/src/benchmark/budget.js';
import { hash } from '../container/agent-runner/src/benchmark/input.js';
import {
  scoreTrace,
  within,
} from '../container/agent-runner/src/benchmark/score.js';
import {
  markdownReport,
  selectBatchRecords,
  summarize,
  usageTotals,
} from '../container/agent-runner/src/benchmark/report.js';
import type {
  Task,
  Trace,
} from '../container/agent-runner/src/benchmark/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
const value = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const taskSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.string(),
  company: z.string().regex(/^\d{10}$/),
  years: z.union([z.literal(1), z.literal(3)]),
  mode: z.enum(['live_sec', 'snapshot', 'injected_failure']),
  asOf: z.string(),
  source: z.string(),
  snapshot: z.string().optional(),
  injection: z
    .enum(['remove_cash_tag', 'prior_revenue_eur', 'sec_429'])
    .optional(),
  question: z.string(),
  expected: z.string(),
  failureConditions: z.array(z.string()),
  observe: z.array(z.string()),
  automatic: z.array(z.string()),
  manual: z.array(z.string()),
});
const taskSetSchema = z.object({
  version: z.string(),
  tasks: z.array(taskSchema).length(6),
});
async function main() {
  if (command === 'summarize' && value('batches')) {
    const batches = value('batches')!.split(',');
    if (
      batches.length > 8 ||
      new Set(batches).size !== batches.length ||
      batches.some((id) => !/^[a-zA-Z0-9-]+$/.test(id))
    )
      throw new Error('Safe batch IDs required');
    const candidates: { trace: Trace; batch: string; traceSha256: string }[] =
      [];
    const inputs: Record<string, unknown>[] = [];
    let contractHash: string | undefined;
    let taskOrder: string[] = [];
    for (const batch of batches) {
      const dir = path.join(root, 'data/agent-benchmark', batch);
      const bytes = await fs.readFile(path.join(dir, 'task-set.json'));
      const contract = taskSetSchema.parse(JSON.parse(bytes.toString()));
      const metadata = JSON.parse(
        await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'),
      );
      assert.equal(hash(bytes), metadata.taskSetSha256);
      assert.equal(metadata.batch, batch);
      if (contractHash)
        assert.equal(hash(bytes), contractHash, 'Task set versions differ');
      contractHash = hash(bytes);
      taskOrder = contract.tasks.map((t) => t.id);
      const batchTraces: Trace[] = [];
      for (const task of contract.tasks) {
        const traceBytes = await fs.readFile(
          await within(dir, `${task.id}/trace.json`),
        );
        const trace = JSON.parse(traceBytes.toString()) as Trace;
        assert.deepEqual(trace.task, task);
        assert.equal(trace.taskSetSha256, contractHash);
        assert.equal(trace.taskSetVersion, contract.version);
        batchTraces.push(trace);
        candidates.push({
          trace,
          batch,
          traceSha256: hash(traceBytes),
        });
      }
      inputs.push({
        ...metadata,
        budgetLedger: JSON.parse(
          await fs.readFile(path.join(dir, 'budget.json'), 'utf8'),
        ),
        usageTotals: usageTotals(batchTraces),
      });
    }
    const selection = selectBatchRecords(candidates);
    const records = taskOrder.map((id) => {
      const r = selection.get(id);
      if (!r) throw new Error('Missing selected task');
      return r;
    });
    const scores = await Promise.all(
      records.map((r) =>
        scoreTrace(
          r.trace,
          path.join(
            root,
            'data/agent-benchmark',
            r.batch,
            r.trace.task.id,
            'workspace',
          ),
        ),
      ),
    );
    const metadata = {
      kind: 'multi_batch_summary',
      createdAt: new Date().toISOString(),
      batches,
      taskSetSha256: contractHash,
      inputs,
      selectionRule:
        'Last listed batch excluding not_selected, never best score; original failures and budget stops retained in source batches. Supply batches chronologically.',
      sourceBatches: Object.fromEntries(
        records.map((r) => [r.trace.task.id, r.batch]),
      ),
      scoringGitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      scoringDirty: !!execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      allRunUsage: usageTotals(candidates.map((r) => r.trace)),
    };
    const output = path.join(
      root,
      'data/agent-benchmark',
      `summary-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
    await fs.mkdir(output);
    const result = {
      metadata,
      summary: summarize(scores),
      scores,
      traces: records.map((r) => ({
        taskId: r.trace.task.id,
        sourceBatch: r.batch,
        traceSha256: r.traceSha256,
        modelRequests: r.trace.modelRequests,
        usage: r.trace.usage,
        elapsedMs: r.trace.elapsedMs,
      })),
    };
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' },
    );
    await fs.writeFile(
      path.join(output, 'report.md'),
      markdownReport(
        metadata,
        records.map((r) => r.trace),
        scores,
      ),
      { flag: 'wx' },
    );
    console.log(
      `Report: ${path.relative(root, output).replaceAll(path.sep, '/')}/report.md`,
    );
    return;
  }
  if (command === 'audit') {
    const directory = value('research');
    if (!directory) throw new Error('research path required');
    const { auditSecArtifacts } =
      await import('../container/agent-runner/src/financial/sec-audit.js');
    console.log(
      JSON.stringify(await auditSecArtifacts(path.resolve(directory)), null, 2),
    );
    return;
  }
  if (!['run', 'score', 'summarize', 'list', 'recover'].includes(command))
    throw new Error(
      'Use list | run --live [--task=id] [--batch=id] | score --batch=id [--task=id] | summarize --batch=id or --batches=id1,id2 | audit --research=directory',
    );
  const taskSetBytes = await fs.readFile(
    path.join(root, 'benchmarks/tasks.json'),
  );
  const taskSet = taskSetSchema.parse(JSON.parse(taskSetBytes.toString()));
  if (new Set(taskSet.tasks.map((t) => t.id)).size !== 6)
    throw new Error('Duplicate task ID');
  if (command === 'list') {
    console.log(JSON.stringify(taskSet, null, 2));
    return;
  }
  const batch =
    value('batch') ??
    (command === 'run'
      ? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`
      : '');
  if (!/^[a-zA-Z0-9-]+$/.test(batch))
    throw new Error('Safe --batch ID required');
  const batchDir = path.join(root, 'data/agent-benchmark', batch);
  const selected = value('task');
  const selectedIds =
    value('tasks')?.split(',') ?? (selected ? [selected] : undefined);
  if (selectedIds?.some((id) => !taskSet.tasks.some((t) => t.id === id)))
    throw new Error('Unknown task ID');
  if (selected && !taskSet.tasks.some((t) => t.id === selected))
    throw new Error('Unknown task ID');
  if (command === 'run') {
    await import('../src/load-env.js');
    if (!args.includes('--live'))
      throw new Error(
        'Real model execution requires --live; snapshot tasks also use a real model.',
      );
    await fs.mkdir(path.dirname(batchDir), { recursive: true });
    await fs.mkdir(batchDir); // Never resume/overwrite an existing run or its budget.
    await fs.writeFile(path.join(batchDir, 'task-set.json'), taskSetBytes, {
      flag: 'wx',
    });
    const { getClaudeProviderConfig } =
      await import('../src/runtime-config.js');
    const config = getClaudeProviderConfig();
    const apiKey =
      config.anthropicApiKey ||
      config.anthropicAuthToken ||
      config.claudeCodeOauthToken;
    if (!apiKey || !config.anthropicModel)
      throw new Error(
        'Existing local model configuration unavailable; no config changes made.',
      );
    const { executeTask, redact } =
      await import('../container/agent-runner/src/benchmark/run.js');
    const carryFrom = value('carry-from');
    let reservation = { requests: 0, output: 0 };
    if (carryFrom) {
      if (!/^[a-zA-Z0-9-]+$/.test(carryFrom) || carryFrom === batch)
        throw new Error('Safe carry-from ID required');
      const previous = JSON.parse(
        await fs.readFile(
          path.join(root, 'data/agent-benchmark', carryFrom, 'budget.json'),
          'utf8',
        ),
      );
      reservation = {
        requests: previous.chargedRequests ?? previous.requests,
        output: previous.chargedOutputTokens,
      };
    }
    const requestLimit = Number(value('request-limit') ?? 24);
    const outputLimit = Number(value('output-limit') ?? 18000);
    if (
      !Number.isInteger(requestLimit) ||
      requestLimit < 1 ||
      requestLimit > 24 ||
      !Number.isInteger(outputLimit) ||
      outputLimit < 1 ||
      outputLimit > 18000
    )
      throw new Error('Safe tighter budget limits required');
    const budget = new RequestBudget(
      requestLimit,
      outputLimit,
      1600,
      reservation,
    );
    const metadata = {
      schemaVersion: 1,
      batch,
      gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      startedAt: new Date().toISOString(),
      taskSetVersion: taskSet.version,
      taskSetSha256: hash(taskSetBytes),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        timezone: 'Asia/Shanghai',
      },
      modelAlias: 'configured-model-1',
      budget: {
        requests: requestLimit,
        outputTokens: outputLimit,
        perRequestTokens: 1600,
        perTaskRequests: 4,
      },
      entry: 'pi_runtime_adapter',
      workbenchValidated: false,
      ...(carryFrom ? { carryFrom, priorReservation: reservation } : {}),
    };
    await fs.writeFile(
      path.join(batchDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2) + '\n',
      { flag: 'wx' },
    );
    const secrets = [apiKey, config.anthropicBaseUrl, config.anthropicModel];
    for (const task of taskSet.tasks as Task[]) {
      const directory = path.join(batchDir, task.id);
      let trace: Trace;
      if (selectedIds && !selectedIds.includes(task.id)) {
        await fs.mkdir(directory);
        trace = {
          version: 1,
          task,
          taskSetVersion: taskSet.version,
          taskSetSha256: hash(taskSetBytes),
          inputSha256: 'unavailable',
          prompt: '',
          sessionId: 'unavailable',
          entry: 'pi_runtime_adapter',
          modelAlias: 'configured-model-1',
          status: 'not_executed',
          reason: 'not_selected',
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
      } else {
        console.log(`${task.id}: starting (${task.mode})`);
        trace = await executeTask({
          task,
          taskSetVersion: taskSet.version,
          taskSetSha256: hash(taskSetBytes),
          directory,
          fixtures: path.join(root, 'benchmarks/fixtures'),
          budget,
          provider: {
            model: config.anthropicModel,
            endpointKind: config.anthropicBaseUrl ? 'custom' : 'official',
            baseUrl: config.anthropicBaseUrl,
            apiKey,
          },
          secrets,
        });
        console.log(
          `${task.id}: ${trace.status}, stop=${trace.stopReason ?? trace.reason}, requests=${trace.modelRequests}, output=${trace.usage.output}`,
        );
      }
      await fs.writeFile(
        path.join(directory, 'trace.json'),
        redact(JSON.stringify(trace, null, 2), secrets) + '\n',
        { flag: 'wx' },
      );
    }
    await fs.writeFile(
      path.join(batchDir, 'budget.json'),
      JSON.stringify(
        {
          requests: budget.requests - reservation.requests,
          chargedRequests: budget.requests,
          priorReservation: reservation,
          knownOutputTokens: budget.output,
          chargedOutputTokens: budget.chargedOutput,
          usageUnavailable: budget.unavailable,
          exhausted: budget.exhausted,
          cost: 'unavailable',
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  }
  const frozenBytes = await fs.readFile(path.join(batchDir, 'task-set.json'));
  const frozen = taskSetSchema.parse(JSON.parse(frozenBytes.toString()));
  const metadata = JSON.parse(
    await fs.readFile(path.join(batchDir, 'metadata.json'), 'utf8'),
  );
  if (hash(frozenBytes) !== metadata.taskSetSha256)
    throw new Error('Task set hash mismatch');
  if (command === 'recover') {
    // Validate inherited accounting before writing any recovered traces.
    recoverBudgetLedger(metadata, []);
    const recoveredTraces: Trace[] = [];
    const checkpointBudgets: {
      chargedRequests: number;
      chargedOutputTokens: number;
    }[] = [];
    for (const task of frozen.tasks as Task[]) {
      const dir = path.join(batchDir, task.id),
        file = path.join(dir, 'trace.json');
      await fs.mkdir(dir, { recursive: true });
      let checkpoint: any;
      try {
        checkpoint = JSON.parse(
          await fs.readFile(path.join(dir, 'checkpoint.json'), 'utf8'),
        );
      } catch {}
      if (checkpoint?.budget) checkpointBudgets.push(checkpoint.budget);
      let trace: Trace | undefined;
      try {
        trace = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {}
      if (!trace) {
        const research = path.join(dir, 'workspace', 'financial-research');
        const ids = await fs.readdir(research).catch(() => []);
        trace = checkpoint?.trace ?? {
          version: 1,
          task,
          taskSetVersion: frozen.version,
          taskSetSha256: metadata.taskSetSha256,
          inputSha256: 'unavailable',
          prompt: 'unavailable',
          sessionId: 'unavailable',
          entry: 'pi_runtime_adapter',
          modelAlias: 'configured-model-1',
          status: ids.length ? 'executed' : 'not_executed',
          reason: ids.length
            ? 'execution_trace_unavailable'
            : 'no_execution_record',
          tools: [],
          finalAnswer: '',
          stopReason: 'error',
          elapsedMs: 'unavailable',
          modelRequests: ids.length ? 'unavailable' : 0,
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
        if (checkpoint) {
          trace!.stopReason = 'error';
          trace!.reason = 'interrupted_execution_recovered';
        }
        await fs.writeFile(file, JSON.stringify(trace, null, 2) + '\n', {
          flag: 'wx',
        });
      }
      recoveredTraces.push(trace!);
    }
    const recovery = recoverBudgetLedger(
      metadata,
      recoveredTraces,
      checkpointBudgets,
    );
    // Recovery is explicit and cannot overwrite an existing budget ledger.
    await fs.writeFile(
      path.join(batchDir, 'budget.json'),
      JSON.stringify(recovery, null, 2) + '\n',
      { flag: 'wx' },
    );
    await fs.writeFile(
      path.join(batchDir, 'recovery.json'),
      JSON.stringify({ at: new Date().toISOString(), ...recovery }, null, 2) +
        '\n',
      { flag: 'wx' },
    );
  }
  const traces: Trace[] = [];
  for (const task of frozen.tasks.filter(
    (t) => command !== 'score' || !selected || t.id === selected,
  )) {
    const trace = JSON.parse(
      await fs.readFile(
        await within(batchDir, `${task.id}/trace.json`),
        'utf8',
      ),
    ) as Trace;
    assert.deepEqual(trace.task, task, 'Trace task contract mismatch');
    if (
      trace.taskSetSha256 !== metadata.taskSetSha256 ||
      trace.taskSetVersion !== frozen.version
    )
      throw new Error('Trace task contract mismatch');
    traces.push(trace);
  }
  // score/summarize never import configuration, execution module, or call transport.
  const scores = await Promise.all(
    traces.map((t) =>
      scoreTrace(t, path.join(batchDir, t.task.id, 'workspace')),
    ),
  );
  const result = {
    metadata,
    summary: summarize(scores),
    traces: await Promise.all(
      traces.map(async (t) => ({
        taskId: t.task.id,
        tracePath: `${t.task.id}/trace.json`,
        traceSha256: hash(
          await fs.readFile(path.join(batchDir, t.task.id, 'trace.json')),
        ),
        modelRequests: t.modelRequests,
        usage: t.usage,
        elapsedMs: t.elapsedMs,
      })),
    ),
    scores,
  };
  if (command === 'summarize')
    console.log(JSON.stringify({ metadata, summary: result.summary }, null, 2));
  else if (selected && command === 'score')
    console.log(
      JSON.stringify(
        scores.find((s) => s.taskId === selected),
        null,
        2,
      ),
    );
  else console.log(`Report: data/agent-benchmark/${batch}/report.md`);
  // Revision files preserve initial score and all earlier reviews.
  const revision =
    command === 'run'
      ? 'initial'
      : `review-${selected && command === 'score' ? selected + '-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.writeFile(
    path.join(batchDir, `${revision}.json`),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' },
  );
  await fs.writeFile(
    path.join(batchDir, `${revision}.md`),
    markdownReport(metadata, traces, scores),
    { flag: 'wx' },
  );
  if (!selected || command !== 'score')
    await fs.writeFile(
      path.join(batchDir, 'report.md'),
      markdownReport(metadata, traces, scores),
    );
}
void main().catch((error) => {
  console.error(
    /^(?:Use |Safe |Unknown |Real model |Existing local |Task set |Trace task |Duplicate |research)/.test(
      error.message,
    )
      ? error.message
      : 'Benchmark command failed; private provider details omitted.',
  );
  process.exitCode = 1;
});
