/** Explicit opt-in SEC network verification. No model calls or provider config access. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSecTools } from '../container/agent-runner/src/financial/sec-tools.js';
import { auditSecArtifacts } from '../container/agent-runner/src/financial/sec-audit.js';

const trends = process.argv.includes('--years=3');
const workspace = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith('--')) ||
    'data/sec-verification',
);
await fs.mkdir(workspace, { recursive: true });
const tools = createSecTools(workspace);
const results = [];
for (const company of ['AAPL', 'Microsoft']) {
  const started = Date.now();
  try {
    const response = await tools[0].handler(
      { company, ...(trends ? { years: 3 } : {}) },
      {},
    );
    const dataset = JSON.parse((response.content[0] as { text: string }).text);
    if (trends) {
      const facts = dataset.verifiedFacts
        .filter((f: { id: string }) => f.id.endsWith(':chain'))
        .slice(0, 5);
      if (!facts.length) facts.push(...dataset.verifiedFacts.slice(0, 1));
      await tools[1].handler(
        {
          dataset_id: dataset.datasetId,
          findings: facts.length
            ? facts.map((f: { id: string; evidenceIds: string[] }) => ({
                type: 'direct_fact',
                fact_id: f.id,
                evidence_ids: f.evidenceIds,
                limitations: [],
              }))
            : [
                {
                  type: 'unverified',
                  content: '完整年度数据不足，无法形成可靠趋势',
                  evidence_ids: [],
                  limitations: ['尚缺完整年度申报及标准指标'],
                },
              ],
        },
        {},
      );
      const audit = await auditSecArtifacts(
        path.join(workspace, dataset.directory),
      );
      const complete =
        dataset.years.length === 3 &&
        dataset.metrics.every((m: { annual: { value: unknown }[] }) =>
          m.annual.every((p) => p.value),
        );
      const summary = {
        company: dataset.company,
        annualEnds: dataset.years.map((y: { end: string }) => y.end),
        complete,
        directory: dataset.directory,
        elapsedMs: Date.now() - started,
        audit,
      };
      results.push(summary);
      process.stdout.write(JSON.stringify(summary) + '\n');
      if (!complete) process.exitCode = 1;
      continue;
    }
    const complete = dataset.metrics.every((metric: { current: unknown }) =>
      Boolean(metric.current),
    );
    results.push({
      company: dataset.company,
      annualEnd: dataset.latestAnnual.end,
      annualStart: dataset.annualStart,
      metrics: dataset.metrics,
      complete,
      datasetId: dataset.datasetId,
      directory: dataset.directory,
      fetchedAt: dataset.fetchedAt,
      elapsedMs: Date.now() - started,
    });
    process.stdout.write(
      JSON.stringify({
        company: dataset.company,
        annualEnd: dataset.latestAnnual.end,
        complete,
        directory: dataset.directory,
        elapsedMs: Date.now() - started,
      }) + '\n',
    );
    if (!complete) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${company}: ${error instanceof Error ? error.message : 'SEC verification failed'}\n`,
    );
    process.exitCode = 1;
    break;
  }
}
await fs.writeFile(
  path.join(workspace, `verification-${Date.now()}.json`),
  JSON.stringify(results, null, 2) + '\n',
  { flag: 'wx' },
);
