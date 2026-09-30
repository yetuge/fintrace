import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'web/src/features/research/case.test.ts',
      'web/src/utils/chat-route-preload.test.ts',
    ],
  },
});
