import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { CompanyFacts, Filing } from './sec-metrics.js';
import { filingsFromColumns } from './sec-metrics.js';

export const secRuntimeDir =
  process.env.SEC_RUNTIME_DIR ||
  (existsSync('/workspace/sec')
    ? '/workspace/sec'
    : fileURLToPath(new URL('../../../../data/sec/', import.meta.url)));
export interface RawResponse {
  url: string;
  fetchedAt: string;
  body: unknown;
}
export type SecFetch = (
  url: string,
  signal?: AbortSignal,
) => Promise<RawResponse>;

async function userAgent(): Promise<string> {
  let value = process.env.SEC_USER_AGENT;
  if (!value) {
    try {
      value = (
        JSON.parse(
          await fs.readFile(path.join(secRuntimeDir, 'sec.json'), 'utf8'),
        ) as { userAgent?: string }
      ).userAgent;
    } catch {
      throw new Error(
        'SEC_CONTACT_REQUIRED: 请配置本地 data/sec/sec.json 的 userAgent 或 SEC_USER_AGENT，必须包含真实联系邮箱；不得编造。',
      );
    }
  }
  if (
    !value ||
    value.length > 250 ||
    /[\r\n]/.test(value) ||
    !/\S+\s+[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)
  ) {
    throw new Error(
      'SEC_CONTACT_INVALID: User-Agent 需要应用名称和真实联系邮箱',
    );
  }
  return value;
}

/** A shared filesystem lock serializes host and Docker runners, at <=2 requests/s. */
export function createSecFetch(
  runtimeDir = secRuntimeDir,
  transport: typeof fetch = fetch,
  loadUserAgent: () => Promise<string> = userAgent,
): SecFetch {
  return async (url, signal) => {
    const parsed = new URL(url);
    if (
      !['www.sec.gov', 'data.sec.gov'].includes(parsed.hostname) ||
      parsed.protocol !== 'https:'
    )
      throw new Error('SEC_URL_INVALID');
    const contact = await loadUserAgent();
    await fs.mkdir(runtimeDir, { recursive: true });
    const lock = path.join(runtimeDir, 'request.lock');
    const deadline = Date.now() + 125000;
    while (true) {
      signal?.throwIfAborted();
      try {
        await fs.mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Remove only the empty, fixed-path lock left by a crashed runner.
        try {
          if (Date.now() - (await fs.stat(lock)).mtimeMs > 120000)
            await fs.rmdir(lock);
        } catch (failure) {
          if (
            !['ENOENT', 'ENOTEMPTY'].includes(
              (failure as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw failure;
        }
        if (Date.now() > deadline)
          throw new Error('SEC_BUSY: 访问队列超时，请稍后重试');
        await delay(100, undefined, { signal });
      }
    }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        let next = 0;
        try {
          next = Number(
            await fs.readFile(path.join(runtimeDir, 'next-request'), 'utf8'),
          );
        } catch {
          /* first request */
        }
        await delay(Math.max(0, next - Date.now()), undefined, { signal });
        await fs.writeFile(
          path.join(runtimeDir, 'next-request'),
          String(Date.now() + 500),
        );
        let response: Response;
        try {
          response = await transport(url, {
            headers: { 'User-Agent': contact, Accept: 'application/json' },
            redirect: 'error',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
              : AbortSignal.timeout(20000),
          });
        } catch {
          signal?.throwIfAborted();
          if (attempt < 2) {
            await delay(1000 * 2 ** attempt, undefined, { signal });
            continue;
          }
          throw new Error(
            `SEC_NETWORK: 官方请求超时或网络不可达 (${parsed.hostname})，未使用模拟数据`,
          );
        }
        if (response.status === 403) {
          await response.body?.cancel();
          throw new Error(
            'SEC_HTTP_403: SEC 拒绝访问，请检查声明的联系信息、网络和访问策略；未切换数据源',
          );
        }
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          if (attempt < 2) {
            const retryAfter = response.headers.get('retry-after');
            const seconds =
              retryAfter && /^\d+$/.test(retryAfter)
                ? Number(retryAfter)
                : retryAfter
                  ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
                  : 2 ** (attempt + 1);
            if (!Number.isFinite(seconds) || seconds > 20)
              throw new Error(
                `SEC_HTTP_${response.status}: SEC 要求稍后重试，未切换数据源`,
              );
            await delay(Math.max(1000, seconds * 1000), undefined, { signal });
            continue;
          }
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `SEC_HTTP_${response.status}: 官方接口请求失败，未使用模拟数据`,
          );
        }
        try {
          return {
            url,
            fetchedAt: new Date().toISOString(),
            body: await response.json(),
          };
        } catch {
          throw new Error('SEC_INVALID_JSON: 官方响应不是有效 JSON');
        }
      }
      throw new Error('SEC_RETRY_EXHAUSTED');
    } finally {
      await fs.rmdir(lock);
    }
  };
}

