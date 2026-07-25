// 既定アプリケーションメニュー無効化の契約.
//
// 守るべき不変条件は2つで、どちらもデータ損失に直結する:
//   (1) 起動時に **必ず** アプリケーションメニューが置き換えられる（呼ばなければ Electron
//       既定メニューが生き残り、Ctrl+R でリロードして編集中プロジェクトが吹き飛ぶ）。
//   (2) 置き換えたメニューに reload / ページズーム / DevTools / ウィンドウ閉鎖 のロールが
//       **一切含まれない**（= viewMenu / windowMenu を足して回帰させない）。

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MENU_ROLES,
  applicationMenuTemplate,
  devToolsBindingEnabled,
  installApplicationMenu,
  isDevToolsChord,
  type ApplicationMenuApi,
  type ApplicationMenuTemplate,
  type KeyInputLike,
} from './app-menu';

interface Recorded {
  readonly built: ApplicationMenuTemplate[];
  readonly set: (string | null)[];
}

function fakeApi(): { api: ApplicationMenuApi<string>; recorded: Recorded } {
  const built: ApplicationMenuTemplate[] = [];
  const set: (string | null)[] = [];
  return {
    recorded: { built, set },
    api: {
      buildFromTemplate: (template) => {
        built.push(template);
        return `menu(${template.map((e) => e.role).join(',')})`;
      },
      setApplicationMenu: (menu) => {
        set.push(menu);
      },
    },
  };
}

describe('applicationMenuTemplate', () => {
  it('installs NO menu on win32 / linux (既定メニューを丸ごと外す)', () => {
    expect(applicationMenuTemplate('win32')).toBeNull();
    expect(applicationMenuTemplate('linux')).toBeNull();
  });

  it('keeps only the clipboard/quit roles on darwin (Cmd 配送のため)', () => {
    const template = applicationMenuTemplate('darwin');
    expect(template).not.toBeNull();
    expect(template!.map((e) => e.role)).toEqual(['appMenu', 'editMenu']);
  });

  it('never exposes reload / page-zoom / devtools / window-close roles on ANY platform', () => {
    // viewMenu = reload + Ctrl+Shift+R + ページズーム(Ctrl+0/±) + DevTools,
    // windowMenu = Ctrl+W。どちらも入っていてはならない。
    const forbidden = ['viewMenu', 'windowMenu', 'reload', 'forceReload', 'toggleDevTools',
      'resetZoom', 'zoomIn', 'zoomOut', 'close'];
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const roles = (applicationMenuTemplate(platform) ?? []).map((e) => String(e.role));
      for (const bad of forbidden) expect(roles, platform).not.toContain(bad);
      // ホワイトリストの外は一切許さない（将来の追加で穴が開かないよう固定）.
      for (const role of roles) {
        expect(ALLOWED_MENU_ROLES as readonly string[], platform).toContain(role);
      }
    }
  });
});

describe('installApplicationMenu', () => {
  it('calls setApplicationMenu(null) on win32 without building anything', () => {
    const { api, recorded } = fakeApi();
    installApplicationMenu(api, 'win32');
    expect(recorded.set).toEqual([null]);
    expect(recorded.built).toEqual([]);
  });

  it('builds and sets the minimal menu on darwin', () => {
    const { api, recorded } = fakeApi();
    installApplicationMenu(api, 'darwin');
    expect(recorded.built).toHaveLength(1);
    expect(recorded.set).toEqual(['menu(appMenu,editMenu)']);
  });

  it('ALWAYS replaces the menu exactly once (既定メニューを生き残らせない)', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const { api, recorded } = fakeApi();
      installApplicationMenu(api, platform);
      expect(recorded.set, platform).toHaveLength(1);
    }
  });
});

// 既定メニュー撤去の副作用 (レビュー LOW): toggleDevTools ロールが唯一の DevTools 導線
// だったので、開発時のレンダラデバッグ手段が丸ごと消えた。dev 起動時**だけ** 単発の
// キーバインドで戻す（製品ビルドでは閉じたまま = viewMenu を戻すのは reload/ページズームが
// 復活するので不可）。ここは純粋な判定のみ（実際の openDevTools は合成ルート）。
describe('dev 限定 DevTools バインド', () => {
  const keyDown = (over: Partial<KeyInputLike>): KeyInputLike => ({
    type: 'keyDown',
    key: 'a',
    control: false,
    meta: false,
    shift: false,
    ...over,
  });

  it('is enabled ONLY when the dev renderer URL is present (製品ビルドでは無効)', () => {
    // index.ts が既に dev 判定に使っている条件と同一の真実源.
    expect(devToolsBindingEnabled('http://localhost:5173')).toBe(true);
    expect(devToolsBindingEnabled(undefined)).toBe(false);
    // 空文字は「dev サーバ無し」— loadFile 経路と同じ扱いにする.
    expect(devToolsBindingEnabled('')).toBe(false);
  });

  it('recognises Ctrl+Shift+I / Cmd+Shift+I / F12 on keyDown only', () => {
    expect(isDevToolsChord(keyDown({ key: 'I', control: true, shift: true }))).toBe(true);
    expect(isDevToolsChord(keyDown({ key: 'i', control: true, shift: true }))).toBe(true);
    expect(isDevToolsChord(keyDown({ key: 'i', meta: true, shift: true }))).toBe(true);
    expect(isDevToolsChord(keyDown({ key: 'F12' }))).toBe(true);
    // keyUp / char は二重発火の元なので拾わない.
    expect(isDevToolsChord({ ...keyDown({ key: 'F12' }), type: 'keyUp' })).toBe(false);
  });

  it('ignores chords the app itself owns (誤発火でアプリ機能を奪わない)', () => {
    for (const input of [
      keyDown({ key: 'i', control: true }), // Ctrl+I（shift 無し）
      keyDown({ key: 'i', shift: true }), // Shift+I = ただの大文字入力
      keyDown({ key: 'i' }),
      keyDown({ key: 'z', control: true }), // undo
      keyDown({ key: 'f', control: true }), // 地物を検索
      keyDown({ key: 'F5' }),
    ]) {
      expect(isDevToolsChord(input), `${input.key}`).toBe(false);
    }
  });
});
