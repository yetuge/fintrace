import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { auditSecArtifacts } from '../financial/sec-audit.js';
import {
  extractFinancials,
  filingsFromColumns,
} from '../financial/sec-metrics.js';
import { extractAnnualTrends } from '../financial/sec-trends.js';
import {
  buildEvidenceDataset,
  normalizeFindings,
} from '../financial/sec-evidence.js';
import { withDataContext } from '../financial/sec-data-context.js';
import { hash } from './input.js';
import type { Check, Dimension, Score, Trace } from './types.js';

export const dimensions: Dimension[] = [
  'task_completion',
  'tool_behavior',
  'numerical_correctness',
  'evidence_integrity',
  'artifact_delivery',
  'failure_handling',
  'judgment_boundary',
];
export const responseSchema = z
  .object({
    status: z.enum(['completed', 'partial', 'failed']),
    dataMode: z.enum(['live_sec', 'snapshot', 'injected_failure']),
    filingBodyRead: z.boolean(),
    summary: z.string().min(1),
    limitations: z.array(z.string().min(1)),
    artifacts: z.array(z.string()),
  })
  .strict();
export function parseResponse(text: string) {
  try {
    return responseSchema.parse(
      JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')),
    );
  } catch {
    return undefined;
  }
}
const check = (
  status: Check['status'],
  evidence: string[],
  boundary = 'Deterministic structure only; natural language semantics require review.',
): Check => ({ status, evidence, boundary });
export async function within(root: string, relative: string) {
  const target = path.resolve(root, relative);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    target === path.resolve(root) ||
    !target.startsWith(path.resolve(root) + path.sep)
  )
    throw new Error('BENCHMARK_PATH_ESCAPE');
  const real = await fs.realpath(target);
  if (!real.startsWith((await fs.realpath(root)) + path.sep))
    throw new Error('BENCHMARK_SYMLINK_ESCAPE');
  return real;
}
async function json(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
const numeric = (data: any) =>
  data.metrics.map((m: any) =>
    data.schemaVersion === 3
      ? { key: m.key, annual: m.annual }
      : {
          key: m.key,
          current: m.current,
          previous: m.previous,
          yoyPercent: m.yoyPercent,
          yoyReason: m.yoyReason,
          missingReason: m.missingReason,
        },
  );
export async function scoreTrace(
  trace: Trace,
  workspace: string,
): Promise<Score> {
  const scores = Object.fromEntries(
    dimensions.map((d) => [d, check('not_applicable', ['Task not executed.'])]),
  ) as Score['dimensions'];
  const review = trace.task.manual.map((r) => `${trace.task.id}: ${r}`);
  const attribution: string[] = [];
  const finish = (): Score => ({
    taskId: trace.task.id,
    mode: trace.task.mode,
    execution: trace.status,
    overall: Object.values(scores).some((c) => c.status === 'failed')
      ? 'failed'
      : Object.values(scores).some((c) => c.status === 'needs_review')
        ? 'needs_review'
        : trace.status === 'not_executed'
          ? 'not_applicable'
          : 'passed',
    dimensions: scores,
    attribution,
    review,
  });
  if (trace.status !== 'executed') return finish();
  const task = trace.task;
  const failedSource = task.injection === 'sec_429';
  const fetches = trace.tools.filter((t) =>
    t.name.endsWith('fetch_sec_financials'),
  );
  const saves = trace.tools.filter((t) => t.name.endsWith('save_sec_report'));
  const response = parseResponse(trace.finalAnswer);
  const fetch = fetches.find((t) => t.status === 'succeeded');
  const validFetch =
    fetches.length > 0 &&
    fetches.every(
      (t) =>
        t.args.company === task.company && (t.args.years ?? 1) === task.years,
    );
  const toolsOK =
    validFetch &&
    trace.tools.every((t) =>
      /^(mcp__miniclaw__)?(fetch_sec_financials|save_sec_report)$/.test(t.name),
    ) &&
    (failedSource
      ? fetches.every(
          (t) => t.status === 'failed' && t.errorCode === 'SEC_HTTP_429',
        ) && saves.length === 0
      : !!fetch?.datasetId &&
        saves.some(
          (t) =>
            t.status === 'succeeded' &&
            t.saved &&
            t.args.dataset_id === fetch.datasetId &&
            t.order > fetch.order,
        ) &&
        saves.every(
          (t) => t.args.dataset_id === fetch.datasetId && t.order > fetch.order,
        ));
  scores.tool_behavior = check(toolsOK ? 'passed' : 'failed', [
    toolsOK
      ? 'Required calls, company/years, sequence and dataset binding verified.'
      : 'Missing/incorrect calls, parameters, ordering or dataset binding.',
    ...trace.tools.map(
      (t) =>
        `${t.order} ${t.name}: ${t.status}${t.errorCode ? ' ' + t.errorCode : ''}`,
    ),
  ]);
  let data: any, rebuilt: any, findings: any, rawFacts: any;
  let artifactsOK = false;
  if (failedSource) {
    const files = await fs
      .readdir(path.join(workspace, 'financial-research'))
      .catch(() => []);
    const noSuccess =
      !fetch &&
      !saves.some((t) => t.saved || t.status === 'succeeded') &&
      trace.datasetIds.length === 0 &&
      trace.artifacts.length === 0 &&
      files.length === 0;
    scores.artifact_delivery = check(noSuccess ? 'passed' : 'failed', [
      noSuccess
        ? 'No success dataset/report after injected failure.'
        : 'Success artifact or dataset after source failure.',
    ]);
    scores.task_completion = check(
      noSuccess && toolsOK && response?.status === 'failed'
        ? 'passed'
        : response
          ? 'failed'
          : 'needs_review',
      [
        'Expected behavior is a failed fetch and truthful refusal, not a financial report.',
      ],
    );
    scores.failure_handling = check(
      !noSuccess || (response && response.status !== 'failed')
        ? 'failed'
        : response?.status === 'failed' && response.limitations.length
          ? 'passed'
          : 'needs_review',
      [
        'Recorded SEC_HTTP_429; structured failure status and limitations checked. Explanation semantics remain manual.',
      ],
    );
    attribution.push(
      'External-service behavior is intentionally injected; this is not a real SEC outage.',
    );
  } else {
    const directory = fetch?.datasetId
      ? `financial-research/${fetch.datasetId}`
      : undefined;
    try {
      if (!directory) throw new Error('NO_SUCCESSFUL_FETCH');
      const root = await within(workspace, directory);
      data = await json(path.join(root, 'metrics.json'));
      assert.equal(data.datasetId, fetch!.datasetId);
      const raw = await json(path.join(root, 'raw.json'));
      const facts = raw.responses.find((r: any) =>
        r.url.includes('/companyfacts/'),
      )?.body;
      rawFacts = facts;
      const filings = raw.responses
        .filter((r: any) => r.url.includes('/submissions/'))
        .flatMap((r: any) =>
          filingsFromColumns(
            r.body.filings?.recent ?? r.body,
            data.company.cik,
          ),
        );
      rebuilt = withDataContext(
        task.years === 3
          ? extractAnnualTrends(
              facts,
              filings,
              data.company.tickers,
              data.fetchedAt,
              data.asOf,
              data.sources,
              data.datasetId,
            )
          : buildEvidenceDataset(
              extractFinancials(
                facts,
                filings,
                data.company.tickers,
                data.fetchedAt,
                data.asOf,
                data.sources,
              ),
              data.datasetId,
            ),
        raw.dataContext,
      );
      assert.equal(data.dataContext?.mode, task.mode);
      assert.equal(data.dataContext?.inputSha256, trace.inputSha256);
      assert.deepEqual(data.dataContext, raw.dataContext);
      assert.deepEqual(numeric(data), numeric(rebuilt), 'NUMERIC_MISMATCH');
      assert.equal(data.company.cik, task.company);
      assert.equal(data.schemaVersion, task.years === 3 ? 3 : 2);
      if (task.mode !== 'live_sec') assert.equal(data.asOf, task.asOf);
      scores.numerical_correctness = check(
        'passed',
        [
          'All metric values, periods, provenance and comparable YoY recomputed from raw.',
        ],
        'Recomputes stored SEC input, not the truth or completeness of public filings; final prose is not numerically parsed.',
      );
    } catch {
      scores.numerical_correctness = check('failed', [
        'Missing dataset or numeric/source/period/dataset identity recomputation mismatch.',
      ]);
    }
    try {
      if (!directory || !rebuilt || !data) throw new Error('MISSING_DATASET');
      const root = await within(workspace, directory);
      findings = await json(path.join(root, 'findings.json'));
      assert.equal(findings.datasetId, data.datasetId);
      assert.deepEqual(data.evidence, rebuilt.evidence);
      assert.deepEqual(data.verifiedFacts, rebuilt.verifiedFacts);
      assert.deepEqual(
        findings.findings,
        normalizeFindings(rebuilt, findings.inputs),
      );
      scores.evidence_integrity = check(
        'passed',
        [
          'Current dataset evidence and code facts reconstructed; finding references/classification validated.',
        ],
        'Valid association does not prove a qualitative conclusion is supported.',
      );
    } catch {
      scores.evidence_integrity = check('failed', [
        'Missing findings, wrong dataset, fabricated evidence or invalid fact/classification.',
      ]);
    }
    try {
      if (!directory) throw new Error('NO_ARTIFACTS');
      const required = [
        'raw.json',
        'metrics.json',
        'manifest.json',
        'findings.json',
        'report.md',
        ...(task.years === 3 ? ['chart-data.json', 'trends.svg'] : []),
      ];
      for (const file of required) {
        const relative: string = `${directory}/${file}`;
        const recorded: Trace['artifacts'][number] | undefined =
          trace.artifacts.find((a) => a.path === relative);
        assert.ok(recorded, `UNRECORDED_${file}`);
        assert.equal(
          hash(await fs.readFile(await within(workspace, relative))),
          recorded.sha256,
          `HASH_${file}`,
        );
      }
      await auditSecArtifacts(await within(workspace, directory));
      artifactsOK = true;
      scores.artifact_delivery = check('passed', [
        'Required files exist, trace SHA-256 matches, existing SEC audit passes including canonical report/chart.',
      ]);
    } catch {
      scores.artifact_delivery = check('failed', [
        'Missing file, changed trace hash or SEC artifact audit failed.',
      ]);
    }
    let scenarioOK = !!data;
    if (data) {
      if (['annual_research', 'three_year_trend'].includes(task.category))
        scenarioOK =
          data.metrics.length === 5 &&
          data.metrics.every((m: any) =>
            task.years === 3
              ? m.annual.length === 3 && m.annual.every((p: any) => p.value)
              : m.current && m.previous && m.yoyPercent !== null,
          ) &&
          (task.years !== 3 || data.years.length === 3);
      if (task.injection === 'remove_cash_tag') {
        const m = data.metrics.find((m: any) => m.key === 'cash');
        scenarioOK =
          !!m &&
          !m.current &&
          !m.previous &&
          m.yoyPercent === null &&
          !!m.missingReason &&
          !data.evidence.some((e: any) => e.metricKey === 'cash');
      }
      if (task.injection === 'prior_revenue_eur') {
        const m = data.metrics.find((m: any) => m.key === 'revenue');
        const units =
          rawFacts?.facts?.['us-gaap']
            ?.RevenueFromContractWithCustomerExcludingAssessedTax?.units;
        scenarioOK =
          m?.current?.unit === 'USD' &&
          !m.previous &&
          !!units?.EUR?.some((v: any) => v.end === '2025-06-30') &&
          !units?.USD?.some((v: any) => v.end === '2025-06-30') &&
          m.yoyPercent === null &&
          !!m.yoyReason &&
          !data.verifiedFacts.some(
            (f: any) => f.id === `${data.datasetId}:revenue:yoy`,
          );
      }
      if (task.category === 'insufficient_explanation_evidence')
        scenarioOK =
          findings?.findings.some(
            (f: any) =>
              f.type === 'unverified' &&
              f.limitations.length > 0 &&
              f.verification === 'not_semantically_verified',
          ) ?? false;
    }
    scores.task_completion = check(
      scenarioOK && artifactsOK && toolsOK
        ? response
          ? 'passed'
          : 'needs_review'
        : 'failed',
      [
        scenarioOK
          ? 'Scenario-specific expected data behavior verified.'
          : 'Required scenario data/behavior absent.',
        response
          ? 'Final response envelope available.'
          : 'Final response envelope unavailable; manually assess answer.',
      ],
    );
    if (response?.status === 'failed')
      scores.task_completion = check('failed', [
        'Final response reports failure despite expected research delivery.',
      ]);
    if (task.injection)
      scores.failure_handling = check(
        !scenarioOK || response?.status === 'failed'
          ? 'failed'
          : response?.limitations.length
            ? 'passed'
            : 'needs_review',
        [
          'Missing/incomparable raw-to-report constraints checked; limitations in response envelope. Prose still requires review.',
        ],
      );
    if (!artifactsOK || !toolsOK || !scenarioOK)
      attribution.push(
        'Product/agent execution or delivery failure; inspect trace and artifacts. Scorer errors require review before attribution.',
      );
  }
  if (
    response &&
    (response.dataMode !== task.mode || response.filingBodyRead)
  ) {
    scores.judgment_boundary = check('failed', [
      'Response claims wrong data mode or filing body read despite no body-reading tool.',
    ]);
  } else {
    scores.judgment_boundary = check(
      'needs_review',
      [
        'Filing body was not read; normalized labels and response declarations do not establish natural language truth.',
      ],
      'Manual reviewer must read final answer, findings and cited evidence. No keyword-based semantic score.',
    );
  }
  if (trace.stopReason !== 'stop') {
    scores.task_completion = check('failed', [
      `Agent did not finish normally: ${trace.stopReason ?? 'unavailable'}.`,
    ]);
    attribution.push(
      trace.reason ??
        'Runtime/model stop; distinguish provider error, budget stop and agent failure using trace.',
    );
  }
  return finish();
}
