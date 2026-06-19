// DOM test setup for React component (`*.test.tsx`) operation tests.
//
// Registers `@testing-library/jest-dom` custom matchers (toBeInTheDocument,
// toHaveValue, ...) and unmounts every rendered tree after each test so that one
// component test cannot leak DOM into the next (受け入れ基準8 の操作テストを
// 独立・再現可能に保つ). This file is a vitest setupFile alongside the fast-check
// seed setup; it is a no-op for node-environment tests because they never render
// React, and importing the matchers there is harmless.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
