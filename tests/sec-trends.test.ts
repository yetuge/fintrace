import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { extractAnnualTrends } from '../container/agent-runner/src/financial/sec-trends.js';
import {
  buildTrendChartData,
  renderTrendSvg,
} from '../container/agent-runner/src/financial/sec-trend-report.js';
import {
  metricDefinitions,
  filingsFromColumns,
  type CompanyFacts,
} from '../container/agent-runner/src/financial/sec-metrics.js';
import { normalizeFindings } from '../container/agent-runner/src/financial/sec-evidence.js';
import { createSecTools } from '../container/agent-runner/src/financial/sec-tools.js';
import { auditSecArtifacts } from '../container/agent-runner/src/financial/sec-audit.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

const id = '0000000001-11111111-1111-1111-1111-111111111111';
function fixture(
  ends = ['2022-12-31', '2023-12-31', '2024-12-31'],
  starts = ['2022-01-01', '2023-01-01', '2024-01-01'],
) {
  const columns = {
    accessionNumber: ends.map((_, i) => `0000000001-25-00000${i + 1}`),
    form: ends.map(() => '10-K'),
    filingDate: ends.map((e) => `${Number(e.slice(0, 4)) + 1}-02-01`),
    reportDate: ends,
    primaryDocument: ends.map(() => 'annual.htm'),
  };
  const filings = filingsFromColumns(columns, '0000000001');
  const facts: CompanyFacts = {
    cik: 1,
    entityName: 'Synthetic Trend Corp',
    facts: { 'us-gaap': {} },
  };
  metricDefinitions.forEach((m, n) => {
    facts.facts['us-gaap'][m.tags[0]] = {
      units: {
        USD: ends.map((end, i) => ({
          end,
          ...(m.duration ? { start: starts[i] } : {}),
          val: (i + 1) * 1000000 * (n + 1),
          accn: columns.accessionNumber[i],
          filed: columns.filingDate[i],
          form: '10-K',
          fy: 2099,
          fp: 'Q1',
        })),
      },
    };
  });
  return { facts, filings, columns };
}
const extract = (f = fixture(), asOf = '2025-04-01') =>
  extractAnnualTrends(
    f.facts,
    f.filings,
    ['SYN'],
    '2025-04-01T00:00:00Z',
    asOf,
    [],
    id,
  );
const revenue = (f: ReturnType<typeof fixture>) =>
  f.facts.facts['us-gaap'][metricDefinitions[0].tags[0]].units.USD;

