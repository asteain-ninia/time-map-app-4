// Electron 既定アプリケーションメニューの無効化（データ損失リスクの根治）.
//
// 既定メニューを放置すると、Electron/Chromium 側のロールが以下のアクセラレータを
// **アプリより先に** 所有する（実測）:
//   - Ctrl+R / Ctrl+Shift+R = リロード → **編集中プロジェクトが吹き飛ぶ**（未保存確認も
//     出ない）。データ損失の直接原因。
//   - Ctrl+W = ウィンドウを閉じる → 未保存確認を経ずに閉じる一経路。
//     ⚠️ 責務の境界: この単位が塞ぐのは「Ctrl+W というキーの所有権」だけ。× / Alt+F4 /
//     タスクバー / OS シャットダウンの未保存確認は FR-107 close ブリッジ
//     (main/close-guard.ts + createWindow の `window.on('close')`) が担当する。
//     どちらが欠けても別経路が空くので、両方が必要。
//   - Ctrl+0 / Ctrl+= / Ctrl+- = **ページ** ズーム → CSS px 尺度が変わり FR-16 の
//     座標対応（画面 px ↔ 経緯度）と地図ズームの単一真実源が壊れる。
//   - Ctrl+Shift+I = DevTools。
// アプリは `autoHideMenuBar: true` かつ自前のメニューバー（FR-111）を primary surface と
// して持つので、既定メニューは冗長かつ有害である。
//
// この単位は「どのアプリケーションメニューを入れるか」の判断だけを持つ純粋ロジックで、
// Electron を import しない（開発ガイド §5.41 — main のロジックは Electron-free に置き、
// 合成ルートだけが実物を束縛する）。
//
// 方針:
//   - win32 / linux: **メニューを一切入れない**（`null`）。テキスト編集の
//     Ctrl+C/V/X/A は Chromium のネイティブ編集コマンドが処理するのでメニュー由来では
//     なく、クリップボードは退行しない（e2e/app-menu.spec.ts で実測固定）。
//   - darwin: mac は Cmd 系のキー配送がアプリメニューに依存するため、**最小メニュー**
//     （`appMenu` = 終了等 / `editMenu` = コピー・貼り付け等）だけを残す。`viewMenu`
//     (リロード / ページズーム / DevTools) と `windowMenu` (Cmd+W) は入れない。
//
// どちらの分岐でも、テンプレートに現れてよいロールは {@link ALLOWED_MENU_ROLES} の
// ホワイトリストに限る（将来 viewMenu 等が紛れ込んで Ctrl+R が復活しないよう固定）。

/** アプリケーションメニューに入れてよいロール（クリップボード/終了のみ）。 */
export const ALLOWED_MENU_ROLES = ['appMenu', 'editMenu'] as const;

export type AllowedMenuRole = (typeof ALLOWED_MENU_ROLES)[number];

/** ロールだけの最小メニュー項目（click ハンドラを持たないので Electron 型に依存しない）。 */
export interface RoleMenuEntry {
  readonly role: AllowedMenuRole;
}

export type ApplicationMenuTemplate = readonly RoleMenuEntry[];

/**
 * そのプラットフォームで設定すべきアプリケーションメニューのテンプレート。
 * `null` = 「メニューを設定しない」（= `Menu.setApplicationMenu(null)`）。
 */
export function applicationMenuTemplate(platform: NodeJS.Platform): ApplicationMenuTemplate | null {
  if (platform === 'darwin') {
    return [{ role: 'appMenu' }, { role: 'editMenu' }];
  }
  return null;
}

/**
 * Electron の `Menu` に対する最小の継ぎ目。合成ルート（main/index.ts）だけが実物を
 * 渡し、この単位はテストからフェイクで駆動できる。
 */
export interface ApplicationMenuApi<TMenu> {
  buildFromTemplate(template: ApplicationMenuTemplate): TMenu;
  setApplicationMenu(menu: TMenu | null): void;
}

/**
 * 既定メニューを置き換える（= 無効化する）。**必ず** `setApplicationMenu` を1回呼ぶ:
 * 呼ばない限り Electron の既定メニューが生き残り、Ctrl+R が編集中データを破棄できる。
 */
export function installApplicationMenu<TMenu>(
  api: ApplicationMenuApi<TMenu>,
  platform: NodeJS.Platform,
): void {
  const template = applicationMenuTemplate(platform);
  api.setApplicationMenu(template === null ? null : api.buildFromTemplate(template));
}

// --- dev 限定 DevTools バインド ----------------------------------------------
//
// 既定メニューを外した副作用: `toggleDevTools` ロール(Ctrl+Shift+I)が **唯一の** DevTools
// 導線だったため、`npm run dev` でもレンダラを覗く手段が無くなる（Electron は F12 を既定
// バインドしない — あれは Chrome ブラウザ側の挙動）。製品ビルドでは閉鎖したままにしたいので、
// **dev サーバ経由で起動したときだけ** 単発のキーバインドで戻す。
// `ALLOWED_MENU_ROLES` に `viewMenu` を戻すのは reload / ページズームが復活するので **不可**。
// 判定はここ（純粋）、`openDevTools` の呼び出しは合成ルート（main/index.ts）。

/** `before-input-event` が渡すキー入力の必要最小形（Electron の `Input` の構造的部分集合）。 */
export interface KeyInputLike {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/**
 * DevTools バインドを入れてよいか。判定は index.ts が load 先の分岐に使っているものと
 * 同じ `ELECTRON_RENDERER_URL`（= dev サーバ起動）という単一の真実源に従う。
 */
export function devToolsBindingEnabled(devServerUrl: string | undefined): boolean {
  return devServerUrl !== undefined && devServerUrl !== '';
}

/**
 * その入力が DevTools 切り替えか（Ctrl/Cmd+Shift+I または F12）。`keyDown` のみを見るので
 * 1打鍵で二重に発火しない。アプリ自身が持つ chord（Ctrl+Z / Ctrl+F / F5 …）は拾わない。
 */
export function isDevToolsChord(input: KeyInputLike): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'F12') return true;
  return (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';
}
