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

// jsdom does not implement ResizeObserver, which the shell's map-area mount uses
// to notify the render layer of size changes (FR-114). Provide a minimal no-op
// stub so component trees that mount the map area render under jsdom. Guarded so
// it never overrides a real implementation. The size-notification LOGIC itself
// is unit-tested without the DOM (map-resize.test.ts), so the stub only needs to
// exist, not to fire (教訓 5.41).
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

// jsdom does not implement PointerEvent. The draggable-panel operation tests
// (教訓 5.8) fire pointerdown/move/up with clientX/clientY; without a real
// PointerEvent those coordinates are dropped. Alias PointerEvent to MouseEvent
// (which carries clientX/clientY) so the press→move→release sequence is
// exercised with real coordinates. The drag MATH is also unit-tested DOM-free
// (drag.test.ts), so this only enables the component-level wiring test.
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = globalThis.MouseEvent;
}

// jsdom does not implement HTMLCanvasElement.getContext and, worse, its default
// throws AND logs a noisy "Not implemented" error to the virtual console for
// every call. Components that mount a Canvas for an IMPERATIVE paint (e.g. the
// minimap preview) probe getContext and bail when no 2D context exists — that
// "no context ⇒ no-op" path is the behaviour to exercise under jsdom. Stub
// getContext to return null so the probe takes the bail path cleanly, without the
// console noise. The actual draw-command BUILD is unit-tested DOM-free against the
// render layer's primitive列 (教訓 5.41), so the stub only needs to report "no 2D".
if (typeof globalThis.HTMLCanvasElement !== 'undefined') {
  const proto = globalThis.HTMLCanvasElement.prototype as {
    getContext?: (contextId: string) => unknown;
  };
  // Only replace the default (throwing) implementation; never clobber a real
  // context stub a test/unit may have installed (guarded probe, like the others).
  let throws = false;
  try {
    proto.getContext?.('2d');
  } catch {
    throws = true;
  }
  if (throws) {
    proto.getContext = (): null => null;
  }
}

afterEach(() => {
  cleanup();
});
