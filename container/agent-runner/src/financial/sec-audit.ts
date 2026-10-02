/** Read-only offline audit; integrity, numeric verification and semantics are distinct. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  extractFinancials,
  filingsFromColumns,
  type CompanyFacts,
  type FinancialDataset,
} from './sec-metrics.js';
import {
  buildEvidenceDataset,
  normalizeFindings,
  type FindingInput,
} from './sec-evidence.js';
import { renderSecReport } from './sec-tools.js';
import type { RawResponse } from './sec-client.js';

export async function auditSecArtifacts(directory: string) {
  const raw = await fs.readFile(path.join(directory, 'raw.json'), 'utf8');
  const metrics = await fs.readFile(
    path.join(directory, 'metrics.json'),
    'utf8',
  );
  const report = await fs.readFile(path.join(directory, 'report.md'), 'utf8');
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
  );
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  assert.equal(hash(raw), manifest.rawSha256, 'raw hash');
  assert.equal(hash(metrics), manifest.metricsSha256, 'metrics hash');
  const data = JSON.parse(metrics);
  assert.ok([1, 2].includes(data.schemaVersion), 'unsupported dataset version');
  const responses = (JSON.parse(raw) as { responses: RawResponse[] }).responses;
  const facts = responses.find((r) => r.url.includes('/companyfacts/'))
    ?.body as CompanyFacts;
  assert.ok(facts, 'missing raw company facts');
  const filings = responses
    .filter((r) => r.url.includes('/submissions/'))
    .flatMap((r) => {
      const body = r.body as { filings?: { recent: Record<string, unknown> } };
      return filingsFromColumns(
        body.filings?.recent ?? (r.body as Record<string, unknown>),
        data.company.cik,
      );
    });
  const recomputed = extractFinancials(
    facts,
    filings,
    data.company.tickers,
    data.fetchedAt,
    data.asOf,
    data.sources,
  );
  const numeric = (d: FinancialDataset) => ({
    company: d.company,
    latestAnnual: d.latestAnnual,
    previousAnnualEnd: d.previousAnnualEnd,
    annualStart: d.annualStart,
    currency: d.currency,
    // v1 artifacts can carry earlier explanatory label/basis wording. Preserve it;
    // compare all financial values, provenance, comparability and missing reasons.
    metrics: d.metrics.map((m) => ({
      key: m.key,
      current: m.current,
      previous: m.previous,
      yoyPercent: m.yoyPercent,
      missingReason: m.missingReason,
      yoyReason: m.yoyReason,
    })),
  });
  assert.deepEqual(
    numeric(data),
    numeric(recomputed),
    'offline financial recomputation',
  );
  let directFacts = 0,
    pendingJudgments = 0;
  if (data.schemaVersion === 2) {
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.datasetId, data.datasetId);
    assert.equal(
      path.basename(directory),
      data.datasetId,
      'dataset directory identity',
    );
    const rebuilt = buildEvidenceDataset(recomputed, data.datasetId);
    assert.deepEqual(
      data,
      rebuilt,
      'evidence catalog rebuilt from raw metrics',
    );
    const saved = JSON.parse(
      await fs.readFile(path.join(directory, 'findings.json'), 'utf8'),
    );
    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.datasetId, data.datasetId);
    assert.ok(
      Array.isArray(saved.inputs) &&
        saved.inputs.length >= 1 &&
        saved.inputs.length <= 6,
    );
    const findings = normalizeFindings(rebuilt, saved.inputs as FindingInput[]);
    assert.deepEqual(
      saved.findings,
      findings,
      'finding classification and references',
    );
    assert.equal(
      report,
      renderSecReport(rebuilt, findings),
      'canonical report content',
    );
    directFacts = findings.filter(
      (f) => f.verification === 'code_verified',
    ).length;
    pendingJudgments = findings.length - directFacts;
  } else {
    // Legacy reports remain readable; their qualitative conclusions were never audited.
    for (const metric of recomputed.metrics) {
      if (metric.current) {
        assert.ok(
          report.includes(metric.current.value.toLocaleString('en-US')),
        );
        assert.ok(report.includes(metric.current.source));
      }
      if (metric.yoyPercent !== null)
        assert.ok(report.includes(metric.yoyPercent.toFixed(2) + '%'));
    }
  }
  return {
    schemaVersion: data.schemaVersion,
    company: data.company,
    annualEnd: data.latestAnnual.end,
    rawAndMetricsHashesValid: true,
    recomputedMetricsMatch: true,
    evidenceAssociationsVerified: data.schemaVersion === 2,
    directFacts,
    pendingJudgments,
    qualitativeSemanticsVerified: false,
    filingBodyRead: false,
    legacyQualitativeFindingsUnaudited: data.schemaVersion === 1,
    reportSha256: hash(report),
  };
}
