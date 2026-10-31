// UI layer (U40 wiring): the React mount for the live right-click context menu.
//
// ROOT FIX (bughunt2: FR-96 の右クリックメニュー未結線) — the bridge between the
// imperative {@link createLiveContextMenuPort} (called from the dispatcher inside
// onMapMount, off the React render path 技術方針 2.3) and the menu UI. It holds the
// open-request in React state, hands the imperative side a stable `open` callback via a
// ref, and renders the menu — bound to the LIVE registry + session mode.
//
// TWO RENDER PATHS (App 非接触フェーズ — additive props):
//   • DYNAMIC (composeFor supplied): the FR-96 本結線. On open it composes the U36
//     {@link ContextMenuModel} for the request and renders its items (削除/プロパティ編集/
//     分割/所属変更/結合(グレー)/共有解除) with each item's own enabled/disableReason
//     (FR-115), firing onSelectItem → dispatchMenuItem on click. A trailing view-axis
//     command (表示専用モード切替) stays reachable through the SAME registry gate the menu
//     bar uses (教訓 5.13). A NO_MENU (view-only / nothing actionable) opens nothing.
//   • LEGACY (composeFor absent — the current App call): the pre-existing 2-item static
//     {@link ContextMenu} render, UNCHANGED, so App compiles + behaves exactly as before
//     until the wiring phase supplies composeFor/onSelectItem.
//
// SHELL NOTE (段階1, 設計のみ報告): the ideal end-state extends the shell `ContextMenu`
// item model to a discriminated union (command | action) so ONE close behaviour serves
// both. That edit is the shell owner's (触るな src/ui/shell/**); until it lands the
// DYNAMIC path renders its own list here with a mirrored dismiss effect (Escape /
// outside-pointerdown), clearly the transitional shape.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useStore } from 'zustand';

import { ContextMenu, type ContextMenuItem } from '../shell/ContextMenu';
import { useMenuInWindow } from '../shell/useMenuInWindow';
import { COMMAND_ID, type CommandRegistry } from '../shell/commands';
import { resolveCommandEnabled } from '../shell/permissions';
import { MENU_ITEM_LABELS } from '../shell/strings';
import type { OptionBarCommitButton, OptionBarStore } from '../shell/option-bar';
import {
  NO_MENU,
  disableReasonMessage,
  type ContextMenuModel,
  type MenuItemKind,
  type NoMenu,
} from '../../domain/context-menu/index';
import type { EditMode } from '../state/session';
import type { createSessionStore } from '../state/store';
import type { ContextMenuRequest } from './live-context-menu-port';

/**
 * 「この線を消す」の 1 項目（増分 8C / 設計書 §E.1 V15）。測量 1 回ぶん ―― 消えるのは
 * 正距円筒の線と大円の線の 2 本セット。文字は呼び出し側（`ui/survey/survey-menu.ts`）が作る。
 */
export interface SurveyLineMenuEntry {
  readonly lineId: number;
  readonly label: string;
}

/**
 * The opener the imperative port drives. Held behind a ref by the composition root
 * and pointed at this mount's `open` setter on first render, the SAME late-binding
 * pattern the camera-input bridge uses (App.tsx cameraInputRef).
 */
export interface ContextMenuOpener {
  open: (request: ContextMenuRequest) => void;
}

/** Compose the U36 model for a right-click request (App supplies the live lookups). */
export type ComposeContextMenuFor = (request: ContextMenuRequest) => ContextMenuModel | NoMenu;

/** Route a chosen domain item to its host effect (App supplies the dispatch router). */
export type OnSelectMenuItem = (itemKind: MenuItemKind, model: ContextMenuModel) => void;

