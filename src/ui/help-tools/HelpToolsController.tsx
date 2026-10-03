// UI layer (HB-8 / HB-9): wire the ツール and ヘルプ menu commands to live UI.
//
// HB-8 / HB-9 ROOT FIX — the five ids ToolsSettings / ToolsSearch / HelpAbout /
// HelpShortcuts / HelpDiagnostics were declared (commands.ts) and placed in the
// ツール / ヘルプ menus (menu.ts), but NO unit ever registered a handler for them.
// The shell's single enabled rule (permissions.resolveCommandEnabled) treats an
// unregistered command as 無効, so every one of those menu items rendered
// permanently grayed (the same dead-command class as HB-4). This controller is
// the missing 結線 (教訓 5.7 合成ルートの結線漏れ): it registers a handler for each
// id on the SAME CommandRegistry the menu + shortcuts dispatch (教訓 5.13 単一の
// 真実源), each handler OPENS the corresponding view, and the registrations are
// torn down on unmount (useEffect cleanup unregister — the ViewToggleViewMode
// pattern in App.tsx). It also OWNS the small modal state (which view is open) and
// renders the existing 設定ダイアログ (U38) plus the 検索 / 診断 / バージョン /
// ショートカット一覧 views built here over existing pure logic (U41 search/log,
// U20 menu/shortcut formatters) — no new domain logic.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { useModalKeydown } from '../a11y/index';
import type { SessionStore } from '../state/store';
import type { PaletteSelection } from '../state/settings';
import {
  CommandRegistry,
  COMMAND_ID,
  canEdit,
  formatShortcut,
  detectPlatform,
  listShortcutEntries,
  type Platform,
  ABOUT_STRINGS,
  SHORTCUTS_STRINGS,
  formatTimestamp,
} from '../shell/index';
import { SettingsDialog } from '../settings/index';
import type { BackupSettingsPort, SettingsStorePort } from '../settings/index';
import {
  DIAGNOSTICS_STRINGS,
  LOG_LEVEL,
  DiagnosticLogger,
  type LogEntry,
  type LogLevel,
} from '../discovery/index';

/**
 * 診断ログの種別の日本語ラベル（U-1: 内部の英語値を画面に出さない）。ログ自体は
 * `LOG_LEVEL` の英語識別子で持つが、画面へはここを通してから出す（教訓 5.19）。
 */
const LOG_LEVEL_LABELS: Readonly<Record<LogLevel, string>> = {
  [LOG_LEVEL.Info]: '情報',
  [LOG_LEVEL.Warning]: '警告',
  [LOG_LEVEL.Error]: 'エラー',
};
// 作中時刻を文字にする整形は U21 の `formatTimePoint` が単一の真実源（紀元前の表記と、
// 未指定の月日を捏造しない規約がここに集約されている）。診断情報の概況が持っていた
// `${t.year}年` はその写しで、負の年が「-27年」になっていた（教訓 5.44 同名・同目的の
// 写しを残さない）。React 部品を引かずに済むよう、barrel ではなく純関数の実体を指す。
import { formatTimePoint } from '../timeline/time-display';
import { featuresAt } from '../live-lookup';
import type { DomainProject } from '../../domain/persistence/index';

/** Which help/tools view is currently open (only one at a time). */
// **`Search` は増分 4 で消えた。** 「地物を検索」は独立したモーダルをやめ、
// **地物一覧の絞り込み欄へ焦点を入れるだけ**になった（E-6）。理由は 2 つ:
//   1. 母集団が一覧とは別に組まれていた（N-41。同じ世界に「探す集合」が 2 つあった）
//   2. **年を属性の検索対象に入れていた**ので、数字 1 文字でほぼ全件が一致した（C10）
// 行き先の結線は合成ルート（`App.tsx`）が持つ。
const HELP_VIEW = {
  None: 'none',
  Settings: 'settings',
  About: 'about',
  Shortcuts: 'shortcuts',
  Diagnostics: 'diagnostics',
} as const;

type HelpView = (typeof HELP_VIEW)[keyof typeof HELP_VIEW];

