/** Audit saved research without network requests or model/provider access. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  extractFinancials,
  filingsFromColumns,
  type CompanyFacts,
  type FinancialDataset,
} from '../container/agent-runner/src/financial/sec-metrics.js';
import type { RawResponse } from '../container/agent-runner/src/financial/sec-client.js';

const directory = path.resolve(process.argv[2] ?? '');
if (!process.argv[2])
  throw new Error(
    'Usage: npx tsx scripts/verify-sec-artifacts.ts <research-directory> [Pi-session-directory]',
  );
const raw = await fs.readFile(path.join(directory, 'raw.json'), 'utf8');
const metrics = await fs.readFile(path.join(directory, 'metrics.json'), 'utf8');
const report = await fs.readFile(path.join(directory, 'report.md'), 'utf8');
const manifest = JSON.parse(
  await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
assert.equal(hash(raw), manifest.rawSha256);
assert.equal(hash(metrics), manifest.metricsSha256);
const dataset = JSON.parse(metrics) as FinancialDataset;
const responses = (JSON.parse(raw) as { responses: RawResponse[] }).responses;
const facts = responses.find((r) => r.url.includes('/companyfacts/'))!
  .body as CompanyFacts;
const filings = responses
  .filter((r) => r.url.includes('/submissions/'))
  .flatMap((r) => {
    const body = r.body as { filings?: { recent: Record<string, unknown> } };
    return filingsFromColumns(
      body.filings?.recent ?? (r.body as Record<string, unknown>),
      dataset.company.cik,
    );
  });
const recalculated = extractFinancials(
  facts,
  filings,
  dataset.company.tickers,
  dataset.fetchedAt,
  dataset.asOf,
  dataset.sources,
);
const numericEvidence = (data: FinancialDataset) =>
  data.metrics.map((m) => ({
    key: m.key,
    current: m.current,
    previous: m.previous,
    yoyPercent: m.yoyPercent,
  }));
assert.deepEqual(numericEvidence(dataset), numericEvidence(recalculated));
for (const metric of dataset.metrics) {
  if (metric.current) {
    assert.ok(report.includes(metric.current.value.toLocaleString('en-US')));
    assert.ok(report.includes(metric.current.source));
  }
  if (metric.yoyPercent !== null)
    assert.ok(report.includes(metric.yoyPercent.toFixed(2) + '%'));
}
let modelEvidence: unknown = null;
if (process.argv[3]) {
  const sessionDirectory = path.resolve(process.argv[3]);
  const entries = (await fs.readdir(sessionDirectory)).filter((f) =>
    f.endsWith('.jsonl'),
  );
  const messages = (
    await Promise.all(
      entries.map(async (f) =>
        (await fs.readFile(path.join(sessionDirectory, f), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ),
    )
  )
    .flat()
    .filter((e) => e.type === 'message')
    .map((e) => e.message);
  const results = messages.filter(
    (m) =>
      m.role === 'toolResult' &&
      /fetch_sec_financials|save_sec_report/.test(m.toolName),
  );
  assert.equal(results.length, 2);
  assert.ok(results.every((m) => !m.isError));
  const turns = messages.filter((m) => m.role === 'assistant');
  modelEvidence = {
    successfulTools: results.map((m) => m.toolName),
    userPrompts: messages.filter((m) => m.role === 'user').length,
    assistantRequests: turns.length,
    outputTokens: turns.reduce((sum, m) => sum + (m.usage?.output ?? 0), 0),
  };
}
const evidence = {
  verifiedAt: new Date().toISOString(),
  company: dataset.company,
  annualEnd: dataset.latestAnnual.end,
  rawAndMetricsHashesValid: true,
  recomputedMetricsMatch: true,
  officialSourceCount: dataset.sources.length,
  reportSha256: hash(report),
  modelEvidence,
};
await fs.writeFile(
  path.join(directory, 'verification.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