export interface MapContextMenuProps<S> {
  readonly store: ReturnType<typeof createSessionStore<S>>;
  readonly registry: CommandRegistry;
  /**
   * Register this mount's `open` callback with the composition root (assigned to
   * the opener ref the live port reads). Returns an unbind for unmount so a stale
   * setter is never called after teardown (教訓 5.2 全経路で破棄).
   */
  readonly bindOpener: (opener: ContextMenuOpener | null) => void;
  /**
   * DYNAMIC path (FR-96 本結線). When supplied, the menu is composed per request and
   * its domain items are rendered/dispatched. Absent ⇒ the LEGACY static render (App
   * 非接触: the current call omits it, so behaviour is unchanged).
   */
  readonly composeFor?: ComposeContextMenuFor;
  /** DYNAMIC path: called with the chosen item + the frozen model (dispatch routing). */
  readonly onSelectItem?: OnSelectMenuItem;
  /**
   * Codex F1a — the menu-open SUSPENSION boundary (the onDrawingChange 同型 the tool
   * controllers use): reports `true` while a menu entry is open and `false` when it
   * closes OR the mount unmounts (教訓 5.2 全経路で破棄). The App ORs it into
   * `shortcutsSuspended`, so the global shortcut dispatcher STANDS DOWN while a menu
   * owns the screen — a Ctrl+Z through an open menu could delete the very target the
   * frozen model still offers (stale EditProperties 再現経路). The menu's own Escape
   * is capture-phase and suspension-independent, so「Escape はメニューを閉じるだけ」
   * は保たれる.
   */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * **道具の局面の項目**（設計書 §I.3 の「（下書き中なら）ここで確定・取り消し」。
   * 増分 5 からの送り）。
   *
   * 中身は **オプションバーの確定欄そのもの**を読む ―― 手順のある 5 道具と追加の
   * 3 道具は、自分の［○○を確定］［やめる］をそこへ押し込んでいる。写しを作らず
   * その 1 本を出すので、道具を足しても右クリックの側を直す必要が無い（教訓 5.29 /
   * 5.44）。下書きが無い局面では確定欄が空なので、項目も出ない。
   *
   * **「この点を消す」は出さない**（実装者の判断。配下 README の B-3 に載せた）――
   * ［1 つ戻す］は確定欄ではなく設定欄の差し込みで、`ReactNode` なので写せない。
   * その操作は下書きを持っているあいだ `Ctrl+Z` が受け持っており（設計書 §D.4.1 の
   * `tool-drawing` の行）、打鍵の無い確定・取りやめとは事情が違う。
   */
  readonly optionBar?: OptionBarStore | undefined;
  /**
   * **測量の線の項目**（増分 8C / 設計書 §E.1 V15）。右クリックが測量の線に当たったとき
   * （要求の `surveyLineIds` が空でないとき）だけ呼び、返った項目を **開いた瞬間に凍結**して
   * 先頭に並べる（ほかの項目の模型と同じ規律 ―― 開いてから線が増減しても並びは変わらない）。
   * 当たった線が 2 本以上なら測量ごとに 1 項目ずつ並べ、どれか 1 つに決めない。
   *
   * 省略 ⇒ 測量の線の項目は出さない（従来どおり）。地物の項目と違って **読むだけでも出す**
   * （測るのは編集ではない＝設計書 §C.3）。
   *
   * 要求が線に当たっているときは、渡されていてもいなくても **地物の項目（`composeFor`）は
   * 組まない**（増分 8C の手直し）。
   */
  readonly surveyItemsFor?: ((lineIds: readonly number[]) => readonly SurveyLineMenuEntry[]) | undefined;
  /** 「この線を消す」を押したとき（凍結した id を渡す。もう無い id なら呼ばれた側が何もしない）。 */
  readonly onRemoveSurveyLine?: ((lineId: number) => void) | undefined;
}

/** 測量の線の項目が無いとき（同一性を保つ）。 */
const NO_SURVEY_ITEMS: readonly SurveyLineMenuEntry[] = [];

/**
 * The map-right-click LEGACY item set: the command ids relevant to a feature on the map
 * (削除 / 表示専用モード切替), re-using the SAME ids + labels the menu bar uses (単一真実源,
 * 教訓 5.19). Only used when `composeFor` is absent.
 */
