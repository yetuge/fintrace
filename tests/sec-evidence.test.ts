import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixture, filings, columns } from './fixtures/sec-synthetic.js';
import { extractFinancials } from '../container/agent-runner/src/financial/sec-metrics.js';
import {
  buildEvidenceDataset,
  normalizeFindings,
  type FindingInput,
} from '../container/agent-runner/src/financial/sec-evidence.js';
import { createSecTools } from '../container/agent-runner/src/financial/sec-tools.js';
import { auditSecArtifacts } from '../container/agent-runner/src/financial/sec-audit.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

const id = '0000000001-11111111-1111-1111-1111-111111111111';
const extract = () =>
  extractFinancials(
    fixture(),
    filings,
    ['EXM'],
    '2025-04-01T00:00:00Z',
    '2025-04-01',
    ['https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json'],
  );
const data = () => buildEvidenceDataset(extract(), id);
const direct = (): FindingInput => ({
  type: 'direct_fact',
  fact_id: `${id}:revenue:yoy`,
  evidence_ids: [`${id}:revenue:current`, `${id}:revenue:previous`],
  limitations: [],
});
const judgment = (): FindingInput => ({
  type: 'interpretation',
  content: '盈利质量改善，主营业务盈利能力增强，杠杆压力可控。',
  evidence_ids: [
    `${id}:netIncome:current`,
    `${id}:operatingCashFlow:current`,
    `${id}:liabilities:current`,
  ],
  limitations: [
    '尚缺利润构成、非经常性损益、现金流构成、有息债务期限与利息覆盖资料。',
  ],
});
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const d of temporary.splice(0))
    await fs.rm(d, { recursive: true, force: true });
});
async function temp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fintrace-evidence-'));
  temporary.push(d);
  return d;
}

