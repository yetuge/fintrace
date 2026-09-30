import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const cli of ['typescript/bin/tsc', 'vite/bin/vite.js']) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL(`../node_modules/${cli}`, import.meta.url)),
      ...(cli.startsWith('vite') ? ['build'] : []),
    ],
    {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, VITE_SHOWCASE_ONLY: 'true' },
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