test('uses actual complete periods and filing dates, not misleading fy/fp; oldest has no growth rate', () => {
  const d = extract();
  expect(d.years.map((y) => y.end)).toEqual([
    '2022-12-31',
    '2023-12-31',
    '2024-12-31',
  ]);
  expect(d.metrics[0].annual.map((p) => p.yoyPercent)).toEqual([null, 100, 50]);
  expect(d.evidence).toHaveLength(15);
  expect(
    d.verifiedFacts.find((f) => f.id === `${id}:revenue:chain`)?.evidenceIds,
  ).toHaveLength(3);
});
test('latest disclosed historical values, duplicate facts and amendments remain deterministic as of date', () => {
  const f = fixture();
  const rows = revenue(f);
  rows.push({
    ...rows[0],
    val: 1500000,
    accn: f.filings[2].accession,
    filed: f.filings[2].filed,
  });
  rows.push({ ...rows.at(-1)! });
  const amended = {
    ...f.filings[2],
    accession: '0000000001-25-000004',
    form: '10-K/A',
    filed: '2025-03-01',
  };
  f.filings.push(amended);
  rows.push({
    ...rows[0],
    val: 1600000,
    accn: amended.accession,
    filed: amended.filed,
    form: amended.form,
  });
  expect(extract(f).metrics[0].annual[0].value?.value).toBe(1600000);
  expect(extract(f).metrics[0].annual[0].value?.accession).toBe(
    amended.accession,
  );
  expect(extract(f, '2025-02-15').metrics[0].annual[0].value?.value).toBe(
    1500000,
  );
});
test('same latest disclosure conflicts are missing and cannot silently fall back', () => {
  const f = fixture();
  revenue(f).push({ ...revenue(f)[1], val: 17 });
  const d = extract(f);
  expect(d.metrics[0].annual[1].value).toBeNull();
  expect(d.verifiedFacts.some((v) => v.id === `${id}:revenue:chain`)).toBe(
    false,
  );
});
test('52/53 week periods remain complete and comparable with a seven day difference', () => {
  const f = fixture(
    ['2022-09-24', '2023-09-30', '2024-09-28'],
    ['2021-09-26', '2022-09-25', '2023-10-01'],
  );
  const d = extract(f);
  expect(d.years).toHaveLength(3);
  expect(d.metrics[0].annual[1].yoyPercent).toBe(100);
  expect(d.metrics[0].annual[2].yoyPercent).toBe(50);
});
test('quarters and short fiscal transition periods cannot masquerade as full years', () => {
  const f = fixture();
  metricDefinitions
    .filter((m) => m.duration)
    .forEach((m) => {
      f.facts.facts['us-gaap'][m.tags[0]].units.USD[1].start = '2023-10-01';
    });
  const d = extract(f);
  expect(d.years.map((y) => y.end)).toEqual(['2022-12-31', '2024-12-31']);
  expect(d.excludedPeriods[0].end).toBe('2023-12-31');
  expect(d.metrics[0].annual[1].yoyPercent).toBeNull();
  expect(d.verifiedFacts.some((v) => v.id.endsWith(':chain'))).toBe(false);
});
test('missing filing year never gives a continuous trend or growth across the gap', () => {
  const f = fixture(
    ['2021-12-31', '2023-12-31', '2024-12-31'],
    ['2021-01-01', '2023-01-01', '2024-01-01'],
  );
  const d = extract(f);
  expect(d.metrics[0].annual[1].yoyPercent).toBeNull();
  expect(d.verifiedFacts.some((v) => v.id.endsWith(':chain'))).toBe(false);
});
test('currency changes are retained, split into axes and excluded from cross-currency comparisons', () => {
  const f = fixture();
  const concept = f.facts.facts['us-gaap'][metricDefinitions[0].tags[0]];
  concept.units.EUR = [concept.units.USD.pop()!];
  const d = extract(f);
  expect(d.metrics[0].annual[2].value?.unit).toBe('EUR');
  expect(d.metrics[0].annual[2].yoyPercent).toBeNull();
  const panels = buildTrendChartData(d).panels.filter(
    (p) => p.key === 'revenue',
  );
  expect(panels.map((p) => p.currency)).toEqual(['USD', 'EUR']);
  expect(panels[1].points[2].connectPrevious).toBe(false);
});
test('multiple currencies in the latest same fact are a conflict; shares and USD-per-shares are not amounts', () => {
  const f = fixture();
  const c = f.facts.facts['us-gaap'][metricDefinitions[0].tags[0]];
  c.units.EUR = [{ ...c.units.USD[2] }];
  c.units.shares = [{ ...c.units.USD[0], val: 7 }];
  expect(extract(f).metrics[0].annual[2].value).toBeNull();
  delete c.units.EUR;
  c.units['USD-per-shares'] = [{ ...c.units.USD[0], val: 9 }];
  expect(extract(f).metrics[0].annual[0].value?.value).toBe(1000000);
});
test('tag changes keep actual values but prevent false comparable growth and chains', () => {
  const f = fixture();
  const old = revenue(f).splice(0, 2);
  f.facts.facts['us-gaap'].Revenues = { units: { USD: old } };
  const d = extract(f);
  expect(d.metrics[0].annual[0].value?.tag).toBe('us-gaap:Revenues');
  expect(d.metrics[0].annual[2].yoyPercent).toBeNull();
  expect(d.verifiedFacts.some((v) => v.id === `${id}:revenue:chain`)).toBe(
    false,
  );
});
test('negative profits keep signed chart values and direction; negative and zero growth bases are undefined', () => {
  const f = fixture();
  const p = f.facts.facts['us-gaap'].NetIncomeLoss.units.USD;
  p.forEach((r, i) => (r.val = [-3000000, -1000000, 0][i]));
  const d = extract(f);
  expect(d.metrics[1].annual.map((p) => p.yoyPercent)).toEqual([
    null,
    null,
    null,
  ]);
  expect(
    d.verifiedFacts.find((v) => v.id === `${id}:netIncome:chain`)?.content,
  ).toContain('连续增加');
  const chart = buildTrendChartData(d);
  const panel = chart.panels.find((p) => p.key === 'netIncome')!;
  expect(panel.scale).toBe(1e6);
  expect(panel.points.map((p) => p.scaledValue)).toEqual([-3, -1, 0]);
  expect(renderTrendSvg(chart)).toContain('-3.000');
});
test('flat and descending chains are code facts; incomplete, invalid or conflicting annual starts stop selection', () => {
  const f = fixture();
  revenue(f).forEach((r) => (r.val = 7));
  expect(
    extract(f).verifiedFacts.find((v) => v.id === `${id}:revenue:chain`)
      ?.content,
  ).toContain('连续持平');
  revenue(f).forEach((r, i) => (r.val = 3 - i));
  expect(
    extract(f).verifiedFacts.find((v) => v.id === `${id}:revenue:chain`)
      ?.content,
  ).toContain('连续减少');
  revenue(f)[2].start = '2024-01-02';
  expect(extract(f).years.map((y) => y.end)).toEqual([
    '2022-12-31',
    '2023-12-31',
  ]);
});
test('missing chart values preserve null with no interpolation; billion scale comes from values', () => {
  const f = fixture();
  revenue(f).splice(1, 1);
  revenue(f)[1].val = 3e9;
  const chart = buildTrendChartData(extract(f));
  const p = chart.panels[0];
  expect(p.scale).toBe(1e9);
  expect(p.unit).toBe('USD 十亿');
  expect(p.points.map((x) => x.scaledValue)).toEqual([0.001, null, 3]);
  expect(p.points[2].connectPrevious).toBe(false);
  expect(renderTrendSvg(chart)).toContain('缺失 / 币种不同');
});
test('direct trend facts must reference the complete current evidence chain; qualitative prose remains pending', () => {
  const d = extract();
  const fact = d.verifiedFacts.find((f) => f.id.endsWith(':chain'))!;
  const input = {
    type: 'direct_fact' as const,
    fact_id: fact.id,
    evidence_ids: fact.evidenceIds,
    limitations: [],
    content: '虚构的趋势',
  };
  expect(normalizeFindings(d, [input])[0].content).toBe(fact.content);
  expect(() =>
    normalizeFindings(d, [
      { ...input, evidence_ids: fact.evidenceIds.slice(1) },
    ]),
  ).toThrow('SEC_FACT');
  expect(() =>
    normalizeFindings(d, [{ ...input, evidence_ids: ['invented'] }]),
  ).toThrow('SEC_EVIDENCE');
  expect(
    normalizeFindings(d, [
      {
        type: 'interpretation',
        content: '盈利质量可能改善',
        evidence_ids: fact.evidenceIds,
        limitations: ['尚缺现金流构成和申报正文'],
      },
    ])[0].type,
  ).toBe('unverified');
});

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0))
    await fs.rm(d, { recursive: true, force: true });
});

