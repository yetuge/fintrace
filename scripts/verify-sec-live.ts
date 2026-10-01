/** Explicit opt-in SEC network verification. No model calls or provider config access. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSecTools } from '../container/agent-runner/src/financial/sec-tools.js';

const workspace = path.resolve(process.argv[2] || 'data/sec-verification');
await fs.mkdir(workspace, { recursive: true });
const tools = createSecTools(workspace);
const results = [];
for (const company of ['AAPL', 'Microsoft']) {
  const started = Date.now();
  try {
    const response = await tools[0].handler({ company }, {});
    const dataset = JSON.parse((response.content[0] as { text: string }).text);
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