const MAP_MENU_ITEMS: readonly ContextMenuItem[] = [
  { commandId: COMMAND_ID.EditDelete, label: MENU_ITEM_LABELS[COMMAND_ID.EditDelete] },
  {
    commandId: COMMAND_ID.ViewToggleViewMode,
    label: MENU_ITEM_LABELS[COMMAND_ID.ViewToggleViewMode],
  },
];

/** 帯が渡されていないときの購読解除（`useSyncExternalStore` は関数を要求する）。 */
const NO_OPTION_BAR_UNSUBSCRIBE = (): void => {
  /* 帯が無い ⇒ 道具の局面の項目も無い */
};
/** 帯が無いときの確定欄（同一性を保つ）。 */
const NO_COMMIT_BUTTONS: readonly OptionBarCommitButton[] = [];

/** One open-menu entry: the request plus the (frozen-at-open) composed model, if any. */
interface MenuEntry {
  readonly request: ContextMenuRequest;
  /**
   * The composed model, or `null`. `null` means the legacy static render (composeFor
   * absent) OR a dynamic NO_MENU (composeFor present but nothing actionable) — the two
   * are told apart in render by whether `composeFor` was supplied. A dynamic NO_MENU
   * STILL opens: the view-axis command (表示専用モード切替) stays available so a view-only
   * right-click can return to editing, matching the legacy always-a-menu behaviour.
   */
  readonly model: ContextMenuModel | null;
  /** 開いた瞬間に凍結した「この線を消す」の項目（増分 8C）。当たっていなければ空。 */
  readonly surveyItems: readonly SurveyLineMenuEntry[];
}

export function MapContextMenu<S>(props: MapContextMenuProps<S>): JSX.Element | null {
  const { store, registry, bindOpener, composeFor, onSelectItem, onOpenChange } = props;
  const optionBar = props.optionBar;
  const surveyItemsFor = props.surveyItemsFor;
  const onRemoveSurveyLine = props.onRemoveSurveyLine;
  const mode = useStore(store, (s) => s.mode);
  const [entry, setEntry] = useState<MenuEntry | null>(null);

  // Codex F1a: mirror the open/closed boundary up (the tool controllers'
  // onDrawingChange pattern). Cleanup clears the flag on close AND unmount so a
  // torn-down mount never leaves the global dispatcher suspended (教訓 5.2).
  const menuOpen = entry !== null;
  useEffect(() => {
    if (onOpenChange === undefined) return;
    onOpenChange(menuOpen);
    return () => onOpenChange(false);
  }, [menuOpen, onOpenChange]);

  const open = useCallback(
    (req: ContextMenuRequest): void => {
      if (composeFor === undefined) {
        setEntry({ request: req, model: null, surveyItems: NO_SURVEY_ITEMS }); // legacy static render
        return;
      }
      // 増分 8C: 測量の線に当たっていれば、その項目も同じ瞬間に凍結する。
      const lineIds = req.surveyLineIds ?? [];
      // Freeze the model AT OPEN so a later store change cannot drift the menu (the
      // dispatch's findItem/enabled guard is the second防御, dispatch.ts). A NO_MENU
      // still opens (model: null) so the trailing view command is shown (item 5).
      //
      // **線に当たった右クリックでは地物の模型を組まない**（増分 8C の手直し / 反証 #1）。
      // 線に当たると地物を昇格しない（押した相手は線）ので、組めば項目は **押していない、
      // いま選んでいる別の地物** に向く。出すのは線の項目・道具の局面の項目・見る側の項目だけ。
      const composed = lineIds.length === 0 ? composeFor(req) : NO_MENU;
      const surveyItems =
        lineIds.length === 0 || surveyItemsFor === undefined
          ? NO_SURVEY_ITEMS
          : surveyItemsFor(lineIds);
      setEntry({
        request: req,
        model: composed.kind === 'menu' ? composed : null,
        surveyItems,
      });
    },
    [composeFor, surveyItemsFor],
  );

  // Hand the stable opener to the composition root (the live port reads it through a
  // ref). Unbind on unmount so the imperative side never calls a torn-down setter.
  const opener = useMemo<ContextMenuOpener>(() => ({ open }), [open]);
  useEffect(() => {
    bindOpener(opener);
    return () => bindOpener(null);
  }, [bindOpener, opener]);

  // STABLE close callback (fr96 結線バグ修正): the dynamic menu's dismiss effect keys
  // its window listeners on `onClose`. An inline closure changed identity on EVERY
  // parent re-render, so when the SAME keydown that should close the menu ALSO
  // triggered a global shortcut that re-rendered the App (Escape → EditDeselect →
  // clearSelection), React's effect cleanup REMOVED the menu's keydown listener
  // mid-dispatch and re-added it — a listener removed during dispatch never fires, so
  // the menu stayed open (実機 e2e で検出). A stable useCallback keeps the listeners
  // registered once per open (教訓 5.2 全経路で破棄 — but never mid-dispatch).
  const onClose = useCallback((): void => setEntry(null), []);

  if (entry === null) return null;

  // LEGACY static path (composeFor absent) — the pre-existing render, unchanged.
  if (composeFor === undefined) {
    return (
      <ContextMenu
        x={entry.request.clientX}
        y={entry.request.clientY}
        items={MAP_MENU_ITEMS}
        registry={registry}
        mode={mode}
        onClose={onClose}
      />
    );
  }

  // DYNAMIC path — the composed domain items (empty when NO_MENU) + a trailing view command.
  return (
    <DynamicContextMenu
      request={entry.request}
      model={entry.model}
      registry={registry}
      mode={mode}
      onClose={onClose}
      onSelectItem={onSelectItem}
      optionBar={optionBar}
      surveyItems={entry.surveyItems}
      onRemoveSurveyLine={onRemoveSurveyLine}
    />
  );
}

