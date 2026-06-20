import { describe, expect, it, vi } from 'vitest';

import {
  GUARD_ACTION,
  UNSAVED_CHOICE,
  decideAfterSave,
  decideUnsavedGuard,
  runUnsavedGuard,
  type UnsavedGuardPorts,
} from './unsaved-guard';

describe('decideUnsavedGuard (FR-107 pure branch, 受け入れ基準 7)', () => {
  it('not dirty → Proceed without consulting the choice (受け入れ基準 2 末項)', () => {
    expect(decideUnsavedGuard(false)).toBe(GUARD_ACTION.Proceed);
    expect(decideUnsavedGuard(false, UNSAVED_CHOICE.Cancel)).toBe(GUARD_ACTION.Proceed);
  });

  it('dirty + no choice yet → Abort (safe placeholder until the dialog answers)', () => {
    expect(decideUnsavedGuard(true)).toBe(GUARD_ACTION.Abort);
  });

  it('dirty + キャンセル → Abort (keep current state)', () => {
    expect(decideUnsavedGuard(true, UNSAVED_CHOICE.Cancel)).toBe(GUARD_ACTION.Abort);
  });

  it('dirty + 保存せず続行 → Proceed (discard)', () => {
    expect(decideUnsavedGuard(true, UNSAVED_CHOICE.Discard)).toBe(GUARD_ACTION.Proceed);
  });

  it('dirty + 保存 → SaveThenDecide', () => {
    expect(decideUnsavedGuard(true, UNSAVED_CHOICE.Save)).toBe(GUARD_ACTION.SaveThenDecide);
  });
});

describe('decideAfterSave (保存成功時のみ続行, 注意点「保存失敗時の保護」)', () => {
  it('save succeeded → Proceed', () => {
    expect(decideAfterSave(true)).toBe(GUARD_ACTION.Proceed);
  });
  it('save failed / cancelled → Abort (protect unsaved data)', () => {
    expect(decideAfterSave(false)).toBe(GUARD_ACTION.Abort);
  });
});

function ports(over: Partial<UnsavedGuardPorts>): UnsavedGuardPorts {
  return {
    isDirty: () => true,
    promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Cancel),
    save: () => Promise.resolve(true),
    ...over,
  };
}

describe('runUnsavedGuard (the single async runner — 教訓 5.6 全経路同一ガード)', () => {
  it('not dirty → proceeds without showing a dialog', async () => {
    const promptUnsaved = vi.fn(() => Promise.resolve(UNSAVED_CHOICE.Cancel));
    const ok = await runUnsavedGuard(ports({ isDirty: () => false, promptUnsaved }));
    expect(ok).toBe(true);
    expect(promptUnsaved).not.toHaveBeenCalled();
  });

  it('dirty + キャンセル → aborts, never saves', async () => {
    const save = vi.fn(() => Promise.resolve(true));
    const ok = await runUnsavedGuard(
      ports({ promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Cancel), save }),
    );
    expect(ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('dirty + 保存せず続行 → proceeds without saving', async () => {
    const save = vi.fn(() => Promise.resolve(true));
    const ok = await runUnsavedGuard(
      ports({ promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Discard), save }),
    );
    expect(ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('dirty + 保存 + save success → proceeds', async () => {
    const ok = await runUnsavedGuard(
      ports({ promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Save), save: () => Promise.resolve(true) }),
    );
    expect(ok).toBe(true);
  });

  it('dirty + 保存 + save failure → aborts (unsaved data protected)', async () => {
    const ok = await runUnsavedGuard(
      ports({ promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Save), save: () => Promise.resolve(false) }),
    );
    expect(ok).toBe(false);
  });
});