test('no reliable full year returns an explicit empty dataset and no fabricated annual evidence', () => {
  const f = fixture();
  for (const m of metricDefinitions.filter((m) => m.duration)) {
    for (const row of f.facts.facts['us-gaap'][m.tags[0]].units.USD)
      row.start = row.end.slice(0, 4) + '-10-01';
  }
  const d = extract(f);
  expect(d.years).toHaveLength(0);
  expect(d.evidence).toHaveLength(0);
  expect(d.verifiedFacts).toHaveLength(0);
  expect(d.warnings.some((w) => w.includes('缺少 3 个'))).toBe(true);
});

test('zero profit base is undefined, while a positive-to-loss year has a signed growth rate', () => {
  const f = fixture();
  f.facts.facts['us-gaap'].NetIncomeLoss.units.USD.forEach(
    (r, i) => (r.val = [0, 1, -1][i]),
  );
  const points = extract(f).metrics[1].annual;
  expect(points[1].yoyPercent).toBeNull();
  expect(points[2].yoyPercent).toBe(-200);
});

test('three-year qualitative findings can reference all fifteen values without weakening single-year limits', () => {
  const d = extract();
  const input = {
    type: 'unverified' as const,
    content: '趋势的经营原因尚待核验',
    evidence_ids: d.evidence.map((e) => e.id),
    limitations: ['尚缺正文与指标构成'],
  };
  expect(normalizeFindings(d, [input])[0].evidenceIds).toHaveLength(15);
  expect(() =>
    normalizeFindings({ ...d, schemaVersion: 2 }, [input]),
  ).toThrow();
});

