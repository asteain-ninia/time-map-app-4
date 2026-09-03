// UI layer (U20 / shell): アプリバーの素性表示（設計書 §H.6）。
//
// **どのファイルを開いているのか、未保存かどうかが常に見える**ようにする。これまでは
// どちらも画面のどこにも出ていなかった（未保存の表示は診断ダイアログの中だけ）のに、
// Ctrl+S は確認なく読み込み元を上書きしていた（V12）。フル版と間引き版の実データを
// 取り違える事故はここから起きる。
//
// ウィンドウタイトルにも同じ 3 つを出す（`status-format.ts` の buildWindowTitle）。
// 画面の中と外で同じことを言うのは重複ではない — タスクバーやウィンドウ一覧から選ぶときは
// タイトルしか見えず、作業中は画面しか見ていないからである。
//
// §7.4-2 が非目標としているのは「**メインマップ上への**常時表示」だけなので、アプリバーの
// 行とウィンドウタイトルは要件の文言に触れずに済む（AUDIT-DROPPED-REQUIREMENTS 自身が
// 推奨している置き場所）。

import { APP_IDENTITY_STRINGS } from './strings';

export interface AppIdentityProps {
  /** 世界名（プロジェクト名）。空なら段ごと出さない。 */
  readonly worldName: string;
  /** 保存先のファイル名（拡張子込み）。null なら「（未保存の新規）」。 */
  readonly fileName: string | null;
  readonly dirty: boolean;
}

export function AppIdentity(props: AppIdentityProps): JSX.Element {
  const world = props.worldName.trim();
  return (
    <div
      className="app-identity"
      aria-label={APP_IDENTITY_STRINGS.ariaLabel}
      data-testid="app-identity"
    >
      {world.length > 0 && (
        <span className="app-identity__world" data-testid="app-identity-world">
          {world}
        </span>
      )}
      <span className="app-identity__file" data-testid="app-identity-file">
        {props.fileName ?? APP_IDENTITY_STRINGS.unsavedNew}
      </span>
      {props.dirty && (
        <span
          className="app-identity__dirty"
          title={APP_IDENTITY_STRINGS.dirtyTitle}
          aria-label={APP_IDENTITY_STRINGS.dirtyTitle}
          data-testid="app-identity-dirty"
        >
          ●
        </span>
      )}
    </div>
  );
}
