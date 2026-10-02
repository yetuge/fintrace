import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: [
      'web/src/utils/chat-route-preload.test.ts',
      'web/src/components/chat/MarkdownRenderer.test.tsx',
      'tests/frontend-agent-product-contract.test.ts',
      'tests/frontend-agent-capability-experience.test.ts',
      'tests/channel-accounts-frontend.test.ts',
    ],
  },
});
