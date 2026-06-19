import { defineConfig } from 'vitest/config';

// Domain tests run in plain Node: no Electron runtime, no jsdom, no React.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/domain/**/*.test.ts'],
  },
});