export function normalizeCik(input: string): string | null {
  const match = /^(?:CIK\s*)?(\d{1,10})$/i.exec(input.trim());
  return match && Number(match[1]) > 0 ? match[1].padStart(10, '0') : null;
}
export function resolveCompany(input: string, tickerBody: unknown): string {
  const cik = normalizeCik(input);
  if (cik) return cik;
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const query = normalize(input);
  if (!query)
    throw new Error(
      'SEC_IDENTIFIER_INVALID: 请输入英文公司名称、股票代码或 CIK',
    );
  const rows = Object.values(
    tickerBody as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >,
  ).filter(
    (r) =>
      typeof r?.title === 'string' &&
      typeof r?.ticker === 'string' &&
      Number.isInteger(r?.cik_str),
  );
  const exactTicker = rows.filter(
    (r) => r.ticker.toUpperCase() === input.trim().toUpperCase(),
  );
  const exactName = rows.filter((r) => normalize(r.title) === query);
  const matches = exactTicker.length
    ? exactTicker
    : exactName.length
      ? exactName
      : rows.filter((r) => ` ${normalize(r.title)} `.includes(` ${query} `));
  const unique = [...new Map(matches.map((r) => [r.cik_str, r])).values()];
  if (unique.length !== 1)
    throw new Error(
      unique.length
        ? `SEC_AMBIGUOUS: 请指定股票代码或 CIK：${unique
            .slice(0, 8)
            .map((r) => `${r.title} (${r.ticker}, CIK ${r.cik_str})`)
            .join('; ')}`
        : 'SEC_NOT_FOUND: 官方股票代码表未匹配公司，请提供 CIK',
    );
  return String(unique[0].cik_str).padStart(10, '0');
}
export async function fetchCompany(
  input: string,
  request: SecFetch,
  signal?: AbortSignal,
  annualYears = 2,
): Promise<{
  raw: RawResponse[];
  facts: CompanyFacts;
  filings: Filing[];
  tickers: string[];
  cik: string;
}> {
  const raw: RawResponse[] = [];
  let cik = normalizeCik(input);
  if (!cik) {
    const tickerResponse = await request(
      'https://www.sec.gov/files/company_tickers.json',
      signal,
    );
    raw.push(tickerResponse);
    cik = resolveCompany(input, tickerResponse.body);
  }
  const submission = await request(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
    signal,
  );
  raw.push(submission);
  const body = submission.body as {
    cik: string;
    tickers?: string[];
    filings?: { recent?: Record<string, unknown>; files?: { name: string }[] };
  };
  if (normalizeCik(String(body.cik)) !== cik || !body.filings?.recent)
    throw new Error('SEC_SCHEMA: Submissions 公司标识或结构不匹配');
  let filings = filingsFromColumns(body.filings.recent, cik);
  // recent contains >=1 year or 1000 filings; very active filers may need history.
  for (const file of (body.filings.files ?? []).slice(0, 8)) {
    if (new Set(filings.map((f) => f.end)).size >= annualYears) break;
    if (!/^CIK\d{10}-submissions-\d+\.json$/.test(file.name))
      throw new Error('SEC_SCHEMA: 无效历史申报文件名');
    const history = await request(
      `https://data.sec.gov/submissions/${file.name}`,
      signal,
    );
    raw.push(history);
    filings = [
      ...filings,
      ...filingsFromColumns(history.body as Record<string, unknown>, cik),
    ];
  }
  const companyFacts = await request(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    signal,
  );
  raw.push(companyFacts);
  const facts = companyFacts.body as CompanyFacts;
  if (
    normalizeCik(String(facts.cik)) !== cik ||
    typeof facts.entityName !== 'string' ||
    !facts.facts
  )
    throw new Error('SEC_SCHEMA: Company Facts 公司标识或结构不匹配');
  return { raw, facts, filings, tickers: body.tickers ?? [], cik };
}