describe('dataset-scoped financial evidence', () => {
  test('retains selected value provenance and code-verifies changes rather than model prose', () => {
    const d = data();
    expect(d.evidence.find((e) => e.id === `${id}:revenue:previous`)).toEqual({
      ...extract().metrics[0].previous,
      id: `${id}:revenue:previous`,
      metricKey: 'revenue',
      label: '营收',
      basis: extract().metrics[0].basis,
      period: 'previous',
    });
    const [fact] = normalizeFindings(d, [
      { ...direct(), content: '盈利质量改善，营收下降。' },
    ]);
    expect(fact.content).toBe('营收较可比上期增长 20.00%。');
    expect(fact.verification).toBe('code_verified');
    expect(fact.content).not.toContain('盈利质量');
  });
  test.each([
    'invented',
    '0000000001-22222222-2222-2222-2222-222222222222:revenue:current',
  ])('rejects unknown or cross-research evidence: %s', (bad) => {
    expect(() =>
      normalizeFindings(data(), [{ ...judgment(), evidence_ids: [bad] }]),
    ).toThrow('SEC_EVIDENCE');
  });
  test('rejects arbitrary facts, incomplete proof, and false missing-data facts', () => {
    expect(() =>
      normalizeFindings(data(), [{ ...direct(), fact_id: 'invented' }]),
    ).toThrow('SEC_FACT');
    expect(() =>
      normalizeFindings(data(), [
        { ...direct(), evidence_ids: [`${id}:revenue:current`] },
      ]),
    ).toThrow('SEC_FACT');
    const original = extract();
    original.metrics[0].current = null;
    original.metrics[0].yoyPercent = null;
    const missing = buildEvidenceDataset(original, id);
    expect(missing.evidence.some((e) => e.id === `${id}:revenue:current`)).toBe(
      false,
    );
    expect(() => normalizeFindings(missing, [direct()])).toThrow(
      'SEC_EVIDENCE',
    );
  });
  test('cannot label unsupported qualitative judgments as verified facts or explanations', () => {
    const [pending] = normalizeFindings(data(), [judgment()]);
    expect(pending.type).toBe('unverified');
    expect(pending.requestedType).toBe('interpretation');
    expect(pending.verification).toBe('not_semantically_verified');
    expect(pending.limitations[0]).toBe(judgment().limitations[0]);
    expect(() =>
      normalizeFindings(data(), [{ ...judgment(), type: 'direct_fact' }]),
    ).toThrow('SEC_FACT');
    expect(() =>
      normalizeFindings(data(), [{ ...judgment(), limitations: [] }]),
    ).toThrow('SEC_FINDING');
    expect(() =>
      normalizeFindings(data(), [
        { ...judgment(), content: '净利润为 999 USD' },
      ]),
    ).toThrow('SEC_FINDING');
  });
  test('records missing evidence explicitly and never invents it', () => {
    const missing = extract();
    missing.metrics.forEach((m) => {
      m.current = null;
      m.previous = null;
      m.yoyPercent = null;
    });
    const d = buildEvidenceDataset(missing, id);
    expect(d.evidence).toEqual([]);
    expect(d.verifiedFacts).toEqual([]);
    const [f] = normalizeFindings(d, [
      {
        type: 'unverified',
        content: '尚无法判断经营状况。',
        evidence_ids: [],
        limitations: ['缺少可用年度指标。'],
      },
    ]);
    expect(f.type).toBe('unverified');
    expect(f.evidenceIds).toEqual([]);
    expect(f.limitations).toContain('当前数据集没有可关联的指标证据。');
  });
  test('code generates decline and comparable rate comparisons, omits incomparable rates', () => {
    const original = extract();
    original.metrics[0].current!.value = 80;
    const d = buildEvidenceDataset(original, id);
    expect(
      d.verifiedFacts.find((f) => f.id === `${id}:revenue:yoy`)?.content,
    ).toBe('营收较可比上期下降 20.00%。');
    expect(
      d.verifiedFacts.find(
        (f) => f.id === `${id}:revenue:netIncome:yoy_comparison`,
      )?.evidenceIds,
    ).toHaveLength(4);
    original.metrics[0].previous!.value = 0;
    const zero = buildEvidenceDataset(original, id);
    expect(zero.verifiedFacts.some((f) => f.id === `${id}:revenue:yoy`)).toBe(
      false,
    );
    expect(
      zero.verifiedFacts.some(
        (f) => f.id.includes('revenue:') && f.id.endsWith('yoy_comparison'),
      ),
    ).toBe(false);
    original.metrics[0].previous!.value = 100;
    original.metrics[0].previous!.unit = 'EUR';
    expect(
      buildEvidenceDataset(original, id).verifiedFacts.some(
        (f) => f.id === `${id}:revenue:yoy`,
      ),
    ).toBe(false);
  });
});

