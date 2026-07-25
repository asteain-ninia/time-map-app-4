// U20 / shell — 表示 → 拡大 / 縮小 (view.zoomIn / view.zoomOut) の導線契約.
//
// menu.ts は Ctrl+= / Ctrl+- を宣言済みだが **ハンドラが未登録** だった（教訓 5.7
// 「ロジック/宣言があっても UI から呼ばれない」）。実機では Electron 既定アプリケーション
// メニューの zoomIn/zoomOut ロールが同じ chord を所有し、押すと **ページ** ズームが
// 変わって FR-16 の座標対応が壊れていた。ここでは宣言側の契約（表示メニューに在る /
// chord が一意 / keymap から dispatch できる / 未登録==無効 / 一覧に載る / 表示専用でも
// 有効）を固定する。実機の結線は e2e/app-menu.spec.ts。

import { describe, expect, it } from 'vitest';

import { COMMAND_ID, CommandRegistry } from './commands';
import { buildDefaultKeymap } from './default-keymap';
import { listShortcutEntries, MENU_KEY, STANDARD_MENUS } from './menu';
import { isEditingCommand } from './permissions';
import { chordOf, formatShortcut } from './shortcuts';

const ZOOM_COMMANDS = [COMMAND_ID.ViewZoomIn, COMMAND_ID.ViewZoomOut] as const;

describe('view.zoomIn / view.zoomOut の導線', () => {
  it('sit in the 表示 menu with an accelerator', () => {
    const view = STANDARD_MENUS.find((m) => m.key === MENU_KEY.View);
    expect(view).toBeDefined();
    for (const commandId of ZOOM_COMMANDS) {
      const item = view!.items.find((i) => i.commandId === commandId);
      expect(item, commandId).toBeDefined();
      expect(item!.shortcut, commandId).toBeDefined();
    }
  });

  it('declare chords that collide with NO other binding', () => {
    const chords = STANDARD_MENUS.flatMap((m) =>
      m.items.flatMap((i) =>
        i.shortcut === undefined
          ? []
          : [chordOf(i.shortcut), ...(i.extraShortcuts ?? []).map(chordOf)],
      ),
    );
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('are dispatchable from the derived keymap once registered (未登録==無効)', () => {
    const keymap = buildDefaultKeymap();
    const view = STANDARD_MENUS.find((m) => m.key === MENU_KEY.View)!;
    for (const commandId of ZOOM_COMMANDS) {
      const shortcut = view.items.find((i) => i.commandId === commandId)!.shortcut!;
      expect(
        keymap.resolve({
          key: shortcut.key,
          ctrlOrMeta: shortcut.ctrlOrMeta === true,
          shift: shortcut.shift === true,
          alt: shortcut.alt === true,
        }),
      ).toBe(commandId);

      const registry = new CommandRegistry();
      expect(registry.dispatch(commandId)).toBe(false);
      let ran = 0;
      registry.register(commandId, {
        run: () => {
          ran += 1;
        },
      });
      expect(registry.dispatch(commandId)).toBe(true);
      expect(ran).toBe(1);
    }
  });

  it('appear in the ショートカット一覧 (HB-9) rows', () => {
    const listed = listShortcutEntries().map((r) => r.commandId);
    for (const commandId of ZOOM_COMMANDS) expect(listed).toContain(commandId);
  });

  it('are VIEW-axis commands: stay enabled in 表示専用モード', () => {
    for (const commandId of ZOOM_COMMANDS) expect(isEditingCommand(commandId)).toBe(false);
  });

  // 表示ラベルと実打鍵の一致 (レビュー MEDIUM). `formatShortcut` は KEY_DISPLAY で
  // '=' → '+' に写すので、拡大は **「Ctrl++」と表示される**。ところが chord は shift を
  // 含まない `mod+=` なので、ユーザーがラベル通りに Ctrl+Shift+= を打つと chord は
  // `mod+shift+=`（Playwright/US 配列では `mod+shift++`）になり未登録＝無反応だった。
  // JIS 配列では `=` が Shift+「-」でしか入れられないため `mod+=` は **原理的に発生し得ず**、
  // 「拡大だけキーボードから実行不可能」という非対称な穴になっていた（縮小 Ctrl+- は
  // 無修飾キーなので動く）。表示ラベルから素直に導かれる打鍵の**全て**が拡大に解決する
  // ことを固定する（別名は extraShortcuts で登録＝宣言の単一真実源のまま, 教訓 5.33）。
  it('accept every keystroke the「Ctrl++」ラベル implies (shift 有無 / = と + の両方)', () => {
    const keymap = buildDefaultKeymap();
    const view = STANDARD_MENUS.find((m) => m.key === MENU_KEY.View)!;
    const zoomIn = view.items.find((i) => i.commandId === COMMAND_ID.ViewZoomIn)!;

    // ラベルは実際に「Ctrl++」（'=' が '+' として表示される）.
    expect(formatShortcut(zoomIn.shortcut!, 'other')).toBe('Ctrl++');

    // そのラベルを読んだユーザーが打ちうる 4 通り（'+' は Shift+= として届く配列も、
    // JIS のように shift 付き '=' として届く配列もある）— すべて拡大でなければならない.
    for (const chord of [
      { key: '=', ctrlOrMeta: true, shift: false, alt: false },
      { key: '=', ctrlOrMeta: true, shift: true, alt: false },
      { key: '+', ctrlOrMeta: true, shift: false, alt: false },
      { key: '+', ctrlOrMeta: true, shift: true, alt: false },
    ]) {
      expect(keymap.resolve(chord), `${chord.key} shift=${String(chord.shift)}`).toBe(
        COMMAND_ID.ViewZoomIn,
      );
    }

    // 縮小のラベル「Ctrl+-」は無修飾キーなので配列差が無い — 実打鍵と一致.
    const zoomOut = view.items.find((i) => i.commandId === COMMAND_ID.ViewZoomOut)!;
    expect(formatShortcut(zoomOut.shortcut!, 'other')).toBe('Ctrl+-');
    expect(keymap.resolve({ key: '-', ctrlOrMeta: true, shift: false, alt: false })).toBe(
      COMMAND_ID.ViewZoomOut,
    );
  });

  it('resolve to DIFFERENT commands (拡大 と 縮小 が同じ chord に潰れていない)', () => {
    const view = STANDARD_MENUS.find((m) => m.key === MENU_KEY.View)!;
    const inShortcut = view.items.find((i) => i.commandId === COMMAND_ID.ViewZoomIn)!.shortcut!;
    const outShortcut = view.items.find((i) => i.commandId === COMMAND_ID.ViewZoomOut)!.shortcut!;
    expect(chordOf(inShortcut)).not.toBe(chordOf(outShortcut));
  });
});
