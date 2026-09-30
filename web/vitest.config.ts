import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'web/src/utils/chat-route-preload.test.ts',
      'tests/frontend-agent-product-contract.test.ts',
      'tests/frontend-agent-capability-experience.test.ts',
      'tests/channel-accounts-frontend.test.ts',
    ],
  },
});
