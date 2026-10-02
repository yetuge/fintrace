import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createSecFetch,
  type RawResponse,
  type SecFetch,
} from '../financial/sec-client.js';
import type { Task } from './types.js';
import type { SecDataContext } from '../financial/sec-data-context.js';

export const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export async function taskInput(
  task: Task,
  fixtures: string,
): Promise<{
  request: SecFetch;
  inputSha256: string;
  clock?: { fetchedAt?: string; asOf?: string; dataContext: SecDataContext };
}> {
  if (task.mode === 'live_sec') {
    if (task.snapshot || task.injection)
      throw new Error('BENCHMARK_MODE_CONFLICT');
    const inputSha256 = hash(
      JSON.stringify({
        mode: task.mode,
        company: task.company,
        asOf: task.asOf,
      }),
    );
    return {
      request: createSecFetch(),
      inputSha256,
      clock: {
        dataContext: {
          mode: task.mode,
          inputVersion: 'live-sec-v1',
          inputSha256,
          source: task.source,
        },
      },
    };
  }
  if (task.injection === 'sec_429' && task.mode === 'injected_failure')
    return {
      request: async () => {
        throw new Error(
          'SEC_HTTP_429: 明确注入的 SEC 限流；未联网，未返回成功数据',
        );
      },
      inputSha256: hash('fintrace-sec-429-v1'),
    };
  if (!task.snapshot || path.basename(task.snapshot) !== task.snapshot)
    throw new Error('BENCHMARK_SNAPSHOT_REQUIRED');
  const bytes = await fs.readFile(path.join(fixtures, task.snapshot));
  const snapshot = JSON.parse(bytes.toString()) as {
    asOf: string;
    responses: RawResponse[];
  };
  if (
    snapshot.asOf !== task.asOf ||
    (task.mode === 'snapshot' && task.injection)
  )
    throw new Error('BENCHMARK_MODE_CONFLICT');
  const responses = structuredClone(snapshot.responses);
  const facts = responses.find((r) => r.url.includes('/companyfacts/'))
    ?.body as any;
  const gaap = facts?.facts?.['us-gaap'];
  if (!gaap) throw new Error('BENCHMARK_BAD_SNAPSHOT');
  if (task.injection === 'remove_cash_tag')
    delete gaap.CashAndCashEquivalentsAtCarryingValue;
  if (task.injection === 'prior_revenue_eur') {
    const tag = gaap.RevenueFromContractWithCustomerExcludingAssessedTax;
    tag.units.EUR = tag.units.USD.filter((v: any) => v.end === '2025-06-30');
    tag.units.USD = tag.units.USD.filter((v: any) => v.end !== '2025-06-30');
  }
  const inputSha256 = hash(
    Buffer.concat([
      bytes,
      Buffer.from(
        JSON.stringify({ injection: task.injection ?? null, asOf: task.asOf }),
      ),
    ]),
  );
  return {
    inputSha256,
    clock: {
      fetchedAt: responses.at(-1)!.fetchedAt,
      asOf: task.asOf,
      dataContext: {
        mode: task.mode,
        inputVersion: task.snapshot,
        inputSha256,
        source: task.source,
        ...(task.injection ? { injection: task.injection } : {}),
      },
    },
    request: async (url, signal) => {
      signal?.throwIfAborted();
      const response = responses.find((r) => r.url === url);
      if (!response)
        throw new Error('BENCHMARK_SNAPSHOT_URL_MISSING: 禁止静默联网');
      return structuredClone(response);
    },
  };
}
