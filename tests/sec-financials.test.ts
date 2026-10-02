import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  extractFinancials,
  filingsFromColumns,
  calculateYoy,
  type CompanyFacts,
  type Fact,
  type SelectedValue,
} from '../container/agent-runner/src/financial/sec-metrics.js';
import {
  createSecFetch,
  fetchCompany,
  normalizeCik,
  resolveCompany,
} from '../container/agent-runner/src/financial/sec-client.js';
import { createSecTools } from '../container/agent-runner/src/financial/sec-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

import { columns, filings, fixture, fact } from './fixtures/sec-synthetic.js';
const extract = (facts = fixture(), asOf = '2025-04-01') =>
  extractFinancials(facts, filings, ['EXM'], '2025-04-01T00:00:00Z', asOf, [
    'https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json',
  ]);
const temporary: string[] = [];
async function temp() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fintrace-sec-'));
  temporary.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('SEC deterministic financial extraction', () => {
  test('uses actual periods and latest comparative disclosure, not fy or fp', () => {
    const data = fixture();
    data.facts[
      'us-gaap'
    ].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD.push(
      fact(999, '2024-12-31', '2024-10-01'),
    );
    const result = extract(data);
    expect(result.annualStart).toBe('2024-01-01');
    expect(result.metrics[0].current?.value).toBe(120);
    expect(result.metrics[0].previous?.value).toBe(100);
    expect(result.metrics[0].yoyPercent).toBe(20);
    expect(result.metrics[3].current?.start).toBeUndefined();
    expect(result.metrics.every((m) => m.current)).toBe(true);
  });
  test('preserves base units, excludes per-share units, rejects ambiguous currencies', () => {
    const data = fixture();
    const units =
      data.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax
        .units;
    units['USD/shares'] = [fact(999)];
    expect(extract(data).metrics[0].current?.value).toBe(120);
    // With no currency established by any duration metric, mixed currencies are ambiguous.
    units.EUR = [fact(130)];
    delete data.facts['us-gaap'].NetIncomeLoss;
    delete data.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities;
    expect(extract(data).metrics[0].missingReason).toContain('多币种');
    expect(extract(data).metrics[0].current).toBeNull();
  });
  test('ignores duplicate identical facts and applies only disclosed amendments', () => {
    const data = fixture();
    const rows =
      data.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax
        .units.USD;
    rows.push(
      { ...rows[0] },
      fact(125, '2024-12-31', '2024-01-01', columns.accessionNumber[2]),
    );
    expect(extract(data).metrics[0].current?.value).toBe(125);
    expect(extract(data).metrics[1].current?.accession).toBe(
      columns.accessionNumber[0],
    );
    expect(extract(data, '2025-02-28').metrics[0].current?.value).toBe(120);
  });
  test('conflicting latest facts become missing, never arbitrary values', () => {
    const data = fixture();
    data.facts['us-gaap'].Liabilities.units.USD.push({
      ...data.facts['us-gaap'].Liabilities.units.USD[0],
      val: 900,
    });
    expect(extract(data).metrics[4].current).toBeNull();
    expect(extract(data).metrics[4].missingReason).toContain('冲突');
  });
  test('latest annual missing a metric never silently takes an older annual value', () => {
    const data = fixture();
    data.facts['us-gaap'].NetIncomeLoss.units.USD = data.facts[
      'us-gaap'
    ].NetIncomeLoss.units.USD.filter((f) => f.end === '2023-12-31');
    expect(extract(data).metrics[1].current).toBeNull();
    expect(extract(data).metrics[1].yoyPercent).toBeNull();
  });
  test('rejects short transition years and mismatched flow periods', () => {
    const data = fixture();
    data.facts['us-gaap'].NetIncomeLoss.units.USD[0].start = '2024-02-01';
    expect(extract(data).metrics[1].current).toBeNull();
    data.facts[
      'us-gaap'
    ].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD[0].start =
      '2024-07-01';
    expect(extract(data).metrics[0].current).toBeNull();
  });
  test('rejects dates that would silently roll over or parse as invalid', () => {
    expect(
      filingsFromColumns(
        { ...columns, reportDate: ['2024-02-30'] },
        '0000000001',
      ),
    ).toEqual([]);
    const data = fixture();
    data.facts['us-gaap'].NetIncomeLoss.units.USD[0].start = '2024-13-01';
    expect(extract(data).metrics[1].current).toBeNull();
  });
  test('yoy handles zero, negative, mismatched units and normal 53-week years', () => {
    const current = extract().metrics[0].current!;
    const previous = extract().metrics[0].previous!;
    expect(calculateYoy(current, { ...previous, value: 0 }).percent).toBeNull();
    expect(
      calculateYoy(current, { ...previous, value: -100 }).percent,
    ).toBeNull();
    expect(
      calculateYoy(current, { ...previous, unit: 'EUR' }).percent,
    ).toBeNull();
    expect(
      calculateYoy(current, { ...previous, tag: 'other' }).percent,
    ).toBeNull();
    expect(
      calculateYoy({ ...current, start: '2023-12-26' }, previous).percent,
    ).toBe(20);
    expect(
      calculateYoy({ ...current, start: '2023-12-01' }, previous).percent,
    ).toBeNull();
  });
  test('does not guess IFRS/custom tags and rejects unsafe numeric magnitude', () => {
    expect(
      extract({
        ...fixture(),
        facts: { 'ifrs-full': fixture().facts['us-gaap'] },
      }).metrics.every((m) => m.current === null),
    ).toBe(true);
    const data = fixture();
    data.facts['us-gaap'].Liabilities.units.USD[0].val =
      Number.MAX_SAFE_INTEGER + 1;
    expect(extract(data).metrics[4].current).toBeNull();
  });
});