test('chart write failure reports the actual error and never returns a completed research', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'fintrace-chart-failure-'),
  );
  dirs.push(root);
  const f = fixture();
  const tools = createSecTools(root, async (url) => ({
    url,
    fetchedAt: '2025-04-01T00:00:00Z',
    body: url.includes('companyfacts')
      ? f.facts
      : { cik: 1, filings: { recent: f.columns } },
  }));
  const write = fs.writeFile;
  vi.spyOn(fs, 'writeFile').mockImplementation(
    async (file, contents, options) => {
      if (String(file).endsWith('trends.svg'))
        throw new Error('disk full during chart write');
      return write(file, contents, options);
    },
  );
  await expect(
    tools[0].handler({ company: 'CIK1', years: 3 }, {}),
  ).rejects.toThrow('disk full during chart write');
  const directory = (
    await fs.readdir(path.join(root, 'financial-research'))
  )[0];
  expect(
    await fs.readdir(path.join(root, 'financial-research', directory)),
  ).not.toContain('report.md');
});
test('Pi tools save immutable v3 artifacts, recompute raw offline and detect chart/report tampering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fintrace-trends-'));
  dirs.push(root);
  const f = fixture();
  const tools = createSecTools(root, async (url) => ({
    url,
    fetchedAt: '2025-04-01T00:00:00Z',
    body: url.includes('companyfacts')
      ? f.facts
      : { cik: 1, tickers: ['SYN'], filings: { recent: f.columns } },
  }));
  const pi = adaptClaudeMcpToolsToPi(tools);
  const result = await pi[0].execute('fetch', { company: 'CIK1', years: 3 });
  const data = JSON.parse((result.content[0] as { text: string }).text);
  const fact = data.verifiedFacts.find((f: { id: string }) =>
    f.id.endsWith(':chain'),
  );
  const input = {
    dataset_id: data.datasetId,
    findings: [
      {
        type: 'direct_fact',
        fact_id: fact.id,
        evidence_ids: fact.evidenceIds,
        limitations: [],
      },
    ],
  };
  const saved = await pi[1].execute('save', input);
  expect(saved.isError).not.toBe(true);
  await pi[1].execute('retry', input);
  const directory = path.join(root, data.directory);
  expect(await fs.readdir(directory)).toEqual(
    expect.arrayContaining([
      'raw.json',
      'metrics.json',
      'manifest.json',
      'findings.json',
      'report.md',
      'trends.svg',
      'chart-data.json',
    ]),
  );
  expect((await auditSecArtifacts(directory)).schemaVersion).toBe(3);
  const report = await fs.readFile(path.join(directory, 'report.md'), 'utf8');
  expect(report).toContain('1,000,000 USD');
  expect(report).toContain('latest_disclosed_as_of');
  await fs.writeFile(
    path.join(directory, 'report.md'),
    report.replace('1,000,000', '9,000,000'),
  );
  await expect(auditSecArtifacts(directory)).rejects.toThrow(
    'canonical three-year report',
  );
  await fs.writeFile(path.join(directory, 'report.md'), report);
  const chart = path.join(directory, 'chart-data.json');
  const text = await fs.readFile(chart, 'utf8');
  await fs.writeFile(chart, text.replace('1000000', '9000000'));
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
  );
  manifest.chartHashes['chart-data.json'] = createHash('sha256')
    .update(await fs.readFile(chart))
    .digest('hex');
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify(manifest),
  );
  await expect(auditSecArtifacts(directory)).rejects.toThrow('recomputed data');
  await expect(tools[1].handler(input, {})).rejects.toThrow('SEC_CHART');
});
