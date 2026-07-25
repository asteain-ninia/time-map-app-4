// U20 / shell — 表示 → 全体表示 (view.fitAll) の導線契約.
//
// 「全地物が収まる全体表示へ一発で戻る」コマンドを、メニュー・キーマップ・
// ショートカット一覧の SINGLE SOURCE (STANDARD_MENUS) 経由で結線する契約を固定する。
// アクセラレータは既存 keymap 規約に従い、既存のどの chord とも衝突してはならない。

import { describe, expect, it } from 'vitest';

import { COMMAND_ID, CommandRegistry } from './commands';
import { buildDefaultKeymap } from './default-keymap';
import { listShortcutEntries, MENU_KEY, STANDARD_MENUS } from './menu';
import { isEditingCommand } from './permissions';
import { chordOf } from './shortcuts';

describe('view.fitAll (全体表示) の導線', () => {
  it('sits in the 表示 menu', () => {
    const view = STANDARD_MENUS.find((m) => m.key === MENU_KEY.View);
    expect(view).toBeDefined();
    expect(view!.items.map((i) => i.commandId)).toContain(COMMAND_ID.ViewFitAll);
  });

  it('declares an accelerator that collides with NO other binding', () => {
    const view = STANDARD_MENUS.find((m) => m.key === MENU_KEY.View)!;
    const item = view.items.find((i) => i.commandId === COMMAND_ID.ViewFitAll)!;
    expect(item.shortcut).toBeDefined();

    // Every chord declared anywhere in the menu tree must be unique.
    const chords = STANDARD_MENUS.flatMap((m) =>
      m.items.flatMap((i) =>
        i.shortcut === undefined
          ? []
          : [chordOf(i.shortcut), ...(i.extraShortcuts ?? []).map(chordOf)],
      ),
    );
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('is dispatchable from the derived keymap once registered', () => {
    const keymap = buildDefaultKeymap();
    const view = STANDARD_MENUS.find((m) => m.key === MENU_KEY.View)!;
    const shortcut = view.items.find((i) => i.commandId === COMMAND_ID.ViewFitAll)!.shortcut!;
    const resolved = keymap.resolve({
      key: shortcut.key,
      ctrlOrMeta: shortcut.ctrlOrMeta === true,
      shift: shortcut.shift === true,
      alt: shortcut.alt === true,
    });
    expect(resolved).toBe(COMMAND_ID.ViewFitAll);

    // 未登録 == 無効 (commands.ts の規約) — 登録して初めて走る.
    const registry = new CommandRegistry();
    expect(registry.dispatch(COMMAND_ID.ViewFitAll)).toBe(false);
    let ran = 0;
    registry.register(COMMAND_ID.ViewFitAll, { run: () => { ran += 1; } });
    expect(registry.dispatch(COMMAND_ID.ViewFitAll)).toBe(true);
    expect(ran).toBe(1);
  });

  it('appears in the ショートカット一覧 (HB-9) rows', () => {
    const rows = listShortcutEntries();
    expect(rows.map((r) => r.commandId)).toContain(COMMAND_ID.ViewFitAll);
  });

  it('is a VIEW-axis command: stays enabled in 表示専用モード', () => {
    // 表示系コマンドは編集権限ゲートの対象外 (permissions.ts).
    expect(isEditingCommand(COMMAND_ID.ViewFitAll)).toBe(false);
  });
});