/** 二重クリックとみなす間隔（ms）と、2 回目の押した場所のずれの許容（px）。OS の既定に合わせる。 */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 4;

/**
 * **項目を二重クリックしたときの 2 回目を飲み込む**（増分 8C の手直し / 反証 #4）。
 *
 * 項目は 1 回目のクリックで実行してメニューを閉じるので、2 回目は **閉じたあとの地図** に
 * 落ちる。測っている間は地図の左クリックが測量の点になるので、「この線を消す」を二重クリック
 * すると線が消えたうえに始点が置かれ、始点を置いた途中は大域の打鍵が止まる（`U` も効かない）。
 * 1 回目と同じ場所（{@link DOUBLE_CLICK_SLOP_PX} 以内）で {@link DOUBLE_CLICK_MS} 以内に来た
 * 次の左ボタンの押下を、その押下が起こす離し・クリックごと捕捉段で止める。条件に合わない押下が
 * 来たら、それは飲まずに見張りをやめる（関係のないクリックを奪わない）。鍵盤で項目を押した
 * （`detail` が 0）ときは見張らない。
 */
function swallowSecondClickOf(e: ReactMouseEvent<HTMLElement>): void {
  if (e.detail === 0) return;
  const maybeView = e.currentTarget.ownerDocument.defaultView;
  if (maybeView === null) return;
  const view: Window = maybeView;
  const x = e.clientX;
  const y = e.clientY;
  const startedAt = e.timeStamp;
  let swallowing = false;
  const stop = (ev: Event): void => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  const onDown = (ev: PointerEvent): void => {
    const near =
      Math.abs(ev.clientX - x) <= DOUBLE_CLICK_SLOP_PX &&
      Math.abs(ev.clientY - y) <= DOUBLE_CLICK_SLOP_PX;
    // 2 回目を飲み込み終えたあとの押下（3 回目）や、条件に合わない押下は通して見張りをやめる。
    if (swallowing || ev.button !== 0 || !near || ev.timeStamp - startedAt > DOUBLE_CLICK_MS) {
      cleanup();
      return;
    }
    swallowing = true;
    stop(ev);
  };
  // 飲み込んだ押下に続く離し・クリック・二重クリックの知らせも止める。二重クリックの知らせは
  // クリックと同じ流れの中で続けて来るので、クリックのあと次の順番が回ってきたら見張りをやめる。
  const onFollow = (ev: Event): void => {
    if (!swallowing) return;
    stop(ev);
    if (ev.type === 'click') view.setTimeout(() => cleanup(), 0);
    if (ev.type === 'dblclick') cleanup();
  };
  const FOLLOW = ['pointerup', 'mousedown', 'mouseup', 'click', 'dblclick'] as const;
  const timer = view.setTimeout(() => cleanup(), DOUBLE_CLICK_MS + 500);
  function cleanup(): void {
    view.clearTimeout(timer);
    view.removeEventListener('pointerdown', onDown, true);
    for (const type of FOLLOW) view.removeEventListener(type, onFollow, true);
  }
  view.addEventListener('pointerdown', onDown, true);
  for (const type of FOLLOW) view.addEventListener(type, onFollow, true);
}