export interface HelpToolsControllerProps {
  /** The live session store (settings truth + current time + domain root). */
  readonly store: StoreApi<SessionStore<DomainProject>>;
  /** The SAME registry the menu + shortcuts dispatch (教訓 5.13). */
  readonly registry: CommandRegistry;
  /** Platform for accelerator labels in the shortcut list (testable injection). */
  readonly platform?: Platform;
  /**
   * Report whether one of this controller's modals (設定 / 検索 / バージョン /
   * ショートカット一覧 / 診断) is open (bughunt3 H1). The modal-open state lives HERE,
   * not in App.tsx, so the host cannot suspend the global shortcut dispatcher without
   * this lift. The host ORs it into shortcutsSuspended so Ctrl+Z / Delete cannot leak
   * THROUGH an open dialog to a domain op (these dialogs handle only Esc/Tab via React
   * onKeyDown, which a native window listener ignores). Fires on every open/close.
   */
  readonly onModalOpenChange?: (open: boolean) => void;
  /**
   * FR-04 — hand the base-map差し替え REQUEST to the host (App wires it to the U39
   * FileOpsController's replace runner). Threaded straight into the U38 設定ダイアログ's
   * `onRequestBasemapReplace`起動点; when absent the dialog's差し替えボタン stays disabled
   * (受け入れ基準: 結線が無ければ死んだボタン, 教訓 5.7). This controller performs no
   * replacement itself — it only forwards the request.
   */
  readonly onRequestBasemapReplace?: () => void;
  /**
   * FR-117 診断情報のエラーログ（G-19 / N-34）。**ロガーは動いていてファイル沈め口も繋がって
   * いるのに、パネルが固定の空文言を描いていた**（表示側だけ未結線）。App が持っている
   * 唯一のロガーをここへ渡すと、記録済みのエラーがそのまま出る。渡されなければ従来どおり
   * 空文言（honest stub — 嘘の「ログ 0 件」を出すよりは「未結線」を保つ）。
   */
  readonly logger?: DiagnosticLogger;
  /**
   * FR-109 follow-up (ユーザー裁定) — commit a default-palette change as ONE UNDOABLE
   * command (App wires it to the recordCommand funnel, so the palette change + its
   * auto-recolor land in the same undo unit). Merged into the U38 設定ダイアログ's injected
   * store port as `commitPaletteChange`; when absent the dialog falls back to the plain
   * (non-undoable) per-key updateProjectSetting write for the palette (受け入れ基準: 結線
   * が無ければ従来経路, never a crash). This controller only forwards the seam.
   */
  readonly onCommitPaletteChange?: (palette: PaletteSelection) => void;
}

/**
 * Register the ツール / ヘルプ command handlers and render the views they open.
 *
 * The registration is the HB-8/HB-9 fix; the views are intentionally lightweight
 * (the spec calls for 既存 UI を結線, with a最小実装 where none exists). 設定 reuses
 * the full U38 dialog; 検索 / 診断 / バージョン / ショートカット一覧 are built here
 * over existing pure logic. Each view exposes a data-testid observation hook
 * (既存 app-active-feature 方式) so the behavioural E2E can assert the click opened
 * it. NO truth lives in this component beyond the transient "which view is open".
 */
