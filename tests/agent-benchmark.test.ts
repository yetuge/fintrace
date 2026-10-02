import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSecTools } from '../container/agent-runner/src/financial/sec-tools.js';
import {
  taskInput,
  hash,
} from '../container/agent-runner/src/benchmark/input.js';
import {
  scoreTrace,
  within,
} from '../container/agent-runner/src/benchmark/score.js';
import { redact } from '../container/agent-runner/src/benchmark/run.js';
import {
  RequestBudget,
  assertPayloadLimit,
} from '../container/agent-runner/src/benchmark/budget.js';
import {
  selectBatchRecords,
  summarize,
} from '../container/agent-runner/src/benchmark/report.js';
import type {
  Task,
  Trace,
} from '../container/agent-runner/src/benchmark/types.js';

const temps: string[] = [];
test('cross-batch selection retains later budget failures and excludes only unselected tasks', async () => {
  const task = (await tasks())[0];
  const success = { trace: trace(task), batch: 'first' };
  const stopped = {
    trace: {
      ...trace(task),
      status: 'not_executed' as const,
      reason: 'batch_budget_exhausted',
    },
    batch: 'later',
  };
  const unselected = {
    trace: {
      ...trace(task),
      status: 'not_executed' as const,
      reason: 'not_selected',
    },
    batch: 'unrelated',
  };
  expect(selectBatchRecords([success, stopped, unselected]).get(task.id)).toBe(
    stopped,
  );
  expect(selectBatchRecords([stopped, success, unselected]).get(task.id)).toBe(
    success,
  );
  expect(selectBatchRecords([unselected]).size).toBe(0);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of temps.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
async function workspace() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fintrace-benchmark-'));
  temps.push(d);
  return d;
}
async function tasks(): Promise<Task[]> {
  return JSON.parse(await fs.readFile('benchmarks/tasks.json', 'utf8')).tasks;
}
const response = (task: Task, status = 'completed') =>
  JSON.stringify({
    status,
    dataMode: task.mode,
    filingBodyRead: false,
    summary: '工具已完成相应交付；说明限制。',
    limitations: ['未读取申报正文，不能核验因果。'],
    artifacts: [],
  });
function trace(task: Task): Trace {
  return {
    version: 1,
    task,
    taskSetVersion: 'test',
    taskSetSha256: 'test',
    inputSha256: 'test',
    prompt: task.question,
    sessionId: 'test-session',
    entry: 'pi_runtime_adapter',
    modelAlias: 'test-fixture-NOT-real-model',
    status: 'executed',
    tools: [],
    finalAnswer: response(task),
    stopReason: 'stop',
    elapsedMs: 1,
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
}
async function delivered(task?: Task) {
  task ??= (await tasks())[5];
  const root = await workspace();
  const input = await taskInput(task, path.resolve('benchmarks/fixtures'));
  const tools = createSecTools(root, input.request, input.clock);
  const fetched = JSON.parse(
    (await tools[0].handler({ company: task.company, years: task.years }, {}))
      .content[0].text as string,
  );
  const args = {
    dataset_id: fetched.datasetId,
    findings: [
      {
        type: 'unverified',
        content: '原因与偿债能力需要进一步核验。',
        evidence_ids: [fetched.evidence[0].id],
        limitations: ['尚缺申报正文、收入构成、有息债务期限与利息费用。'],
      },
    ],
  };
  await tools[1].handler(args, {});
  const t = trace(task);
  t.inputSha256 = input.inputSha256;
  t.tools = [
    {
      order: 1,
      id: 'fetch',
      name: 'mcp__miniclaw__fetch_sec_financials',
      args: { company: task.company, years: task.years },
      status: 'succeeded',
      datasetId: fetched.datasetId,
    },
    {
      order: 2,
      id: 'save',
      name: 'mcp__miniclaw__save_sec_report',
      args,
      status: 'succeeded',
      saved: true,
    },
  ];
  t.datasetIds = [fetched.datasetId];
  const relative = `financial-research/${fetched.datasetId}`;
  const dir = path.join(root, relative);
  for (const file of await fs.readdir(dir))
    t.artifacts.push({
      path: `${relative}/${file}`,
      sha256: hash(await fs.readFile(path.join(dir, file))),
    });
  return { t, root, dir };
}
describe('deterministic Agent benchmark scoring (no model)', () => {
  test('correct SEC artifacts pass structural checks, qualitative semantics remain manual', async () => {
    const { t, root } = await delivered();
    const s = await scoreTrace(t, root);
    for (const d of [
      'task_completion',
      'tool_behavior',
      'numerical_correctness',
      'evidence_integrity',
      'artifact_delivery',
    ] as const)
      expect(s.dimensions[d].status).toBe('passed');
    expect(s.dimensions.judgment_boundary.status).toBe('needs_review');
    expect(s.overall).toBe('needs_review');
  });
  test('wrong number fails recomputation even if trace and manifest hashes were updated', async () => {
    const { t, root, dir } = await delivered();
    const p = path.join(dir, 'metrics.json');
    const d = JSON.parse(await fs.readFile(p, 'utf8'));
    d.metrics[0].current.value += 100;
    const bytes = JSON.stringify(d, null, 2) + '\n';
    await fs.writeFile(p, bytes);
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'),
    );
    manifest.metricsSha256 = hash(bytes);
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest),
    );
    t.artifacts.find((a) => a.path.endsWith('/metrics.json'))!.sha256 =
      hash(bytes);
    expect(
      (await scoreTrace(t, root)).dimensions.numerical_correctness.status,
    ).toBe('failed');
  });
  test('wrong dataset reference fails separately from numerical correctness', async () => {
    const { t, root, dir } = await delivered();
    const p = path.join(dir, 'findings.json');
    const d = JSON.parse(await fs.readFile(p, 'utf8'));
    d.inputs[0].evidence_ids = ['another-dataset:cash:current'];
    await fs.writeFile(p, JSON.stringify(d));
    const s = await scoreTrace(t, root);
    expect(s.dimensions.numerical_correctness.status).toBe('passed');
    expect(s.dimensions.evidence_integrity.status).toBe('failed');
  });
  test('missing file fails delivery; valid numbers alone do not count as completion', async () => {
    const { t, root, dir } = await delivered();
    await fs.unlink(path.join(dir, 'report.md'));
    const s = await scoreTrace(t, root);
    expect(s.dimensions.artifact_delivery.status).toBe('failed');
    expect(s.dimensions.task_completion.status).toBe('failed');
  });
  test('failed SEC followed by claimed success fails; no fake numerical denominator', async () => {
    const task = (await tasks())[4];
    const t = trace(task);
    const root = await workspace();
    t.tools = [
      {
        order: 1,
        id: 'fetch',
        name: 'fetch_sec_financials',
        args: { company: task.company, years: 1 },
        status: 'failed',
        errorCode: 'SEC_HTTP_429',
      },
    ];
    const s = await scoreTrace(t, root);
    expect(s.dimensions.failure_handling.status).toBe('failed');
    expect(s.dimensions.task_completion.status).toBe('failed');
    expect(s.dimensions.numerical_correctness.status).toBe('not_applicable');
  });
  test('reasonable structured failure gets behavioral credit, explanation still needs review', async () => {
    const task = (await tasks())[4];
    const t = trace(task);
    const root = await workspace();
    t.finalAnswer = response(task, 'failed');
    t.tools = [
      {
        order: 1,
        id: 'fetch',
        name: 'fetch_sec_financials',
        args: { company: task.company, years: 1 },
        status: 'failed',
        errorCode: 'SEC_HTTP_429',
      },
    ];
    const s = await scoreTrace(t, root);
    expect(s.dimensions.tool_behavior.status).toBe('passed');
    expect(s.dimensions.failure_handling.status).toBe('passed');
    expect(s.dimensions.task_completion.status).toBe('passed');
    expect(s.overall).toBe('needs_review');
  });
  test.each([2, 3])(
    'injected data condition %s has correct nulls, reasons and audited report',
    async (i) => {
      const task = (await tasks())[i];
      const { t, root } = await delivered(task);
      const s = await scoreTrace(t, root);
      expect(s.dimensions.task_completion.status).toBe('passed');
      expect(s.dimensions.failure_handling.status).toBe('passed');
      expect(s.dimensions.numerical_correctness.status).toBe('passed');
    },
  );
  test('wrong company/years and saving another dataset fail tool behavior', async () => {
    const { t, root } = await delivered();
    t.tools[0].args.years = 3;
    t.tools[1].args.dataset_id = 'other';
    expect((await scoreTrace(t, root)).dimensions.tool_behavior.status).toBe(
      'failed',
    );
  });
  test('mode deception and claiming filing body read fail declarations without keyword semantics', async () => {
    const { t, root } = await delivered();
    const r = JSON.parse(t.finalAnswer);
    r.dataMode = 'live_sec';
    r.filingBodyRead = true;
    t.finalAnswer = JSON.stringify(r);
    expect(
      (await scoreTrace(t, root)).dimensions.judgment_boundary.status,
    ).toBe('failed');
  });
  test('unexecuted tasks remain N/A and outside scoring denominators', async () => {
    const task = (await tasks())[4];
    const t = trace(task);
    t.status = 'not_executed';
    const s = await scoreTrace(t, await workspace());
    expect(s.overall).toBe('not_applicable');
    const summary = summarize([s]) as any;
    expect(summary.all.notExecuted).toBe(1);
    expect(summary.all.dimensions.task_completion.denominator).toBe(0);
  });
  test('snapshot cannot silently access absent SEC URL or any network', async () => {
    const network = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', network);
    const input = await taskInput(
      (await tasks())[5],
      path.resolve('benchmarks/fixtures'),
    );
    await expect(
      input.request('https://data.sec.gov/submissions/missing.json'),
    ).rejects.toThrow('SNAPSHOT_URL_MISSING');
    expect(network).not.toHaveBeenCalled();
  });
  test('source failure is injected at SEC dependency, not fake model', async () => {
    const root = await workspace();
    const input = await taskInput(
      (await tasks())[4],
      path.resolve('benchmarks/fixtures'),
    );
    const tool = createSecTools(root, input.request)[0];
    await expect(tool.handler({ company: '0000789019' }, {})).rejects.toThrow(
      'SEC_HTTP_429',
    );
    expect(await fs.readdir(root)).toEqual([]);
  });
  test('paths cannot escape batch, including symlinks', async () => {
    const root = await workspace();
    await expect(within(root, '../outside')).rejects.toThrow('PATH_ESCAPE');
  });
  test('redaction removes configured credentials, model, private address and contact', () => {
    expect(
      redact(
        'secret-value model-private https://private.test/messages contact@example.test',
        ['secret-value', 'model-private'],
      ),
    ).toBe('[redacted] [redacted] [redacted-url] [redacted-email]');
  });
  test('SVG namespace survives privacy check without admitting private provider URLs', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>';
    expect(redact(svg)).toBe(svg);
    expect(redact('https://provider.private/v1/messages')).toBe(
      '[redacted-url]',
    );
  });
});
describe('request boundary budget', () => {
  test('prior incomplete run is reserved conservatively within the same total limits', () => {
    const b = new RequestBudget(24, 18000, 1600, { requests: 6, output: 9600 });
    expect(b.beforeRequest().maxOutputTokens).toBe(1600);
    expect(b.requests).toBe(7);
    expect(b.chargedOutput).toBe(11200);
  });
  test('accepts explicit disabled thinking; rejects upstream-expanded caps and reasoning', () => {
    expect(() =>
      assertPayloadLimit(
        { max_tokens: 1600, thinking: { type: 'disabled' } },
        1600,
      ),
    ).not.toThrow();
    expect(() => assertPayloadLimit({ max_tokens: 3200 }, 1600)).toThrow(
      'TOKEN_BOUNDARY',
    );
    expect(() =>
      assertPayloadLimit(
        {
          max_tokens: 1600,
          thinking: { type: 'enabled', budget_tokens: 1024 },
        },
        1600,
      ),
    ).toThrow('TOKEN_BOUNDARY');
  });
  test('request cap blocks before dispatch; known usage releases only actual difference', () => {
    const b = new RequestBudget(2, 100, 80);
    expect(b.beforeRequest()).toEqual({ maxOutputTokens: 80 });
    b.onMessage({
      stopReason: 'stop',
      usage: { input: 4, output: 30, cacheRead: 0, cacheWrite: 0 },
    });
    expect(b.chargedOutput).toBe(30);
    expect(b.beforeRequest().maxOutputTokens).toBe(70);
    expect(() => b.beforeRequest()).toThrow('BUDGET_EXHAUSTED');
    expect(b.requests).toBe(2);
  });
  test('unknown usage and provider errors retain reservation and stop new requests', () => {
    const b = new RequestBudget(24, 80, 80);
    b.beforeRequest();
    b.onMessage({
      stopReason: 'error',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(b.unavailable).toBe(true);
    expect(b.chargedOutput).toBe(80);
    expect(() => b.beforeRequest()).toThrow('BUDGET_EXHAUSTED');
  });
});