describe('SEC identity, requests and workspace tools', () => {
  test('resolves ticker/name/CIK and refuses ambiguous company names', () => {
    const tickers = {
      0: { cik_str: 1, title: 'Example Corp', ticker: 'EXM' },
      1: { cik_str: 2, title: 'Example Holdings', ticker: 'EXH' },
      2: { cik_str: 3, title: 'Microsoft Corp', ticker: 'MSFT' },
      3: { cik_str: 4, title: 'Smith Micro Software', ticker: 'SMSI' },
    };
    expect(normalizeCik('CIK 1')).toBe('0000000001');
    expect(normalizeCik('00000000000')).toBeNull();
    expect(resolveCompany('exm', tickers)).toBe('0000000001');
    expect(resolveCompany('Example Corp', tickers)).toBe('0000000001');
    expect(resolveCompany('Microsoft', tickers)).toBe('0000000003');
    expect(() => resolveCompany('Example', tickers)).toThrow('SEC_AMBIGUOUS');
  });
  test('http errors are explicit, contact is a header only, locks always release', async () => {
    const directory = await temp();
    const transport = vi.fn(
      async () => new Response('', { status: 403 }),
    ) as unknown as typeof fetch;
    const request = createSecFetch(
      directory,
      transport,
      async () => 'Test contact@example.invalid',
    );
    await expect(
      request('https://data.sec.gov/submissions/CIK0000000001.json'),
    ).rejects.toThrow('SEC_HTTP_403');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      (
        vi.mocked(transport).mock.calls[0][1]?.headers as Record<string, string>
      )['User-Agent'],
    ).toBe('Test contact@example.invalid');
    expect(await fs.readdir(directory)).not.toContain('request.lock');
    await expect(request('https://example.com/')).rejects.toThrow(
      'SEC_URL_INVALID',
    );
  });
  test('honors long Retry-After without retrying prematurely', async () => {
    const transport = vi.fn(
      async () =>
        new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
    ) as unknown as typeof fetch;
    await expect(
      createSecFetch(
        await temp(),
        transport,
        async () => 'Test contact@example.invalid',
      )('https://data.sec.gov/test'),
    ).rejects.toThrow('SEC_HTTP_429');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test('bounds network retries, supplies timeout signals and releases the lock', async () => {
    const directory = await temp();
    const transport = vi.fn(async () => {
      throw new Error('private upstream detail');
    }) as unknown as typeof fetch;
    const request = createSecFetch(
      directory,
      transport,
      async () => 'Test contact@example.invalid',
    );
    await expect(request('https://data.sec.gov/test')).rejects.toThrow(
      'SEC_NETWORK',
    );
    expect(transport).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(transport)
        .mock.calls.every(
          ([, options]) => options?.signal instanceof AbortSignal,
        ),
    ).toBe(true);
    expect(await fs.readdir(directory)).not.toContain('request.lock');
  }, 10000);
  test('refuses invalid JSON and cancels before making a request', async () => {
    const directory = await temp();
    const transport = vi.fn(
      async () => new Response('<html>unavailable</html>'),
    ) as unknown as typeof fetch;
    const request = createSecFetch(
      directory,
      transport,
      async () => 'Test contact@example.invalid',
    );
    await expect(request('https://data.sec.gov/test')).rejects.toThrow(
      'SEC_INVALID_JSON',
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      request('https://data.sec.gov/test', controller.signal),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(directory)).not.toContain('request.lock');
  });
  test('retrieves older submission history if recent lacks comparable annual filings', async () => {
    const requested: string[] = [];
    const request = async (url: string) => {
      requested.push(url);
      return {
        url,
        fetchedAt: '2025-04-01T00:00:00Z',
        body: url.includes('companyfacts')
          ? fixture()
          : url.includes('-submissions-')
            ? columns
            : {
                cik: '1',
                tickers: ['EXM'],
                filings: {
                  recent: {
                    ...columns,
                    accessionNumber: [columns.accessionNumber[0]],
                  },
                  files: [{ name: 'CIK0000000001-submissions-001.json' }],
                },
              },
      };
    };
    expect((await fetchCompany('1', request)).filings.length).toBe(4);
    expect(requested.some((url) => url.includes('-submissions-'))).toBe(true);
  });
  test('Pi tool execution saves raw/metrics and a cited report; refuses tampering and traversal', async () => {
    const workspace = await temp();
    const request = async (url: string) => ({
      url,
      fetchedAt: new Date().toISOString(),
      body: url.includes('companyfacts')
        ? fixture()
        : {
            cik: '1',
            tickers: ['EXM'],
            filings: { recent: columns, files: [] },
          },
    });
    const piTools = adaptClaudeMcpToolsToPi(createSecTools(workspace, request));
    const fetched = await piTools[0].execute(
      'fetch',
      { company: '1' },
      undefined,
      undefined,
      {} as never,
    );
    const dataset = JSON.parse(
      (fetched.content[0] as { text: string }).text,
    ) as import('../container/agent-runner/src/financial/sec-evidence.js').EvidenceDataset;
    const args = {
      dataset_id: dataset.datasetId,
      findings: [
        {
          type: 'direct_fact',
          fact_id: dataset.verifiedFacts.find((f) =>
            f.id.endsWith(':revenue:yoy'),
          )!.id,
          evidence_ids: dataset.verifiedFacts.find((f) =>
            f.id.endsWith(':revenue:yoy'),
          )!.evidenceIds,
          limitations: [],
        },
      ],
    };
    await piTools[1].execute('save', args, undefined, undefined, {} as never);
    const directory = path.join(
      workspace,
      'financial-research',
      dataset.datasetId,
    );
    const report = await fs.readFile(path.join(directory, 'report.md'), 'utf8');
    expect(report).toContain('120 USD');
    expect(report).toContain('20.00%');
    expect(report).toContain('https://www.sec.gov/Archives/');
    expect(() =>
      piTools[1].prepareArguments?.({ ...args, dataset_id: '../../escape' }),
    ).toThrow();
    expect(() =>
      piTools[1].prepareArguments?.({ ...args, findings: ['利润 999 USD'] }),
    ).toThrow();
    await fs.appendFile(path.join(directory, 'metrics.json'), ' ');
    await expect(
      piTools[1].execute('save-again', args, undefined, undefined, {} as never),
    ).rejects.toThrow('SEC_INTEGRITY');
  });
});
