/** Read-only: does not overwrite historical reports or verification records. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { auditSecArtifacts } from '../container/agent-runner/src/financial/sec-audit.js';
const directory = path.resolve(process.argv[2] ?? '');
if (!process.argv[2])
  throw new Error(
    'Usage: npx tsx scripts/verify-sec-artifacts.ts <research-directory> [Pi-session-directory]',
  );
const audit = await auditSecArtifacts(directory);
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
  ...audit,
  modelEvidence,
};
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