export function HelpToolsController(props: HelpToolsControllerProps): JSX.Element | null {
  const { store, registry } = props;
  const [view, setView] = useState<HelpView>(HELP_VIEW.None);

  // K-6「読むだけ」(教訓 5.13 / 所有者裁定): 設定を**開く**ことは全モードで許す（読むだけ
  // でも設定は読めるべき）が、開いた先の**プロジェクト設定**（＝保存ファイルの中身）は
  // 表示専用モードでは触らせない。判定は shell の canEdit(mode) 1 本をそのまま引く
  // （ここで独自のモード判定を書かない）。live 購読なので、ダイアログを開いたままモードを
  // 切り替えても追従する。
  const editable = useStore(store, (s) => canEdit(s.mode));

  // HB-8 / HB-9 — register all five handlers on the shared registry and tear them
  // down on unmount (the ViewToggleViewMode pattern). Each handler只 opens a view;
  // they carry no `canRun` gate (these are always-available help/tools commands,
  // not editing commands — permissions.ts keeps them enabled in every mode).
  useEffect(() => {
    registry.register(COMMAND_ID.ToolsSettings, { run: () => setView(HELP_VIEW.Settings) });
    registry.register(COMMAND_ID.HelpAbout, { run: () => setView(HELP_VIEW.About) });
    registry.register(COMMAND_ID.HelpShortcuts, { run: () => setView(HELP_VIEW.Shortcuts) });
    registry.register(COMMAND_ID.HelpDiagnostics, { run: () => setView(HELP_VIEW.Diagnostics) });
    return () => {
      registry.unregister(COMMAND_ID.ToolsSettings);
      registry.unregister(COMMAND_ID.HelpAbout);
      registry.unregister(COMMAND_ID.HelpShortcuts);
      registry.unregister(COMMAND_ID.HelpDiagnostics);
    };
  }, [registry]);

  // bughunt3 (H1): mirror "a modal is open" up to the host so it can suspend the
  // global shortcut dispatcher while one of these dialogs owns the keyboard. The view
  // state here is the single truth; we only reflect it (no duplicate flag). Cleared on
  // unmount so a torn-down controller never leaves the dispatcher suspended (教訓 5.2).
  const onModalOpenChange = props.onModalOpenChange;
  const modalOpenRef = useRef(false);
  useEffect(() => {
    if (onModalOpenChange === undefined) return;
    const open = view !== HELP_VIEW.None;
    if (open !== modalOpenRef.current) {
      modalOpenRef.current = open;
      onModalOpenChange(open);
    }
    return () => {
      if (modalOpenRef.current) {
        modalOpenRef.current = false;
        onModalOpenChange(false);
      }
    };
  }, [view, onModalOpenChange]);

  const close = (): void => setView(HELP_VIEW.None);

  switch (view) {
    case HELP_VIEW.Settings: {
      // The full U38 dialog, bound to the live store slice. It owns its own draft /
      // confirm / cancel; onClose returns to None (its cancel + Esc + backdrop all
      // route through here). FR-04: the差し替えボタン起動点 is forwarded to the host's
      // replace runner (App → U39 FileOpsController); the dialog performs no
      // replacement itself (受け入れ基準 1).
      // Merge the LIVE store slice with the FR-109 undoable palette seam into ONE
      // injected port (the store owns the settings truth + the non-undoable per-key
      // writes; commitPaletteChange is App's recordCommand funnel). Only attach the
      // seam when provided (exactOptionalPropertyTypes: never write `undefined`).
      const settingsPort: SettingsStorePort = {
        ...store.getState(),
        ...(props.onCommitPaletteChange !== undefined
          ? { commitPaletteChange: props.onCommitPaletteChange }
          : {}),
      };
      // 増分 8D: 「保存とバックアップ」の節は型付き IPC（アプリ側の設定と世代の一覧）を
      // 直に使う。preload が公開していない環境（jsdom の単体試験）では渡さない。
      const backupPort = (globalThis as { timeMapApi?: BackupSettingsPort }).timeMapApi;
      return (
        <SettingsDialog
          store={settingsPort}
          canEdit={editable}
          onClose={close}
          backupPort={backupPort}
          {...(props.onRequestBasemapReplace !== undefined
            ? { onRequestBasemapReplace: props.onRequestBasemapReplace }
            : {})}
        />
      );
    }
    case HELP_VIEW.About:
      return <AboutView onClose={close} />;
    case HELP_VIEW.Shortcuts:
      return (
        <ShortcutsView
          {...(props.platform !== undefined ? { platform: props.platform } : {})}
          onClose={close}
        />
      );
    case HELP_VIEW.Diagnostics:
      return (
        <DiagnosticsView
          store={store}
          onClose={close}
          {...(props.logger !== undefined ? { logger: props.logger } : {})}
        />
      );
    case HELP_VIEW.None:
    default:
      return null;
  }
}

