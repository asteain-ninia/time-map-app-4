import { defineConfig } from 'vitest/config';

// Domain tests run in plain Node: no Electron runtime, no jsdom, no React.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/domain/**/*.test.ts'],
    // Pin the fast-check seed once for the whole suite so property tests are
    // reproducible (no flaky green/red across runs); see src/test-setup.ts.
    setupFiles: ['src/test-setup.ts'],
  },
});
