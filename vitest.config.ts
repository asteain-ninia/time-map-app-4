import { defineConfig } from 'vitest/config';

// Domain tests run in plain Node: no Electron runtime, no jsdom, no React.
export default defineConfig({
  test: {
    environment: 'node',
    // Domain tests + the framework-free UI/session state store tests (U16). The
    // store is built on `zustand/vanilla` and needs no DOM, so it runs in the
    // same Node environment without jsdom (技術方針 2.5).
    include: ['src/domain/**/*.test.ts', 'src/ui/state/**/*.test.ts'],
    // Pin the fast-check seed once for the whole suite so property tests are
    // reproducible (no flaky green/red across runs); see src/test-setup.ts.
    setupFiles: ['src/test-setup.ts'],
  },
});