// --- a tiny shared modal frame ----------------------------------------------

/**
 * A minimal modal frame shared by the help/tools views (backdrop + centred panel +
 * close). The backdrop click and the close button both call `onClose` (教訓 5.2:
 * every exit path closes). `testid` identifies the view for the behavioural E2E.
 */
function HelpModal(props: {
  readonly testid: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  // Keyboard a11y (第5次バグハント / a11y): focus the dialog on mount, Esc closes,
  // Tab / Shift+Tab cycle inside it (背面へ抜けない) — the shared trap (教訓 5.13).
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = useModalKeydown(dialogRef, props.onClose);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="help-modal-root" data-testid={`${props.testid}-root`}>
      <div
        className="help-backdrop"
        data-testid={`${props.testid}-backdrop`}
        aria-hidden="true"
        onClick={props.onClose}
      />
      <div
        className="help-dialog"
        data-testid={props.testid}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="help-dialog__header">
          <h2 className="help-dialog__title">{props.title}</h2>
        </header>
        <div className="help-dialog__body">{props.children}</div>
        <footer className="help-dialog__footer">
          <button
            type="button"
            className="help-dialog__close"
            data-testid={`${props.testid}-close`}
            onClick={props.onClose}
          >
            {props.closeLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

// --- バージョン情報 (HB-9 / FR-111) ------------------------------------------

function AboutView(props: { readonly onClose: () => void }): JSX.Element {
  return (
    <HelpModal
      testid="about-panel"
      title={ABOUT_STRINGS.title}
      closeLabel={ABOUT_STRINGS.close}
      onClose={props.onClose}
    >
      <p className="about-panel__name">{ABOUT_STRINGS.appName}</p>
      <p className="about-panel__version">
        {ABOUT_STRINGS.versionLabel}:{' '}
        {/* Injected from package.json at build time (electron.vite.config.ts define);
            ONE source of truth for the displayed version (HB-9). */}
        <span data-testid="about-panel-version">{__APP_VERSION__}</span>
      </p>
      <p className="about-panel__description">{ABOUT_STRINGS.description}</p>
    </HelpModal>
  );
}

// --- ショートカット一覧 (HB-9 / FR-111) --------------------------------------

function ShortcutsView(props: {
  readonly platform?: Platform;
  readonly onClose: () => void;
}): JSX.Element {
  // Resolve the display platform once: "Ctrl" on Windows/Linux, "⌘" on macOS
  // (HB-2 formatter). Derived from the SAME STANDARD_MENUS accelerators the menu
  // bar + keymap use (§4 単一の真実源), so this list can never diverge.
  const platform = props.platform ?? detectPlatform();
  const entries = listShortcutEntries();

  return (
    <HelpModal
      testid="shortcuts-panel"
      title={SHORTCUTS_STRINGS.title}
      closeLabel={SHORTCUTS_STRINGS.close}
      onClose={props.onClose}
    >
      {entries.length === 0 ? (
        <p>{SHORTCUTS_STRINGS.empty}</p>
      ) : (
        <table className="shortcuts-panel__table">
          <thead>
            <tr>
              <th>{SHORTCUTS_STRINGS.commandColumn}</th>
              <th>{SHORTCUTS_STRINGS.keyColumn}</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              // HB-10: a command may list MORE THAN ONE accelerator (redo's Ctrl+Y
              // と Ctrl+Shift+Z). The FIRST (primary) row keeps the stable
              // per-command testid (shortcuts-panel-key-<id>); alias rows get a
              // chord-suffixed testid so every key cell is uniquely addressable and
              // no two share a data-testid (strict getByTestId stays unambiguous).
              //
              // N-35: **同じ表示になる打鍵は 1 行に畳む。** 拡大は dispatch 側の都合で
              // 4 通り登録されている（US 配列と JIS 配列の両方で Ctrl++ を受けるため
              // `=` と `+` × Shift の有無）が、表示では `=` も `+` も「+」になるので
              // 「拡大 Ctrl++」と「拡大 Ctrl+Shift++」が 2 回ずつ並んでいた。畳むのは
              // **表示側だけ**で、keymap に渡す別名は 1 つも減らさない（減らすと日本語
              // キーボードで拡大がキーボードから実行できなくなる）。
              const seen = new Set<string>();
              const shownChords = new Set<string>();
              const rows: JSX.Element[] = [];
              for (const entry of entries) {
                const chordLabel = formatShortcut(entry.shortcut, platform);
                const shownKey = `${entry.commandId}:${chordLabel}`;
                if (shownChords.has(shownKey)) continue;
                shownChords.add(shownKey);
                const isPrimary = !seen.has(entry.commandId);
                seen.add(entry.commandId);
                const keyTestid = isPrimary
                  ? `shortcuts-panel-key-${entry.commandId}`
                  : `shortcuts-panel-key-${entry.commandId}-${chordLabel}`;
                rows.push(
                  <tr key={shownKey} data-testid="shortcuts-panel-row">
                    <td>{entry.label}</td>
                    <td data-testid={keyTestid}>{chordLabel}</td>
                  </tr>,
                );
              }
              return rows;
            })()}
          </tbody>
        </table>
      )}
    </HelpModal>
  );
}

