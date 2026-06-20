// U42 — verification lens over the 終了確認ガード boundary (FR-107 / 教訓 5.41).
//
// The unsaved-changes guard opens an OS-style modal, which is hard to drive
// deterministically through Playwright. Per 教訓 5.41 it is double-fixed here as a
// PURE unit lens stating the SAME expectation the E2E asserts (未保存→警告→3択),
// re-using the production decision function (no logic re-implementation) so an
// E2E failure can be triaged to (UI wiring) vs (guard logic). This lives in the
// ui layer because it imports the ui-layer guard (domain must not import ui).

import { describe, it, expect } from 'vitest';

import { decideUnsavedGuard, GUARD_ACTION, UNSAVED_CHOICE } from './unsaved-guard';

describe('終了確認ガード 純粋判定 (FR-107, U42 verification lens)', () => {
  it('clean project never warns → Proceed directly (E2E: no dialog appears)', () => {
    expect(decideUnsavedGuard(false)).toBe(GUARD_ACTION.Proceed);
  });

  it('dirty + キャンセル → Abort (E2E: destructive op is cancelled, state kept)', () => {
    expect(decideUnsavedGuard(true, UNSAVED_CHOICE.Cancel)).toBe(GUARD_ACTION.Abort);
  });

  it('dirty + 保存せず続行 → Proceed (E2E: changes discarded, op runs)', () => {
    expect(decideUnsavedGuard(true, UNSAVED_CHOICE.Discard)).toBe(GUARD_ACTION.Proceed);
  });

  it('dirty + 保存 → SaveThenDecide (E2E: save runs, then op proceeds on success)', () => {
    expect(decideUnsavedGuard(true, UNSAVED_CHOICE.Save)).toBe(GUARD_ACTION.SaveThenDecide);
  });
});
