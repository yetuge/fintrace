import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  recoverBudgetLedger,
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
const recoveryBatches: string[] = [];
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
  for (const dir of recoveryBatches.splice(0)) {
    const root = path.resolve('data/agent-benchmark');
    if (
      path.dirname(dir) !== root ||
      !path.basename(dir).startsWith('test-recovery-')
    )
      throw new Error('Unsafe recovery test cleanup');
    await fs.rm(dir, { recursive: true, force: true });
  }
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
  const reply = JSON.parse(t.finalAnswer);
  reply.artifacts = t.artifacts.map((a) => a.path);
  t.finalAnswer = JSON.stringify(reply);
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
  test.each([
    'nonexistent',
    'outside',
    'absolute',
    'windows_absolute',
    'backslashes',
  ])('final answer artifact path %s fails delivery', async (kind) => {
    const { t, root } = await delivered();
    const reply = JSON.parse(t.finalAnswer);
    const dataset = `financial-research/${t.datasetIds[0]}`;
    const invalid = {
      nonexistent: `${dataset}/nonexistent.md`,
      outside: `${dataset}/../../../outside.md`,
      absolute: path.resolve(root, dataset, 'report.md'),
      windows_absolute: 'C:\\outside\\report.md',
      backslashes: `${dataset}/report.md`.replaceAll('/', '\\'),
    }[kind]!;
    reply.artifacts.push(invalid);
    t.finalAnswer = JSON.stringify(reply);
    const s = await scoreTrace(t, root);
    expect(s.dimensions.numerical_correctness.status).toBe('passed');
    expect(s.dimensions.artifact_delivery.status).toBe('failed');
    expect(s.dimensions.task_completion.status).toBe('failed');
  });
  test('existing recorded file from another dataset cannot be delivered', async () => {
    const { t, root } = await delivered();
    const other = 'financial-research/another-dataset/report.md';
    await fs.mkdir(path.dirname(path.join(root, other)), { recursive: true });
    await fs.writeFile(path.join(root, other), 'Other research');
    t.artifacts.push({ path: other, sha256: hash('Other research') });
    const reply = JSON.parse(t.finalAnswer);
    reply.artifacts.push(other);
    t.finalAnswer = JSON.stringify(reply);
    expect(
      (await scoreTrace(t, root)).dimensions.artifact_delivery.status,
    ).toBe('failed');
  });
  test('existing unrecorded file is not a verified delivery', async () => {
    const { t, root, dir } = await delivered();
    await fs.writeFile(path.join(dir, 'extra.md'), 'Unrecorded');
    const reply = JSON.parse(t.finalAnswer);
    reply.artifacts.push(`financial-research/${t.datasetIds[0]}/extra.md`);
    t.finalAnswer = JSON.stringify(reply);
    expect(
      (await scoreTrace(t, root)).dimensions.artifact_delivery.status,
    ).toBe('failed');
  });
  test('reply path through a directory symlink cannot escape the workspace', async () => {
    const { t, root, dir } = await delivered();
    const outside = await workspace();
    await fs.writeFile(path.join(outside, 'report.md'), 'Outside workspace');
    await fs.symlink(outside, path.join(dir, 'external'), 'junction');
    const relative = `financial-research/${t.datasetIds[0]}/external/report.md`;
    t.artifacts.push({ path: relative, sha256: hash('Outside workspace') });
    const reply = JSON.parse(t.finalAnswer);
    reply.artifacts.push(relative);
    t.finalAnswer = JSON.stringify(reply);
    expect(
      (await scoreTrace(t, root)).dimensions.artifact_delivery.status,
    ).toBe('failed');
  });
  test('valid files without a user-facing report path fail delivery', async () => {
    const { t, root } = await delivered();
    const reply = JSON.parse(t.finalAnswer);
    reply.artifacts = reply.artifacts.filter(
      (p: string) => !p.endsWith('/report.md'),
    );
    t.finalAnswer = JSON.stringify(reply);
    expect((await scoreTrace(t, root)).dimensions.task_completion.status).toBe(
      'failed',
    );
  });
  test('three-year mode requires the SVG path in the final answer', async () => {
    const task = { ...(await tasks())[5], years: 3 as const };
    const { t, root } = await delivered(task);
    expect(
      (await scoreTrace(t, root)).dimensions.artifact_delivery.status,
    ).toBe('passed');
    const reply = JSON.parse(t.finalAnswer);
    reply.artifacts = reply.artifacts.filter(
      (p: string) => !p.endsWith('/trends.svg'),
    );
    t.finalAnswer = JSON.stringify(reply);
    const s = await scoreTrace(t, root);
    expect(s.dimensions.artifact_delivery.status).toBe('failed');
    expect(s.dimensions.task_completion.status).toBe('failed');
  });
  test('unparseable final answer leaves delivery paths for manual review', async () => {
    const { t, root } = await delivered();
    t.finalAnswer = 'Report delivered; inspect the workspace.';
    const s = await scoreTrace(t, root);
    expect(s.dimensions.artifact_delivery.status).toBe('needs_review');
    expect(s.dimensions.task_completion.status).toBe('needs_review');
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
    const reply = JSON.parse(t.finalAnswer);
    reply.artifacts = ['financial-research/nonexistent/report.md'];
    t.finalAnswer = JSON.stringify(reply);
    const falseDelivery = await scoreTrace(t, root);
    expect(falseDelivery.dimensions.artifact_delivery.status).toBe('failed');
    expect(falseDelivery.dimensions.task_completion.status).toBe('failed');
    expect(falseDelivery.dimensions.failure_handling.status).toBe('failed');
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
  const recoveryMetadata = {
    carryFrom: 'prior-run',
    priorReservation: { requests: 6, output: 9600 },
    budget: { perTaskRequests: 4, perRequestTokens: 1600 },
  };
  const usedTrace = async (requests: number, output: number) => {
    const t = trace((await tasks())[4]);
    t.modelRequests = requests;
    t.usage.output = output;
    return t;
  };
  test('recovered inherited reservation blocks continuation at the original cap', async () => {
    const ledger = recoverBudgetLedger(recoveryMetadata, [
      await usedTrace(1, 100),
    ]);
    expect(ledger.chargedRequests).toBe(7);
    expect(ledger.chargedOutputTokens).toBe(9700);
    const next = new RequestBudget(7, 9700, 1600, {
      requests: ledger.chargedRequests,
      output: ledger.chargedOutputTokens,
    });
    expect(() => next.beforeRequest()).toThrow('BUDGET_EXHAUSTED');
  });
  test('second interrupted continuation keeps prior recovery and unknown requests', async () => {
    const first = recoverBudgetLedger(recoveryMetadata, [
      await usedTrace(1, 100),
    ]);
    const t = await usedTrace(2, 0);
    t.usage.output = 'unavailable';
    const next = recoverBudgetLedger(
      {
        ...recoveryMetadata,
        priorReservation: {
          requests: first.chargedRequests,
          output: first.chargedOutputTokens,
        },
      },
      [t],
    );
    expect(next.chargedRequests).toBe(9);
    expect(next.chargedOutputTokens).toBe(12900);
    expect(next.usageUnavailable).toBe(true);
  });
  test('cumulative checkpoint preserves a dispatched request missing from the trace', async () => {
    const ledger = recoverBudgetLedger(
      recoveryMetadata,
      [await usedTrace(1, 100)],
      [{ chargedRequests: 8, chargedOutputTokens: 11300 }],
    );
    expect(ledger.chargedRequests).toBe(8);
    expect(ledger.chargedOutputTokens).toBe(11300);
  });
  test('cumulative checkpoints are not added twice or allowed to reduce trace totals', async () => {
    const ledger = recoverBudgetLedger(
      recoveryMetadata,
      [await usedTrace(1, 100), await usedTrace(1, 100)],
      [
        { chargedRequests: 7, chargedOutputTokens: 9700 },
        { chargedRequests: 8, chargedOutputTokens: 9800 },
      ],
    );
    expect(ledger.chargedRequests).toBe(8);
    expect(ledger.chargedOutputTokens).toBe(9800);
  });
  test('standalone recovery has no inherited reservation and excludes unexecuted tasks', async () => {
    const skipped = await usedTrace(4, 6400);
    skipped.status = 'not_executed';
    const ledger = recoverBudgetLedger({ budget: recoveryMetadata.budget }, [
      await usedTrace(1, 100),
      skipped,
    ]);
    expect(ledger.chargedRequests).toBe(1);
    expect(ledger.chargedOutputTokens).toBe(100);
  });
  test('missing or invalid inherited budget fails closed', () => {
    expect(() =>
      recoverBudgetLedger(
        { carryFrom: 'prior', budget: recoveryMetadata.budget },
        [],
      ),
    ).toThrow('MISSING_PRIOR_RESERVATION');
    expect(() =>
      recoverBudgetLedger(
        {
          ...recoveryMetadata,
          priorReservation: { requests: -1, output: 9600 },
        },
        [],
      ),
    ).toThrow('INVALID_RECOVERY_BUDGET');
  });
  test('recover CLI preserves inherited and in-flight reservations in the saved ledger', async () => {
    const batch = `test-recovery-${randomUUID()}`;
    const dir = path.resolve('data/agent-benchmark', batch);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.mkdir(dir);
    recoveryBatches.push(dir);
    const bytes = await fs.readFile('benchmarks/tasks.json');
    const contract = JSON.parse(bytes.toString());
    await fs.writeFile(path.join(dir, 'task-set.json'), bytes);
    await fs.writeFile(
      path.join(dir, 'metadata.json'),
      JSON.stringify({
        ...recoveryMetadata,
        batch,
        taskSetVersion: contract.version,
        taskSetSha256: hash(bytes),
      }),
    );
    for (const task of contract.tasks) {
      const t = trace(task);
      t.taskSetVersion = contract.version;
      t.taskSetSha256 = hash(bytes);
      t.status = 'not_executed';
      t.reason = 'not_selected';
      if (task.id === 'sec-unavailable') {
        t.status = 'executed';
        t.finalAnswer = response(task, 'failed');
        t.modelRequests = 1;
        t.usage.output = 100;
      }
      const taskDir = path.join(dir, task.id);
      await fs.mkdir(taskDir);
      await fs.writeFile(path.join(taskDir, 'trace.json'), JSON.stringify(t));
      if (t.status === 'executed')
        await fs.writeFile(
          path.join(taskDir, 'checkpoint.json'),
          JSON.stringify({
            trace: t,
            budget: { chargedRequests: 8, chargedOutputTokens: 11300 },
          }),
        );
    }
    execFileSync(
      process.execPath,
      [
        'node_modules/tsx/dist/cli.mjs',
        'scripts/agent-benchmark.ts',
        'recover',
        `--batch=${batch}`,
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    const ledger = JSON.parse(
      await fs.readFile(path.join(dir, 'budget.json'), 'utf8'),
    );
    expect(ledger.priorReservation).toEqual(recoveryMetadata.priorReservation);
    expect(ledger.chargedRequests).toBe(8);
    expect(ledger.chargedOutputTokens).toBe(11300);
  }, 20000);
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