// --- 診断情報 (HB-9 / FR-117) ------------------------------------------------

/**
 * ロガーが渡されていないときに `useSyncExternalStore` へ返す空のログ。
 *
 * **モジュール定数にするのが肝**。ここで `[]` を毎回作ると、返す値が毎レンダー
 * 別物になって `useSyncExternalStore` が無限ループする。
 */
const EMPTY_LOG: readonly LogEntry[] = [];

/** 同上。ロガーが無いときの「購読しない購読」。解除も何もしない。 */
const NO_LOG_SUBSCRIPTION = (): void => undefined;

function DiagnosticsView(props: {
  readonly store: StoreApi<SessionStore<DomainProject>>;
  readonly onClose: () => void;
  readonly logger?: DiagnosticLogger;
}): JSX.Element {
  // A non-sensitive アプリ概況 derived from the live store (FR-117 / FR-02: counts +
  // flags only, never project content). featureCount = features effective NOW.
  //
  // BUG #8 — these are REACTIVE useStore selections, not a bare getState() snapshot
  // taken once at mount. The bare-snapshot form FROZE the displayed feature count and
  // unsaved flag at the moment the panel opened, so scrubbing the timeline or
  // adding/removing a feature never updated them (the store changed but this view was
  // not subscribed). Subscribing through useStore re-renders the panel on every
  // relevant store change (技術方針 2.5 React は subscribe でブリッジ). featureCount is
  // selected from (domain, currentTime) so it tracks BOTH edits and time scrubs.
  const featureCount = useStore(
    props.store,
    (s) => featuresAt(s.domain, s.currentTime).length,
  );
  const hasUnsavedChanges = useStore(props.store, (s) => s.projectDirty);
  const currentTime = useStore(props.store, (s) => s.currentTime);

  // ログも **購読**する（BUG #8 と同じ型の抜け）。概況の 3 つは Zustand を購読して
  // いたが、ログ欄はロガーを 1 回読むだけだったので、**診断画面を開いたままエラーが
  // 起きても欄に現れなかった**（ロガーは React の外の可変オブジェクトで、記録が増えても
  // React には何も伝わらない）。ロガー側に生やした subscribe / getSnapshot を
  // `useSyncExternalStore` でつなぐ（技術方針 2.5 / 教訓 5.35 共有リソース更新は全依存先へ
  // 通知する）。getSnapshot は変化が無ければ同じ配列を返すので、ここは無限ループしない。
  //
  // buildDiagnosticsSnapshot（ログ＋概況を 1 個の値に束ねる書き出し用の関数）は
  // **呼ぶたびに新しいオブジェクトを作る**ので `useSyncExternalStore` のスナップショットには
  // 使えない。概況の 3 項目はもともとこの下の JSX が直接描いていて、束ねた値は使って
  // いなかったため、ここではログの配列だけを購読して読む。
  const logger = props.logger;
  const subscribeLog = useCallback(
    (onChange: () => void): (() => void) =>
      logger === undefined ? NO_LOG_SUBSCRIPTION : logger.subscribe(onChange),
    [logger],
  );
  const readLog = useCallback(
    (): readonly LogEntry[] => (logger === undefined ? EMPTY_LOG : logger.getSnapshot()),
    [logger],
  );
  const log = useSyncExternalStore(subscribeLog, readLog, readLog);

  // 新しい順に出す（直近のエラーがいちばん上）。
  const entries = useMemo(() => [...log].reverse(), [log]);

  return (
    <HelpModal
      testid="diagnostics-panel"
      title={DIAGNOSTICS_STRINGS.panelTitle}
      closeLabel={ABOUT_STRINGS.close}
      onClose={props.onClose}
    >
      <p className="help-dialog__hint">{DIAGNOSTICS_STRINGS.help}</p>

      <section className="diagnostics-panel__overview">
        <h3>{DIAGNOSTICS_STRINGS.summarySectionTitle}</h3>
        <dl>
          <dt>地物数</dt>
          <dd data-testid="diagnostics-feature-count">{featureCount}</dd>
          <dt>{DIAGNOSTICS_STRINGS.fieldContextTime}</dt>
          <dd data-testid="diagnostics-current-time">{formatTimePoint(currentTime)}</dd>
          <dt>未保存の変更</dt>
          <dd data-testid="diagnostics-unsaved">{hasUnsavedChanges ? 'あり' : 'なし'}</dd>
        </dl>
      </section>

      <section className="diagnostics-panel__log">
        <h3>{DIAGNOSTICS_STRINGS.logSectionTitle}</h3>
        {/* N-34: ここは長らく固定の空文言を描いていた（ロガーもファイル沈め口も動いて
            いるのに表示側だけ未結線）。ホストがロガーを渡していれば記録済みのエラーを
            そのまま出す。ロガーが無い（渡されていない）ときは従来どおり空文言のまま。
            **記録時刻（実時間）と操作時の作中時刻を並べる**のは、どちらか一方では
            「いつ何をしていて起きたか」が復元できないため（教訓 5.15）。 */}
        {entries.length === 0 ? (
          <p data-testid="diagnostics-empty-log">{DIAGNOSTICS_STRINGS.emptyLog}</p>
        ) : (
          <ol className="diagnostics-panel__entries" data-testid="diagnostics-log">
            {entries.map((entry, index) => (
              <li
                key={`${String(entry.recordedAtMs)}:${String(index)}`}
                className="diagnostics-entry"
                data-testid="diagnostics-log-entry"
              >
                <div className="diagnostics-entry__head">
                  <span className="diagnostics-entry__level" data-testid="diagnostics-log-level">
                    {LOG_LEVEL_LABELS[entry.level]}
                  </span>
                  <span className="diagnostics-entry__at">
                    {formatTimestamp(entry.recordedAtMs)}
                  </span>
                  {entry.context.contextTime !== undefined && (
                    <span className="diagnostics-entry__at">
                      {DIAGNOSTICS_STRINGS.fieldContextTime}: {entry.context.contextTime}
                    </span>
                  )}
                </div>
                <div className="diagnostics-entry__message" data-testid="diagnostics-log-message">
                  {entry.message}
                </div>
                {entry.context.summary !== undefined && (
                  <div className="diagnostics-entry__meta">
                    {DIAGNOSTICS_STRINGS.fieldContext}: {entry.context.summary}
                  </div>
                )}
                {entry.context.cause !== undefined && (
                  <div className="diagnostics-entry__meta" data-testid="diagnostics-log-cause">
                    {DIAGNOSTICS_STRINGS.fieldCause}: {entry.context.cause}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="diagnostics-panel__privacy">{DIAGNOSTICS_STRINGS.privacyNote}</p>
    </HelpModal>
  );
}
