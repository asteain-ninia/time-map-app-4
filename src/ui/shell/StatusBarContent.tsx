// UI layer (U20 / shell): 状態行 28px の 5 枠（設計書 §C.8 / §H.6）。
//
// ```
// ┌ 左 240 ──┬ 縮尺 160 ┬ 直前の結果 1fr ────────┬ 取り消し 160 ┬ 最終保存 160 ┐
// │北35.2 東12.4│1:12,000,000│南ケナ州を最上位へ移しました（1200年）│元に戻す: 可 Ctrl+Z│最終保存 14:03│
// └───────┴──────┴─────────────────┴─────────┴────────┘
// ```
//
// これまでの状態行はカーソル座標 1 項目だけで、**「今どうなっているか」を映さず成功を一度も
// 知らせなかった**（C6。件数では最多の根本原因）。5 枠のうち 3 つ（直前の結果・元に戻す・
// 最終保存）は、実運用に踏み切れない不安への直接の答えである。
//
// **枠の幅は固定で、中身が空でも枠は残る**（K-3 と同じ規則。寸法は shell.css が単一の
// 真実源で、寸法契約は shell-layout.test.ts が読む）。
//
// 再レンダーの粒度: 60Hz で動く値（カーソル座標・縮尺）は **それぞれの葉ノードだけ** が
// 購読する（技術方針 2.3: React は 60FPS 経路を駆動しない）。座標は React 外の
// CursorPositionStore、縮尺は zustand の細いセレクタ（zoom という数値 1 個）なので、
// パンでは再レンダーが起きず、ズームでのみ縮尺のノードだけが描き直る。

import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';
import { CursorCoordinateStatus } from './CursorCoordinateStatus';
import type { CursorPositionStore } from './cursor-position';
import { formatClock, formatScale, scaleDenominator } from './status-format';
import type { StatusMessageStore } from './status-message';
import { STATUS_STRINGS } from './strings';

/** 「元に戻す」枠の中身（App の履歴から渡す）。 */
export interface UndoStatus {
  readonly canUndo: boolean;
  /**
   * 直前の操作名（`Command.label`）。**「可」だけでは何が戻るか分からない**ので出す
   * （設計書 §C.8）。取れないときは null で、その場合は可否だけを出す。
   */
  readonly lastLabel: string | null;
}

export interface StatusBarContentProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly cursorStore: CursorPositionStore;
  readonly messageStore: StatusMessageStore;
  readonly undo: UndoStatus;
  /** 最後に保存できた時刻（epoch ms）。null = このセッションでまだ保存していない。 */
  readonly lastSavedAtMs: number | null;
  /**
   * 自動保存が本体ファイルへ書ける状態か（A4-a）。false のときは「保存先が未確定」か
   * 「その保存先への上書きをまだ確認していない」ので、自動保存は何もしない。既定は
   * true（自動保存の素性を渡していないホストの表示を変えないため）。
   */
  readonly autoSaveArmed?: boolean;
}

/** 縮尺 1:N。ズームと赤道長からその場で導く（新しい真実源を作らない）。 */
function ScaleStatus<S>(props: { readonly store: StoreApi<SessionStore<S>> }): JSX.Element {
  const zoom = useStore(props.store, (s) => s.camera.zoom);
  const equatorLengthKm = useStore(props.store, (s) => s.projectSettings.equatorLengthKm);
  return (
    <span className="statusbar__value" data-testid="statusbar-scale">
      {formatScale(scaleDenominator(zoom, equatorLengthKm))}
    </span>
  );
}

/** 直前の結果（成功も失敗も）。**時間では消えない**（教訓 5.12 / K-7）。 */
function LastResultStatus(props: { readonly store: StatusMessageStore }): JSX.Element {
  const { store } = props;
  const message = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => store.get(),
  );
  if (message === null) {
    return (
      <span className="statusbar__muted" data-testid="statusbar-result">
        {STATUS_STRINGS.noResult}
      </span>
    );
  }
  return (
    <span
      className="statusbar__value"
      data-testid="statusbar-result"
      data-tone={message.tone}
      role="status"
    >
      <span className="statusbar__result-text">{message.text}</span>
      {/* 結果に添えたボタン（増分 8C の手直し: 「測量の線を消しました［戻す］」）。
          **押したら焦点を手放す**（再手直し / 再検証 #3）。焦点が状態行に残ると、地図に焦点が
          あるときだけ効く打鍵（`U`。`shell/map-focus-scope.ts`）が、地図を押し直すまで黙って効かない。 */}
      {message.action !== undefined && (
        <button
          type="button"
          className="statusbar__action"
          data-testid="statusbar-result-action"
          onClick={(e) => {
            e.currentTarget.blur();
            message.action?.run();
          }}
        >
          {message.action.label}
        </button>
      )}
      <button
        type="button"
        className="statusbar__dismiss"
        aria-label={STATUS_STRINGS.dismissResult}
        data-testid="statusbar-result-dismiss"
        onClick={() => store.clear()}
      >
        ×
      </button>
    </span>
  );
}

function undoText(undo: UndoStatus): string {
  if (!undo.canUndo) return STATUS_STRINGS.undoUnavailable;
  if (undo.lastLabel === null) return STATUS_STRINGS.undoAvailable;
  return `${STATUS_STRINGS.undoAvailablePrefix}${undo.lastLabel}${STATUS_STRINGS.undoShortcutSuffix}`;
}

/** 最終保存枠の中身。自動保存が待機中なら、その断り書きも同じ枠に出す。 */
function lastSavedText(lastSavedAtMs: number | null, autoSaveArmed: boolean): string {
  const saved =
    lastSavedAtMs === null
      ? STATUS_STRINGS.neverSaved
      : `${STATUS_STRINGS.lastSavedPrefix}${formatClock(lastSavedAtMs)}`;
  return autoSaveArmed ? saved : `${saved}${STATUS_STRINGS.autoSaveHold}`;
}

export function StatusBarContent<S>(props: StatusBarContentProps<S>): JSX.Element {
  const { store, cursorStore, messageStore, undo, lastSavedAtMs } = props;
  const autoSaveArmed = props.autoSaveArmed ?? true;

  return (
    <>
      <span className="statusbar__frame statusbar__frame--coords" data-testid="statusbar-coords">
        <CursorCoordinateStatus store={cursorStore} />
      </span>

      <span className="statusbar__frame statusbar__frame--scale">
        <ScaleStatus store={store} />
      </span>

      <span className="statusbar__frame statusbar__frame--result">
        <LastResultStatus store={messageStore} />
      </span>

      <span className="statusbar__frame statusbar__frame--undo">
        {/* 枠は 160px のまま（§C.8）。文字を包むのは、値の箱が横並びの箱なので、直に置いた文字には
            省略記号が付かないから。全文は指し示すと読める。 */}
        <span className="statusbar__value" data-testid="statusbar-undo" title={undoText(undo)}>
          <span className="statusbar__result-text">{undoText(undo)}</span>
        </span>
      </span>

      <span className="statusbar__frame statusbar__frame--saved">
        <span
          className="statusbar__value"
          data-testid="statusbar-last-saved"
          data-auto-save-armed={autoSaveArmed ? 'true' : 'false'}
          title={autoSaveArmed ? undefined : STATUS_STRINGS.autoSaveHoldDetail}
        >
          {lastSavedText(lastSavedAtMs, autoSaveArmed)}
        </span>
      </span>
    </>
  );
}