interface DynamicContextMenuProps {
  readonly request: ContextMenuRequest;
  /** The composed model, or `null` for a NO_MENU (only the trailing view command shows). */
  readonly model: ContextMenuModel | null;
  readonly registry: CommandRegistry;
  readonly mode: EditMode;
  readonly onClose: () => void;
  readonly onSelectItem: OnSelectMenuItem | undefined;
  /** 道具の局面の項目の出どころ（オプションバーの確定欄）。 */
  readonly optionBar: OptionBarStore | undefined;
  /** 凍結した「この線を消す」の項目（増分 8C）。 */
  readonly surveyItems: readonly SurveyLineMenuEntry[];
  readonly onRemoveSurveyLine: ((lineId: number) => void) | undefined;
}

/**
 * The DYNAMIC (composeFor) menu render. Mirrors the shell `ContextMenu` primitive's
 * close契機 (Escape / deferred outside-pointerdown) and positioning; renders each
 * composed U36 item as an action button (enabled/disabled + FR-115 disable reason
 * tooltip), plus the 表示専用モード切替 view command gated through the SAME
 * resolveCommandEnabled the menu bar uses (教訓 5.13). Transitional until 段階1 folds
 * this into the shell primitive as an item variant.
 */
function DynamicContextMenu(props: DynamicContextMenuProps): JSX.Element {
  const { request, model, registry, mode, onClose, onSelectItem } = props;
  const { surveyItems, onRemoveSurveyLine } = props;
  const placed = useMenuInWindow(request.clientX, request.clientY);
  // **道具の局面の項目**（増分 5 からの送り / 設計書 §I.3）。オプションバーの確定欄を
  // そのまま項目にする ―― 「開くのに中身が無い」を減らし、写しも作らない。
  const optionBar = props.optionBar;
  const toolCommit = useSyncExternalStore(
    (onChange) => (optionBar === undefined ? NO_OPTION_BAR_UNSUBSCRIBE : optionBar.subscribe(onChange)),
    () => optionBar?.get().commit ?? NO_COMMIT_BUTTONS,
    () => optionBar?.get().commit ?? NO_COMMIT_BUTTONS,
  );

  // Close契機 mirrors ContextMenu.tsx (Escape + deferred outside pointerdown).
  //
  // Escape is CAPTURED (window capture phase) and stopped: while the menu is open it
  // owns Escape — closing the menu, NOT deselecting. The global shortcut dispatcher
  // (useShortcuts, a window BUBBLE listener) would otherwise run EditDeselect on the
  // SAME keypress and wipe the very selection the right-click just promoted (段階7
  // 優先規則の鍵盤版: the top-most surface owns the key, 教訓 5.13). Capture runs
  // before every bubble listener, so the priority holds regardless of registration
  // order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (): void => onClose();
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  /**
   * **いつ右クリックしても押せる「見る」側の項目**（増分 5 の手直し E3 / バグ狩り #20。
   * 設計書 §I.3 の原則①「いつでも開ける ―― 中身が変わるだけ」）。
   *
   * 旧版はここに鍵のトグル 1 個しか置いていなかったので、**選んでいない場所や、道具で
   * 作図している最中に右クリックすると、項目が 1 個しかない板が出た** ―― 開くのに
   * 中身が無いのは「開ける」と言えない。地物に依らない見る操作（全体表示・拡大・縮小）は
   * どの局面でも意味があるので、常に並べる。可否は **メニューバーと同じ 1 本**
   * （`resolveCommandEnabled`）を通す（教訓 5.13）。
   */
  const viewAxisCommands = [
    COMMAND_ID.ViewFitAll,
    COMMAND_ID.ViewZoomIn,
    COMMAND_ID.ViewZoomOut,
    COMMAND_ID.ViewToggleViewMode,
  ] as const;

  return (
    <ul
      role="menu"
      className="context-menu"
      data-testid="context-menu"
      ref={placed.ref}
      style={placed.style}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 増分 8C（設計書 §E.1 V15）: 右クリックが測量の線に当たったときの「この線を消す」。
          **いちばん先頭に置く** ―― 押した相手そのもの（線は地物より上に描かれている）に
          対する操作だからである。当たった線が 2 本以上なら測量ごとに 1 項目ずつ並ぶ。
          線に当たったときは地物の項目は組まれない（`open` を見よ。model は null）。 */}
      {surveyItems.map((item) => (
        <li key={`survey-${String(item.lineId)}`} role="none">
          <button
            type="button"
            role="menuitem"
            className="context-menu__item"
            data-testid="context-menu-item"
            data-survey-line-id={item.lineId}
            onClick={(e) => {
              swallowSecondClickOf(e);
              onRemoveSurveyLine?.(item.lineId);
              onClose();
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
      {/* 道具が下書きを持っている局面の項目（確定・やめる）。**先頭に置く** ――
          その局面でいちばん近い次の一手だからである。 */}
      {toolCommit.map((button) => (
        <li key={`tool-${button.id}`} role="none">
          <button
            type="button"
            role="menuitem"
            className="context-menu__item"
            data-testid="context-menu-item"
            data-tool-commit={button.id}
            disabled={button.disabled === true}
            aria-disabled={button.disabled === true}
            onClick={(e) => {
              swallowSecondClickOf(e);
              if (button.disabled === true) return;
              button.onClick();
              onClose();
            }}
          >
            {button.label}
          </button>
        </li>
      ))}
      {(model?.items ?? []).map((item) => {
        const disabledTitle = item.enabled ? undefined : disableReasonMessage(item.disableReason);
        return (
          <li key={item.kind} role="none">
            <button
              type="button"
              role="menuitem"
              className="context-menu__item"
              data-testid="context-menu-item"
              data-item-kind={item.kind}
              disabled={!item.enabled}
              aria-disabled={!item.enabled}
              title={disabledTitle}
              onClick={(e) => {
              swallowSecondClickOf(e);
                if (!item.enabled || model === null) return;
                onSelectItem?.(item.kind, model);
                onClose();
              }}
            >
              {item.label}
            </button>
          </li>
        );
      })}
      {/* 「見る」側の項目は局面に依らず並べる（教訓 5.13 の権限の関門は通す）。 */}
      {viewAxisCommands.map((commandId) => {
        const enabled = resolveCommandEnabled(commandId, {
          runnable: registry.isRunnable(commandId),
          mode,
        });
        return (
          <li key={commandId} role="none">
            <button
              type="button"
              role="menuitem"
              className="context-menu__item"
              data-testid="context-menu-item"
              data-command={commandId}
              disabled={!enabled}
              aria-disabled={!enabled}
              onClick={(e) => {
              swallowSecondClickOf(e);
                if (!enabled) return;
                registry.dispatch(commandId);
                onClose();
              }}
            >
              {MENU_ITEM_LABELS[commandId]}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