describe('Pi report persistence and read-only offline audit', () => {
  async function run() {
    // Global transport fails if the product silently attempts network/model access.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Unexpected network request');
      }),
    );
    const workspace = await temp();
    const request = async (url: string) => ({
      url,
      fetchedAt: '2025-04-01T00:00:00Z',
      body: url.includes('/companyfacts/')
        ? fixture()
        : {
            cik: '1',
            tickers: ['EXM'],
            filings: { recent: columns, files: [] },
          },
    });
    const tools = adaptClaudeMcpToolsToPi(createSecTools(workspace, request));
    const result = await tools[0].execute(
      'fetch',
      { company: '1' },
      undefined,
      undefined,
      {} as never,
    );
    const fetched = JSON.parse((result.content[0] as { text: string }).text);
    const target = path.join(
      workspace,
      'financial-research',
      fetched.datasetId,
    );
    const fact = fetched.verifiedFacts.find((f: { id: string }) =>
      f.id.endsWith(':revenue:yoy'),
    );
    const args = {
      dataset_id: fetched.datasetId,
      findings: [
        {
          type: 'direct_fact',
          fact_id: fact.id,
          evidence_ids: fact.evidenceIds,
          limitations: [],
        },
        {
          ...judgment(),
          evidence_ids: [`${fetched.datasetId}:netIncome:current`],
        },
      ],
    };
    return { workspace, tools, fetched, target, args };
  }
  test('saves and audits the report, evidence and classifications; retries preserve files', async () => {
    const { tools, target, args } = await run();
    await tools[1].execute('save', args, undefined, undefined, {} as never);
    const audit = await auditSecArtifacts(target);
    expect(audit).toMatchObject({
      schemaVersion: 2,
      recomputedMetricsMatch: true,
      evidenceAssociationsVerified: true,
      directFacts: 1,
      pendingJudgments: 1,
      qualitativeSemanticsVerified: false,
      filingBodyRead: false,
    });
    const before = await fs.readFile(path.join(target, 'report.md'), 'utf8');
    const files = await fs.readdir(target);
    await tools[1].execute('retry', args, undefined, undefined, {} as never);
    expect(await fs.readFile(path.join(target, 'report.md'), 'utf8')).toBe(
      before,
    );
    expect(await fs.readdir(target)).toEqual(files);
    await tools[1]
      .execute(
        'change',
        { ...args, findings: [args.findings[0]] },
        undefined,
        undefined,
        {} as never,
      )
      .then(
        () => {
          throw new Error('overwrote report');
        },
        (e) => expect(e.message).toContain('SEC_EXISTS'),
      );
    expect(await fs.readFile(path.join(target, 'report.md'), 'utf8')).toBe(
      before,
    );
    const findings = JSON.parse(
      await fs.readFile(path.join(target, 'findings.json'), 'utf8'),
    );
    expect(findings.findings[1].type).toBe('unverified');
    findings.findings[1].type = 'direct_fact';
    await fs.writeFile(
      path.join(target, 'findings.json'),
      JSON.stringify(findings),
    );
    await expect(auditSecArtifacts(target)).rejects.toThrow(
      'finding classification',
    );
  });
  test('fails invalid references before writing, and creates distinct research directories', async () => {
    const { tools, args, target } = await run();
    await expect(
      tools[1].execute(
        'bad',
        {
          ...args,
          findings: [
            { ...judgment(), evidence_ids: [`${id}:netIncome:current`] },
          ],
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow('SEC_EVIDENCE');
    expect(await fs.readdir(target)).toEqual(
      expect.arrayContaining(['raw.json', 'metrics.json', 'manifest.json']),
    );
    expect(await fs.readdir(target)).not.toContain('report.md');
    const second = await tools[0].execute(
      'fetch-again',
      { company: '1' },
      undefined,
      undefined,
      {} as never,
    );
    expect(
      JSON.parse((second.content[0] as { text: string }).text).datasetId,
    ).not.toBe(args.dataset_id);
  });
  test('audits a committed legacy fixture read-only and refuses upgrading historical artifacts', async () => {
    const legacy = path.resolve('tests/fixtures/sec-legacy-v1');
    const before = await Promise.all(
      (await fs.readdir(legacy)).map(async (f) => [
        f,
        await fs.readFile(path.join(legacy, f), 'utf8'),
      ]),
    );
    expect(await auditSecArtifacts(legacy)).toMatchObject({
      schemaVersion: 1,
      recomputedMetricsMatch: true,
      evidenceAssociationsVerified: false,
      legacyQualitativeFindingsUnaudited: true,
      qualitativeSemanticsVerified: false,
    });
    expect(
      await Promise.all(
        (await fs.readdir(legacy)).map(async (f) => [
          f,
          await fs.readFile(path.join(legacy, f), 'utf8'),
        ]),
      ),
    ).toEqual(before);
    const { target, tools, args } = await run();
    for (const f of ['raw.json', 'metrics.json', 'manifest.json', 'report.md'])
      await fs.copyFile(path.join(legacy, f), path.join(target, f));
    await expect(
      tools[1].execute('legacy-save', args, undefined, undefined, {} as never),
    ).rejects.toThrow('SEC_VERSION');
  });
});
