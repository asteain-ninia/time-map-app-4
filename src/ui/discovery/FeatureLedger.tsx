// 地物一覧（内部語では「台帳」。設計書 §C.5 / C4 / FR-111 = R9）。
//
// **これが直すもの**（現状分析 C4 / C5 / C10）:
//   - 775 行のフラットな名前一覧を **階層ツリー＋仮想スクロール** にする（G-7）
//   - 行が [色][展開][名前][種別][錨の本数][👁] を運ぶ（種別 = G-2 の受け口）
//   - **同名が複数あるときだけ**見分けを足す（〈親名〉→ 階層のみち → 通し番号と座標）
//   - **作業のまとまり（束）と「◀前へ 3/220 次へ▶」** で 220 件を順に片付けられる
//   - **その場編集**（名前・種別）。行を選ぶと素性欄へ行かずに直せる
//   - 「地物を検索」を絞り込み欄へ統合する（E-6。母集団の食い違い N-41 が消える）
//
// **行の高さは 28px 固定・折り返しなし**（設計書 §C.5）。仮想スクロールなので、
// 5,000 行でも DOM に載るのは窓に入るぶん＋前後 2 行だけである。
//
// **母集団は「現在時刻 / 通史」の 2 つのまま**（U-18 の裁定、§N-14 の (A)）。
// 「この年に変わったもの」は 3 つ目の選択肢ではなく、**作業のまとまりの既定の式**の 1 つ。
//
// **表示条件で隠した地物も行は消さない**（増分 4 の手直し B1 / 決定 (2)）。一覧は
// 「探す」ための場所なので、隠したものが消えると **隠したこと自体を取り消せなくなる**
// （設計書 §C.5「設定も解除もこの 1 か所」／ N-40 の再発）。行に 🚫 が付き、同じ
// ボタンで戻せる。地図に描くかどうかの判定そのものは描画・当たり判定と同じ 1 本
// （`hiddenReasonsUnderFilter`）で、ここに別の規則を書かない（教訓 5.29）。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { featureDisplayName } from '../../domain/feature';
import { buildForest, descendantIds, walkToRoot } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';

import { featuresAt, verticesAt } from '../live-lookup';
import { resolveDisplayFor } from '../map/display-resolution-cache';
import { hiddenReasonsUnderFilter } from '../map/filtered-display';
import type { OptionBarAction } from '../shell/option-bar';
import { canEdit } from '../shell/permissions';
import { EDIT_MODE } from '../state/session';
import { type SessionStore, TIME_CHANGE_SOURCE } from '../state/store';
import { formatTimePoint } from '../timeline/time-display';

import {
  BUNDLE_KIND,
  BUNDLE_PRESETS,
  DONE_CHANGE,
  buildBundle,
  bundleIndexOf,
  doneChangesOf,
  doneIdsOf,
  firstUnfinishedIndex,
  indexOfMember,
  nextUnfinishedIndex,
  stepIndex,
  unavailableMemberCount,
  type Bundle,
  type BundleCurrent,
  type BundleSource,
  type DoneChange,
} from './bundle';
import { KIND_LABEL_TOGGLE } from './filter-state';
import {
  LEDGER_ROW_HEIGHT,
  buildLedgerRows,
  foldForFilter,
  ledgerWindow,
  scrollTopForRow,
  type LedgerRow,
} from './ledger';
import { LEDGER_COMMAND, type LedgerCommandStore } from './ledger-commands';
import {
  anchorCountsOf,
  buildLedgerFeatures,
  duplicateNamedIds,
  representativePoints,
} from './ledger-source';
import type { LedgerFilterFocusStore } from './ledger-focus';
import { LEDGER_MODE } from './ledger-state';
import { BUNDLE_STRINGS, LEDGER_STRINGS } from './strings';
import { HIDDEN_REASON, type HiddenReason } from './visibility';

/** その場編集の結果。null なら通った、文字列なら断られた理由（G-20 / G-23 の共通枠へ）。 */
export type LedgerQuickEdit = (
  featureId: FeatureId,
  patch: { readonly name?: string; readonly kindLabel?: string },
) => string | null;

export interface FeatureLedgerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  /** 行を選んだら視点を合わせる（U-4）。 */
  readonly onFocusFeatureCamera?: (featureId: FeatureId) => void;
  /** その場編集（名前・種別）。合成ルートが `recordCommand` の 1 本へ繋ぐ。 */
  readonly onQuickEdit?: LedgerQuickEdit;
  /**
   * 拒否理由の共通枠（オプションバーの「次の一手」＋状態行）へ出す口。
   * **`null` を渡すと断りを取り下げる**（正しくやり直せたのに理由が残らないように）。
   */
  readonly onRefusal?: (
    message: string | null,
    actions?: readonly OptionBarAction[],
  ) => void;
  /**
   * 束の送りで次の地物を選んだあと、**素性欄の名前欄へ焦点を入れる**要求（設計書 §C.5）。
   * 器（素性欄）が持っている焦点を一覧が直接触らないための口。
   */
  readonly onFocusNameField?: () => void;
  /**
   * 絞り込み欄へ焦点を入れてほしい、という要求の口（Ctrl+F ＝「地物を検索」の行き先。
   * E-6）。**DOM を名前で探さない**ための細い口である（結合点 #3 の反省）。
   */
  readonly filterFocus?: LedgerFilterFocusStore;
  /**
   * 鍵盤・メニューからの指図（Alt+↑ / Alt+↓ / F2）の口（手直し B8）。
   * 合成ルートが `CommandRegistry` に繋ぐ。
   */
  readonly commands?: LedgerCommandStore;
}

/** 行の 👁 が押されたときに何をするか（手直し B1）。 */
type EyeAction =
  | { readonly kind: 'hide' }
  | { readonly kind: 'showIndividual' }
  | { readonly kind: 'showKindLabel'; readonly label: string }
  | { readonly kind: 'refuse'; readonly reason: string };

/** 「済」の説明（何を直したか。設計書 §H.1 の第一表記をここに置く）。 */
function doneTitleOf(change: DoneChange | null): string {
  switch (change) {
    case DONE_CHANGE.KindLabel:
      return LEDGER_STRINGS.doneTitleKindLabel;
    case DONE_CHANGE.Both:
      return LEDGER_STRINGS.doneTitleBoth;
    default:
      return LEDGER_STRINGS.doneTitleName;
  }
}

/** その行の 🚫 の説明（何で隠れていて、押すと何が起きるか）。 */
function hiddenTitleOf(reason: HiddenReason, kindLabel: string): string {
  switch (reason) {
    case HIDDEN_REASON.Individual:
      return LEDGER_STRINGS.hiddenTitleIndividual;
    case HIDDEN_REASON.KindLabel:
      return LEDGER_STRINGS.hiddenTitleKindLabel(kindLabel);
    case HIDDEN_REASON.Kind:
      return LEDGER_STRINGS.hiddenTitleKind;
    case HIDDEN_REASON.Depth:
      return LEDGER_STRINGS.hiddenTitleDepth;
  }
}

/**
 * 🚫 を押したときの行き先。
 *
 * **「設定も解除もこの 1 か所」**（設計書 §C.5）。個別に隠したものはそのまま戻し、
 * 種別（札）で隠れているものは **その札の［隠す］を外す**（行のボタンからしか
 * 辿れない利用者が、隠したことを取り消せなくならないように）。点線面・深さは
 * 1 件だけ戻すという意味が無い軸なので、断って「表示 ▾」へ案内する。
 */
function eyeActionOf(reason: HiddenReason | null, kindLabel: string): EyeAction {
  if (reason === null) return { kind: 'hide' };
  switch (reason) {
    case HIDDEN_REASON.Individual:
      return { kind: 'showIndividual' };
    case HIDDEN_REASON.KindLabel:
      return { kind: 'showKindLabel', label: kindLabel };
    case HIDDEN_REASON.Kind:
      return { kind: 'refuse', reason: LEDGER_STRINGS.showRefusedKind };
    case HIDDEN_REASON.Depth:
      return { kind: 'refuse', reason: LEDGER_STRINGS.showRefusedDepth };
  }
}

/** 一覧の行 1 つぶんの見た目。**28px 固定**なので中身は 1 行に収める。 */
function LedgerRowView(props: {
  readonly row: LedgerRow;
  readonly active: boolean;
  readonly editing: 'name' | 'kindLabel' | null;
  readonly onSelect: () => void;
  readonly onToggleExpand: () => void;
  readonly onEye: () => void;
  readonly onStartEdit: (field: 'name' | 'kindLabel') => void;
  readonly onCommitEdit: (field: 'name' | 'kindLabel', value: string) => void;
  readonly onCancelEdit: () => void;
}): JSX.Element {
  const {
    row,
    active,
    editing,
    onSelect,
    onToggleExpand,
    onEye,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
  } = props;
  const id = row.featureId as unknown as string;
  const hiddenTitle =
    row.hiddenReason === null ? null : hiddenTitleOf(row.hiddenReason, row.kindLabel);
  return (
    <div
      className="ledger__row"
      id={`ledger-row-${id}`}
      role="treeitem"
      aria-selected={active}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      data-testid={`ledger-row-${id}`}
      data-done={row.done ? 'true' : 'false'}
      data-hidden={row.hidden ? 'true' : 'false'}
      style={{ height: `${String(LEDGER_ROW_HEIGHT)}px` }}
    >
      <span
        className="ledger__color"
        data-testid={`ledger-color-${id}`}
        style={{ background: row.color }}
        aria-hidden="true"
      />
      <span
        className="ledger__indent"
        style={{ width: `${String(row.indent * 12)}px` }}
        aria-hidden="true"
      />
      {row.hasChildren ? (
        <button
          type="button"
          className="ledger__expander"
          data-testid={`ledger-expand-${id}`}
          aria-label={
            row.expanded
              ? LEDGER_STRINGS.collapseLabel(row.name)
              : LEDGER_STRINGS.expandLabel(row.name)
          }
          onClick={onToggleExpand}
        >
          {row.expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="ledger__expander ledger__expander--leaf" aria-hidden="true" />
      )}

      {editing === 'name' ? (
        <InlineInput
          testid={`ledger-name-input-${id}`}
          ariaLabel={LEDGER_STRINGS.renameAria(row.name)}
          initial={row.name}
          onCommit={(v) => onCommitEdit('name', v)}
          onCancel={onCancelEdit}
        />
      ) : (
        <button
          type="button"
          className="ledger__name"
          // T-1: 役割が同じ testid を持ち越す（一覧の行を選ぶ）。22 本の E2E がこれを使う。
          data-testid={`feature-list-item-${id}`}
          aria-pressed={active}
          title={row.qualifier === null ? row.name : `${row.name} ${row.qualifier}`}
          onClick={onSelect}
          // **読むだけでも同じ理由を出す**（手直し B11）。旧版は編集できないとき
          // ダブルクリックが黙って何もしなかったので、「壊れている」と読めた。
          onDoubleClick={() => onStartEdit('name')}
        >
          <span className="ledger__name-text">{row.name}</span>
          {row.qualifier !== null && (
            <span className="ledger__qualifier" data-testid={`ledger-qualifier-${id}`}>
              {row.qualifier}
            </span>
          )}
          {row.done && (
            <span
              className="ledger__done"
              data-testid={`ledger-done-${id}`}
              title={doneTitleOf(row.doneChange)}
            >
              {LEDGER_STRINGS.doneMark}
            </span>
          )}
        </button>
      )}

      {editing === 'kindLabel' ? (
        <InlineInput
          testid={`ledger-kind-input-${id}`}
          ariaLabel={LEDGER_STRINGS.kindLabelAria(row.name)}
          initial={row.kindLabel}
          onCommit={(v) => onCommitEdit('kindLabel', v)}
          onCancel={onCancelEdit}
        />
      ) : (
        <button
          type="button"
          className="ledger__kind"
          data-testid={`ledger-kind-${id}`}
          title={row.kindLabel}
          onClick={() => onStartEdit('kindLabel')}
        >
          {row.kindLabel}
        </button>
      )}

      <span
        className="ledger__anchors"
        data-testid={`ledger-anchors-${id}`}
        title={LEDGER_STRINGS.anchorCountTitle(row.anchorCount)}
      >
        {LEDGER_STRINGS.anchorCount(row.anchorCount)}
      </span>

      <button
        type="button"
        className="ledger__eye"
        data-testid={`ledger-eye-${id}`}
        aria-pressed={row.hidden}
        aria-label={
          row.hidden ? LEDGER_STRINGS.showLabel(row.name) : LEDGER_STRINGS.hideLabel(row.name)
        }
        {...(hiddenTitle === null ? {} : { title: hiddenTitle })}
        onClick={onEye}
      >
        {row.hidden ? '🚫' : '👁'}
      </button>
    </div>
  );
}

/** その場編集の入力欄。Enter で確定、Escape でやめる（値は親が確定させる）。 */
function InlineInput(props: {
  readonly testid: string;
  readonly ariaLabel: string;
  readonly initial: string;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { testid, ariaLabel, initial, onCommit, onCancel } = props;
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      className="ledger__inline-input"
      data-testid={testid}
      aria-label={ariaLabel}
      title={LEDGER_STRINGS.renameHint}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          onCommit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      onBlur={() => onCancel()}
    />
  );
}

export function FeatureLedger<S>(props: FeatureLedgerProps<S>): JSX.Element {
  const {
    store,
    getRoot,
    getTime,
    onFocusFeatureCamera,
    onQuickEdit,
    onRefusal,
    onFocusNameField,
    filterFocus,
    commands,
  } = props;

  // 購読するのは、行の中身が変わりうる入力だけ（教訓 5.6: 根と年は fresh に読む）。
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const activeFeature = useStore(store, (s) => s.activeFeature);
  const filter = useStore(store, (s) => s.filter);
  const displayControl = useStore(store, (s) => s.displayControl);
  const ledger = useStore(store, (s) => s.ledger);
  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const undoRedoNonce = useStore(store, (s) => s.undoRedoNonce);
  const projectLoadNonce = useStore(store, (s) => s.projectLoadNonce);

  const editable = canEdit(mode);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  /**
   * その場編集の下書き（増分 4 の手直し G1）。
   *
   * **始めたときの文脈（年・鍵・道具）を一緒に持つ。** 旧版は「どの地物のどの欄か」
   * しか持っていなかったので、**年 A で打ち始めて年 B へ移ってから Enter を押すと、
   * 年 A のつもりで打った名前が年 B へ保存された**（保存は「いま見ている年」に効く）。
   * 文脈が変わったら下書きは捨てる（K-5「一時的 UI 状態は全経路で破棄する」）。
   */
  const [editing, setEditing] = useState<{
    readonly featureId: FeatureId;
    readonly field: 'name' | 'kindLabel';
    readonly startedAt: TimePoint;
    readonly startedMode: string;
    readonly startedTool: string | null;
  } | null>(null);
  /** 束を作る前の式の下書き（画面に出して編集できる＝設計書 §C.5）。 */
  const [expressionDraft, setExpressionDraft] = useState<string>(
    BUNDLE_PRESETS[0]?.expression ?? '',
  );
  const [presetId, setPresetId] = useState<string>(BUNDLE_PRESETS[0]?.id ?? '');
  /** 一覧の状態行に出す知らせ（送りの回り込み・全部済んだ、など）。 */
  const [notice, setNotice] = useState<string | null>(null);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  // Ctrl+F（メニューの「地物を検索」）の行き先（E-6）。
  useEffect(() => {
    if (filterFocus === undefined) return;
    return filterFocus.subscribe(() => {
      const el = filterInputRef.current;
      if (el === null) return;
      el.focus();
      el.select();
    });
  }, [filterFocus]);

  // --- 母集団（現在時刻） -----------------------------------------------------
  //
  // **その年に居る地物ぜんぶ**が母集団である（手直し B1 / 決定 (2)）。表示条件で
  // 隠れているものは 🚫 を付けて残す ―― 消すと「隠したことを取り消す」導線が
  // 一覧から消えてしまう（設計書 §C.5「設定も解除もこの 1 か所」）。
  //
  // **`featuresAt` は 1 回だけ呼ぶ**（教訓 5.30 過剰計算の戒め）。母集団と親子関係を
  // 別々の memo で作ると、時刻を動かすたびに O(履歴 × 錨) の走査が 2 回走る
  // （`SidebarContent.test.tsx` の「featuresAt を 1 回だけ」がこれを固定している）。
  const { ledgerFeatures, forest, hiddenCount } = useMemo(() => {
    const root = getRoot();
    const time = getTime();
    const all = featuresAt(root, time);
    const resolution = resolveDisplayFor(root, time, displayControl);
    // 隠れている理由は **描画・当たり判定と同じ 1 本**（教訓 5.29）。まとめて 1 周で出す
    // （1 件ずつ問い合わせると件数の二乗になる）。
    const hiddenReasons = hiddenReasonsUnderFilter(resolution, filter, all);
    // 代表点は **重複名のものだけ**（実データで 12 件）。全件やると毎回 5 万頂点を走る。
    const dup = duplicateNamedIds(all);
    const points =
      dup.size === 0
        ? new Map<FeatureId, { lon: number; lat: number }>()
        : representativePoints(all, verticesAt(root, time), dup);
    return {
      ledgerFeatures: buildLedgerFeatures({
        features: all,
        anchorCounts: anchorCountsOf(root),
        hiddenReasons,
        points,
      }),
      // 親子関係も母集団と同じ集合で組む（隠した親のところで木が切れない）。
      forest: buildForest(all),
      hiddenCount: hiddenReasons.size,
    };
    // domain / currentTime は購読の門で、中身は getRoot / getTime から fresh に読む。
  }, [getRoot, getTime, domain, currentTime, filter, displayControl]);

  // --- 作業のまとまり ---------------------------------------------------------
  const bundle = ledger.bundle;
  /**
   * いまの名前・種別を id で引く表（手直し G8）。
   *
   * **配列を `find` で舐めない。** 束の「済」は全メンバーぶん引くので、5,000 件の
   * 束では 1 回の算出が 2,500 万回の比較になり、絞り込み・編集・時刻の変更のたびに
   * 右パネルが詰まる。表にすれば 1 周で済む。
   */
  const currentById = useMemo(() => {
    const out = new Map<FeatureId, BundleCurrent>();
    for (const f of ledgerFeatures) out.set(f.id, { name: f.name, kindLabel: f.kindLabel });
    return out;
  }, [ledgerFeatures]);
  const currentOf = useCallback(
    (featureId: FeatureId) => currentById.get(featureId),
    [currentById],
  );
  const doneChanges = useMemo(
    () =>
      bundle === null
        ? new Map<FeatureId, DoneChange>()
        : doneChangesOf(bundle, currentOf),
    [bundle, currentOf],
  );
  const doneIds = useMemo(() => new Set(doneChanges.keys()), [doneChanges]);
  /**
   * そのメンバーがいま選べるか（手直し G2）。**削除された地物・その年に居ない地物**は
   * 並びには残すが送りでは飛ばす ―― 飛ばさないと「次へ」で素性欄が空・カメラも動かない
   * 幽霊が選ばれ、しかも永久に済にならないので束が終わらない。
   */
  const memberAvailable = useCallback(
    (featureId: FeatureId): boolean => currentById.has(featureId),
    [currentById],
  );
  const unavailableCount = useMemo(
    () => (bundle === null ? 0 : unavailableMemberCount(bundle, memberAvailable)),
    [bundle, memberAvailable],
  );
  const bundleIndex = useMemo(
    () => (bundle === null ? undefined : bundleIndexOf(bundle)),
    [bundle],
  );

  // --- 行の組み立て -----------------------------------------------------------
  const built = useMemo(
    () =>
      buildLedgerRows({
        features: ledgerFeatures,
        forest,
        expanded: ledger.expanded,
        collapsed: ledger.collapsed,
        query: ledger.query,
        tree: ledger.tree,
        ...(bundleIndex !== undefined ? { bundleIndex } : {}),
        done: doneIds,
        doneChanges,
        onlyUnfinished: ledger.onlyUnfinished && bundle !== null,
      }),
    [
      ledgerFeatures,
      forest,
      ledger.expanded,
      ledger.collapsed,
      ledger.query,
      ledger.tree,
      ledger.onlyUnfinished,
      bundleIndex,
      doneIds,
      doneChanges,
      bundle,
    ],
  );

  // --- 通史（錨の一覧）--------------------------------------------------------
  //
  // **押せるかどうかは「その錨の年」で決める**（手直し G3）。旧版は現在時刻の表示条件で
  // 判定していたので、**いま存在しない地物の履歴行がすべて押せなかった** ―― 過去に
  // 消えた国や、まだ現れていない国の年へ飛べないという、通史の目的そのものを潰す形に
  // なっていた。行を押すとまずその年へ移るのだから、判定もその年で行う。
  const historyRows = useMemo(() => {
    if (ledger.mode !== LEDGER_MODE.History) return { rows: [], total: 0 };
    const root = getRoot();
    const query = foldForFilter(ledger.query.trim());
    let total = 0;
    const out: {
      readonly key: string;
      readonly anchorId: string;
      readonly featureId: FeatureId;
      readonly label: string;
      readonly hidden: boolean;
      readonly start: TimePoint;
    }[] = [];
    // 同じ年の錨がいくつも並ぶので、(年) ごとに解決を使い回す。
    const resolutionCache = new Map<string, ReturnType<typeof resolveDisplayFor>>();
    const resolutionAt = (at: TimePoint): ReturnType<typeof resolveDisplayFor> => {
      const key = formatTimePoint(at);
      const cached = resolutionCache.get(key);
      if (cached !== undefined) return cached;
      const resolved = resolveDisplayFor(root, at, displayControl);
      resolutionCache.set(key, resolved);
      return resolved;
    };
    for (const history of root.histories) {
      for (const entry of history.series.entries) {
        const owner = entry.anchor.snapshot.features.find((f) => f.id === history.featureId);
        const name =
          owner === undefined
            ? (history.featureId as unknown as string)
            : featureDisplayName(owner);
        const label = LEDGER_STRINGS.historyRowLabel(formatTimePoint(entry.start), name);
        total += 1;
        if (query !== '' && !foldForFilter(label).includes(query)) continue;
        const atStart = resolutionAt(entry.start);
        const hidden =
          hiddenReasonsUnderFilter(atStart, filter, atStart.features).get(history.featureId) !==
          undefined;
        out.push({
          key: `${history.featureId as unknown as string}:${entry.anchor.id as unknown as string}`,
          anchorId: entry.anchor.id as unknown as string,
          featureId: history.featureId,
          label,
          hidden,
          start: entry.start,
        });
      }
    }
    return { rows: out, total };
  }, [ledger.mode, ledger.query, getRoot, domain, filter, displayControl]);

  const isHistory = ledger.mode === LEDGER_MODE.History;
  const rowCount = isHistory ? historyRows.rows.length : built.rows.length;
  const win = ledgerWindow(rowCount, scrollTop, viewportHeight);

  // 窓の高さを測る（レイアウトのある環境だけ本当の値が入る。jsdom では 0 のままなので
  // `ledgerWindow` が先頭数行を返す＝教訓 5.49）。
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const measure = (): void => {
      setViewportHeight((prev) => (prev === el.clientHeight ? prev : el.clientHeight));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  // **母集団が縮んだら、スクロール位置も一緒に詰める**（手直し G4）。5,000 件の下端を
  // 見ているところで絞り込むと、`scrollTop` が行の総高さを超えたままになり、窓が
  // 「行の無いところ」を指して一瞬まっさらになる（教訓 5.5: 依存する状態は変化時に再検証）。
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const max = Math.max(0, rowCount * LEDGER_ROW_HEIGHT - viewportHeight);
    if (el !== null && el.scrollTop > max) el.scrollTop = max;
    setScrollTop((prev) => (prev > max ? max : prev));
  }, [rowCount, viewportHeight]);

  // **プロジェクトを開き直したら先頭へ**（手直し B10）。一覧のセッション状態は store が
  // 捨てるが、スクロール位置は画面側の状態なので、印を見て自分で戻す（K-5）。
  const loadNonceRef = useRef(projectLoadNonce);
  useLayoutEffect(() => {
    if (loadNonceRef.current === projectLoadNonce) return;
    loadNonceRef.current = projectLoadNonce;
    const el = scrollerRef.current;
    if (el !== null) el.scrollTop = 0;
    setScrollTop(0);
    setNotice(null);
    setEditing(null);
  }, [projectLoadNonce]);

  // --- 選ぶ -------------------------------------------------------------------
  const selectFeature = useCallback(
    (featureId: FeatureId): void => {
      store.getState().setActiveFeature(featureId);
      onFocusFeatureCamera?.(featureId);
    },
    [store, onFocusFeatureCamera],
  );

  /** 束のカーソルを `at` に置き、その地物を選び、視点を合わせ、名前欄へ焦点を入れる。 */
  const goToBundleIndex = useCallback(
    (at: number): void => {
      const s = store.getState();
      const b = s.ledger.bundle;
      if (b === null) return;
      const member = b.members[at];
      if (member === undefined) return;
      s.setBundleCursor(at);
      selectFeature(member.featureId);
      onFocusNameField?.();
    },
    [store, selectFeature, onFocusNameField],
  );

  // **閉じた親の下に居る地物を選んだら、親を開いて行を出す**（手直し B2）。
  // `expandLedgerPath` は用意されていたのに呼び出し元が 1 つも無く、Ctrl+P や束の送りで
  // 選んだ地物が **一覧に出てこなかった**（教訓 5.7 の型: 結線されていない完了トリガー）。
  // **1 つの地物につき 1 回だけ**開く（絞り込みで出ないときに永久に開き続けない）。
  const expandedForRef = useRef<FeatureId | null>(null);
  useEffect(() => {
    if (activeFeature === null || isHistory) {
      expandedForRef.current = null;
      return;
    }
    if (built.rows.some((r) => r.featureId === activeFeature)) return;
    if (expandedForRef.current === activeFeature) return;
    if (!currentById.has(activeFeature)) return;
    expandedForRef.current = activeFeature;
    const walk = walkToRoot(forest, activeFeature);
    const chain = walk.cyclic ? walk.cycle : walk.chain;
    const ancestors = chain.filter((id) => id !== activeFeature);
    if (ancestors.length === 0) return;
    store.getState().expandLedgerPath(ancestors);
  }, [activeFeature, built.rows, currentById, forest, isHistory, store]);

  // 行を画面に入れる（選択が変わったとき）。**束の送りで飛んだ先が窓の外だと、
  // 「次へ」を押しても何も動いていないように見える。**
  useEffect(() => {
    if (activeFeature === null || isHistory) return;
    const at = built.rows.findIndex((r) => r.featureId === activeFeature);
    if (at < 0) return;
    const el = scrollerRef.current;
    if (el === null) return;
    const next = scrollTopForRow(at, el.scrollTop, el.clientHeight);
    if (next !== el.scrollTop) el.scrollTop = next;
  }, [activeFeature, built.rows, isHistory]);

  // --- 束を作る ---------------------------------------------------------------
  const bundleSource = useCallback((): BundleSource => {
    const root = getRoot();
    const time = getTime();
    // 「手で印を付けたもの」の集合（`markedFeatures`）は **増分 7 で作る**。それまで
    // この既定は選べないようにしてある（`BUNDLE_PRESETS` の `available: false`）ので、
    // ここへは来ない。空集合を渡すのは、規則の網羅を崩さないためである。
    const marked = new Set<FeatureId>();
    // 「この地物の家族」＝ 親・自分・**子孫**（設計書 §C.5）。子だけでは家族にならない。
    const family = new Set<FeatureId>();
    const active = store.getState().activeFeature;
    if (active !== null) {
      family.add(active);
      for (const id of descendantIds(forest, active)) family.add(id);
      const parent = currentById.has(active)
        ? ledgerFeatures.find((f) => f.id === active)?.parentId
        : null;
      if (parent != null) family.add(parent);
    }
    const historyByFeature = new Map(root.histories.map((h) => [h.featureId, h]));
    return {
      features: ledgerFeatures.map((f) => ({
        id: f.id,
        name: f.name,
        kindLabel: f.kindLabel,
      })),
      historyOf: (featureId) => {
        const h = historyByFeature.get(featureId);
        if (h === undefined) return [];
        return h.series.entries.map((entry) => {
          const snap = entry.anchor.snapshot.features.find((f) => f.id === featureId);
          return {
            name: snap === undefined ? '' : featureDisplayName(snap),
            kindLabel: snap?.kindLabel ?? '',
          };
        });
      },
      changedThisYear: (featureId) => {
        const h = historyByFeature.get(featureId);
        if (h === undefined) return false;
        return h.series.entries.some((entry) => entry.start.year === time.year);
      },
      family,
      marked,
    };
  }, [getRoot, getTime, ledgerFeatures, currentById, forest, store]);

  const makeBundle = useCallback((): void => {
    const preset = BUNDLE_PRESETS.find((p) => p.id === presetId);
    const kind = preset?.kind ?? BUNDLE_KIND.Expression;
    // **空の式で全件のまとまりを作らせない**（手直し B11）。空の正規表現は何にでも
    // 当たるので、押した人の意図（「この形のものを集める」）と結果（775 件）が食い違う。
    if (kind === BUNDLE_KIND.Expression && expressionDraft.trim() === '') {
      onRefusal?.(BUNDLE_STRINGS.emptyExpression);
      return;
    }
    const built2 = buildBundle(
      {
        presetId: preset?.id ?? null,
        label: preset?.label ?? BUNDLE_STRINGS.label,
        kind,
        expression: kind === BUNDLE_KIND.Expression ? expressionDraft : '',
        // 作った日時（保存ファイルへ書く。判定には使わない＝手直し D）。
        createdAt: new Date().toISOString(),
      },
      bundleSource(),
    );
    if (!built2.ok) {
      onRefusal?.(built2.message);
      return;
    }
    if (built2.bundle.members.length === 0) {
      onRefusal?.(BUNDLE_STRINGS.emptyResult);
      return;
    }
    const s = store.getState();
    s.setBundle(built2.bundle);
    // **作れたら、前に出した断りを取り下げる**（手直し B11）。理由が残ったままだと、
    // 直したのに直っていないように読める（教訓 5.12 の裏面: 消す契機は意味を持つ
    // イベントに限る ―― 「同じ操作をやり直して通った」はまさにその契機である）。
    onRefusal?.(null);
    setNotice(null);
    // **束を作った瞬間に、先頭の未処理を選び、カメラを合わせ、名前欄に焦点を入れる**
    // （設計書 §C.5。旧版はここが未定義で V4 の第 1 手が止まっていた）。
    const done = doneIdsOf(built2.bundle, currentOf);
    const first = firstUnfinishedIndex(built2.bundle, done, memberAvailable);
    if (first === null) {
      setNotice(LEDGER_STRINGS.bundleAllDone);
      return;
    }
    s.setBundleCursor(first);
    const member = built2.bundle.members[first];
    if (member === undefined) return;
    selectFeature(member.featureId);
    onFocusNameField?.();
  }, [
    presetId,
    expressionDraft,
    bundleSource,
    store,
    currentOf,
    memberAvailable,
    selectFeature,
    onFocusNameField,
    onRefusal,
  ]);

  // 一覧の行を選んだら、その地物が束に居ればカーソルもそこへ合わせる。
  useEffect(() => {
    if (bundle === null || activeFeature === null) return;
    const at = indexOfMember(bundle, activeFeature);
    if (at === null || at === bundle.cursor) return;
    store.getState().setBundleCursor(at);
  }, [bundle, activeFeature, store]);

  /**
   * **Ctrl+Z で戻った地物へカーソルを移す**（設計書 §C.5）。
   *
   * **束のカーソルは取り消しの単位に含めない** ―― 取り消しはドメインのコマンドで、
   * カーソルは画面の状態である。だから「取り消しの結果を **追いかける**」形にする。
   *
   * 追いかけ方は **「済」が外れた地物を見る**。済は「作った時点の名前・種別と、いまの
   * 名前・種別が違うか」で導出しているので、改名を取り消すと自動的に未処理へ戻る。
   *
   * **ただし、取り消しが起きたときだけ働かせる**（手直し B5）。旧版は「済の集合が
   * 減った」だけを条件にしていたので、👁 や種別で行が母集団から消えただけでも発動し、
   * **取り消していないのに選択が飛んだ**。いまは母集団から行が消えないうえ、
   * `undoRedoNonce`（取り消し／やり直しが起きた印）が動いたときに限っている。
   */
  const prevDoneRef = useRef<ReadonlySet<FeatureId> | null>(null);
  const prevUndoNonceRef = useRef(undoRedoNonce);
  useEffect(() => {
    const prev = prevDoneRef.current;
    prevDoneRef.current = doneIds;
    const prevNonce = prevUndoNonceRef.current;
    prevUndoNonceRef.current = undoRedoNonce;
    if (bundle === null || prev === null) return;
    if (undoRedoNonce === prevNonce) return;
    // 済 → 未処理 へ戻ったものを、束の並びの順に探す。
    for (let i = 0; i < bundle.members.length; i += 1) {
      const member = bundle.members[i];
      if (member === undefined) continue;
      if (!prev.has(member.featureId) || doneIds.has(member.featureId)) continue;
      const s = store.getState();
      s.setBundleCursor(i);
      if (s.activeFeature !== member.featureId) s.setActiveFeature(member.featureId);
      // **ここで名前欄へ焦点を入れてはいけない。** 入れると、続けて Ctrl+Z を押しても
      // 打鍵が入力欄に食われて 2 回目以降の取り消しが効かなくなる（`focus-guard` は
      // 編集要素の上では大域ショートカットを立ち止まらせる）。実データの探索で
      // 「1 回目は戻るが 2 回目から戻らない」として捕まえた。設計書 §C.5 が求めている
      // のも「カーソルが戻った地物へ移る」ことだけである。
      return;
    }
  }, [doneIds, bundle, store, undoRedoNonce]);

  // --- 送り（◀ 前へ / 次へ ▶）------------------------------------------------
  //
  // **素性欄の Enter とまったく同じ規則（`stepIndex`）を通す**（手直し B11）。ここに
  // 別の進み方を書くと、同じ「次へ」が 2 通りになって食い違う（教訓 5.29）。
  const stepBundle = useCallback(
    (delta: number): void => {
      const b = store.getState().ledger.bundle;
      if (b === null) return;
      if (delta > 0) {
        const unfinished = nextUnfinishedIndex(b, doneIds, b.cursor, memberAvailable);
        if (unfinished === null) setNotice(LEDGER_STRINGS.bundleAllDone);
        else if (unfinished <= b.cursor) setNotice(LEDGER_STRINGS.bundleWrapped);
        else setNotice(null);
      } else {
        setNotice(null);
      }
      const at = stepIndex(b, doneIds, delta, memberAvailable);
      if (at === null) return;
      goToBundleIndex(at);
    },
    [store, doneIds, memberAvailable, goToBundleIndex],
  );

  // --- その場編集 -------------------------------------------------------------
  /**
   * 「読むだけ」の断りに **次の一手のボタン**を添える（手直し E1 / 設計書 §H.5）。
   * 文だけだと「では何をすればよいか」が残る ―― 鍵を開けるのがその 1 手である。
   */
  const unlockAction = useCallback(
    (): readonly OptionBarAction[] => [
      {
        id: 'ledger-unlock',
        label: LEDGER_STRINGS.unlockLabel,
        onClick: () => {
          store.getState().setMode(EDIT_MODE.Edit);
        },
      },
    ],
    [store],
  );

  const startEdit = useCallback(
    (featureId: FeatureId, field: 'name' | 'kindLabel'): void => {
      if (!editable) {
        // **読むだけでも同じ理由を出す**（手直し B11）。黙って何も起きないと、
        // 「読むだけだから」ではなく「壊れている」と読める。
        onRefusal?.(LEDGER_STRINGS.editRefusedViewOnly, unlockAction());
        return;
      }
      const s = store.getState();
      setEditing({
        featureId,
        field,
        startedAt: s.currentTime,
        startedMode: s.mode,
        startedTool: s.activeTool === null ? null : (s.activeTool as unknown as string),
      });
    },
    [editable, onRefusal, unlockAction, store],
  );

  /**
   * **文脈が変わったら下書きを捨てて、捨てたことを言う**（手直し G1 / K-5）。
   *
   * 捨てる契機は「年が動いた」「鍵が変わった」「道具が変わった」「対象が母集団から
   * 消えた」の 4 つ。**確認の板は出さない** ―― 素性欄の N-04 は 4 欄ぶんの打ちかけを
   * 守る仕掛けで、28px の 1 行の入力にモーダルを重ねるのは釣り合わない。失うのは
   * 打ちかけの数文字だけで、**間違った年へ保存される**という取り返しのつかない側は
   * これで完全に消える。捨てたことは断りの枠に出すので黙って消えることもない。
   */
  useEffect(() => {
    if (editing === null) return;
    const changed =
      editing.startedAt !== currentTime ||
      editing.startedMode !== mode ||
      editing.startedTool !== (activeTool === null ? null : (activeTool as unknown as string)) ||
      !currentById.has(editing.featureId);
    if (!changed) return;
    setEditing(null);
    onRefusal?.(LEDGER_STRINGS.editDiscardedContextChanged);
  }, [editing, currentTime, mode, activeTool, currentById, onRefusal]);

  const commitEdit = useCallback(
    (featureId: FeatureId, field: 'name' | 'kindLabel', value: string): void => {
      setEditing(null);
      if (!editable) {
        onRefusal?.(LEDGER_STRINGS.editRefusedViewOnly, unlockAction());
        return;
      }
      // **空の名前は断る**（手直し B11）。名前が空だと一覧が id を出す形になり、
      // 「名前を消した」のか「名前が引けなかった」のか画面から区別が付かない。
      if (field === 'name' && value.trim() === '') {
        onRefusal?.(LEDGER_STRINGS.renameEmpty);
        return;
      }
      if (onQuickEdit === undefined) return;
      const refusal = onQuickEdit(
        featureId,
        field === 'name' ? { name: value } : { kindLabel: value },
      );
      if (refusal !== null) onRefusal?.(refusal);
      else onRefusal?.(null);
    },
    [editable, onQuickEdit, onRefusal, unlockAction],
  );

  // --- 鍵盤（設計書 §I.2 / 手直し B8）----------------------------------------
  //
  // 増分 2 の錨表と同じ作法にする: **矢印で行を移り、← → で開閉し、Enter で選び、
  // F2 で改名する**。仮想スクロールなので窓の外の行は DOM に無い ―― だから焦点は
  // 行のボタンではなく **スクロールの器**に置き、`aria-activedescendant` で
  // 「いまどの行に居るか」を伝える（器は消えないので、送った先の行が窓の外でも
  // 続けて打鍵できる）。
  const moveTo = useCallback(
    (index: number): void => {
      const row = built.rows[index];
      if (row === undefined) return;
      scrollerRef.current?.focus();
      selectFeature(row.featureId);
    },
    [built.rows, selectFeature],
  );

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'F2') {
        const active = store.getState().activeFeature;
        if (active === null) return;
        e.preventDefault();
        startEdit(active, 'name');
        return;
      }
      if (isHistory) return;
      const active = store.getState().activeFeature;
      const at = active === null ? -1 : built.rows.findIndex((r) => r.featureId === active);
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveTo(at < 0 ? 0 : Math.min(at + 1, built.rows.length - 1));
          return;
        case 'ArrowUp':
          e.preventDefault();
          moveTo(at < 0 ? 0 : Math.max(at - 1, 0));
          return;
        case 'Home':
          e.preventDefault();
          moveTo(0);
          return;
        case 'End':
          e.preventDefault();
          moveTo(built.rows.length - 1);
          return;
        case 'ArrowRight': {
          const row = built.rows[at];
          if (row === undefined || !row.hasChildren || row.expanded) return;
          e.preventDefault();
          store.getState().toggleLedgerExpanded(row.featureId, false);
          return;
        }
        case 'ArrowLeft': {
          const row = built.rows[at];
          if (row === undefined) return;
          e.preventDefault();
          if (row.hasChildren && row.expanded) {
            store.getState().toggleLedgerExpanded(row.featureId, true);
            return;
          }
          // 開いていない行では **親へ上がる**（木の作法）。
          for (let i = at - 1; i >= 0; i -= 1) {
            const candidate = built.rows[i];
            if (candidate !== undefined && candidate.indent < row.indent) {
              moveTo(i);
              return;
            }
          }
          return;
        }
        case 'Enter': {
          const row = built.rows[at];
          if (row === undefined) return;
          e.preventDefault();
          selectFeature(row.featureId);
          return;
        }
        default:
          return;
      }
    },
    [built.rows, isHistory, moveTo, selectFeature, startEdit, store],
  );

  // メニュー・ショートカットからの指図（Alt+↑ / Alt+↓ / F2）。
  useEffect(() => {
    if (commands === undefined) return;
    return commands.subscribe((command) => {
      switch (command) {
        case LEDGER_COMMAND.BundlePrev:
          stepBundle(-1);
          return;
        case LEDGER_COMMAND.BundleNext:
          stepBundle(1);
          return;
        case LEDGER_COMMAND.Rename: {
          const active = store.getState().activeFeature;
          if (active === null) return;
          startEdit(active, 'name');
          return;
        }
      }
    });
  }, [commands, stepBundle, startEdit, store]);

  // --- 👁 / 🚫 ---------------------------------------------------------------
  const onEye = useCallback(
    (row: LedgerRow): void => {
      const action = eyeActionOf(row.hiddenReason, row.kindLabel);
      const s = store.getState();
      switch (action.kind) {
        case 'hide':
          s.setFeatureHidden(row.featureId, true);
          return;
        case 'showIndividual':
          s.setFeatureHidden(row.featureId, false);
          onRefusal?.(null);
          return;
        case 'showKindLabel':
          s.setKindLabelToggle(action.label, KIND_LABEL_TOGGLE.Hide, false);
          onRefusal?.(null);
          return;
        case 'refuse':
          onRefusal?.(action.reason);
          return;
      }
    },
    [store, onRefusal],
  );

  const total = isHistory ? historyRows.total : built.totalCount;
  const shown = isHistory ? historyRows.rows.length : built.matchCount;
  const filtering = ledger.query.trim() !== '';
  const footerText =
    notice ??
    (unavailableCount > 0
      ? BUNDLE_STRINGS.unavailableMembers(unavailableCount)
      : `${LEDGER_STRINGS.footer(shown, total, bundle === null ? null : doneIds.size)}${
          hiddenCount === 0 ? '' : LEDGER_STRINGS.hiddenCount(hiddenCount)
        }`);
  // **状態行は「言うことがあるときだけ」出す**（手直し A1）。件数は絞り込み欄の右に
  // もう出ているので、束も知らせも隠れた行も無いときは同じ数を 2 か所に置くだけの
  // 行になる。区画が低い窓では、この 1 行が行 1 つぶんの高さに相当する。
  const showFooter = notice !== null || bundle !== null || hiddenCount > 0;

  return (
    <div className="ledger" data-testid="unified-list" onKeyDown={onListKeyDown}>
      <div className="ledger__filter">
        <input
          ref={filterInputRef}
          type="search"
          className="ledger__filter-input"
          data-testid="unified-list-filter"
          aria-label={LEDGER_STRINGS.filterAria}
          placeholder={LEDGER_STRINGS.filterPlaceholder}
          value={ledger.query}
          onChange={(e) => store.getState().setLedgerQuery(e.target.value)}
        />
        <span className="ledger__count" data-testid="unified-list-count">
          {filtering
            ? LEDGER_STRINGS.countFiltered(shown, total)
            : LEDGER_STRINGS.countAll(total)}
        </span>
      </div>

      {/* **通史では作業のまとまりの帯を出さない**（手直し B9）。束は「その年に居る
          地物の並びを固定したもの」なので、通史の行（錨）とは母集団が違う。旧版は
          帯も送りも出ていたのに、押しても通史の一覧は 1 行も動かなかった。 */}
      {!isHistory && (
        <BundleBar
          bundle={bundle}
          presetId={presetId}
          expression={expressionDraft}
          onlyUnfinished={ledger.onlyUnfinished}
          onPreset={(id) => {
            setPresetId(id);
            const preset = BUNDLE_PRESETS.find((p) => p.id === id);
            setExpressionDraft(preset?.expression ?? '');
          }}
          onExpression={setExpressionDraft}
          onMake={makeBundle}
          onClear={() => {
            store.getState().setBundle(null);
            setNotice(null);
          }}
          onOnlyUnfinished={(v) => store.getState().setBundleOnlyUnfinished(v)}
          onStep={stepBundle}
        />
      )}

      <div className="ledger__modes" role="group" aria-label={LEDGER_STRINGS.modeAria}>
        <button
          type="button"
          className="ledger__mode"
          data-testid="list-mode-current"
          aria-pressed={!isHistory}
          onClick={() => store.getState().setLedgerMode(LEDGER_MODE.Current)}
        >
          {LEDGER_STRINGS.modeCurrentLabel}
        </button>
        <button
          type="button"
          className="ledger__mode"
          data-testid="list-mode-history"
          aria-pressed={isHistory}
          onClick={() => store.getState().setLedgerMode(LEDGER_MODE.History)}
        >
          {LEDGER_STRINGS.modeHistoryLabel}
        </button>
        <span className="ledger__modes-gap" aria-hidden="true" />
        <button
          type="button"
          className="ledger__mode"
          data-testid="list-shape-tree"
          aria-pressed={ledger.tree}
          title={LEDGER_STRINGS.treeTitle}
          onClick={() => store.getState().setLedgerTree(true)}
        >
          {LEDGER_STRINGS.treeLabel}
        </button>
        <button
          type="button"
          className="ledger__mode"
          data-testid="list-shape-flat"
          aria-pressed={!ledger.tree}
          title={LEDGER_STRINGS.flatTitle}
          onClick={() => store.getState().setLedgerTree(false)}
        >
          {LEDGER_STRINGS.flatLabel}
        </button>
      </div>

      {rowCount === 0 && !filtering && (
        <p className="ledger__empty" data-testid="unified-list-empty">
          {isHistory ? LEDGER_STRINGS.emptyAnchors : LEDGER_STRINGS.emptyFeatures}
        </p>
      )}
      {rowCount === 0 && filtering && (
        <p className="ledger__empty" data-testid="unified-list-no-match">
          {LEDGER_STRINGS.noMatch}
        </p>
      )}

      <div
        className="ledger__scroller"
        data-testid="ledger-scroller"
        ref={scrollerRef}
        tabIndex={0}
        role="tree"
        aria-label={LEDGER_STRINGS.filterAria}
        {...(activeFeature !== null && !isHistory
          ? { 'aria-activedescendant': `ledger-row-${activeFeature as unknown as string}` }
          : {})}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div
          className="ledger__spacer"
          style={{ height: `${String(win.totalHeight)}px` }}
        >
          <div
            className="ledger__window"
            style={{ transform: `translateY(${String(win.offsetY)}px)` }}
          >
            {isHistory
              ? historyRows.rows.slice(win.startIndex, win.endIndex).map((row) => (
                  <div
                    key={row.key}
                    className="ledger__row"
                    style={{ height: `${String(LEDGER_ROW_HEIGHT)}px` }}
                  >
                    <button
                      type="button"
                      className="ledger__name"
                      data-testid={`event-list-item-${row.anchorId}`}
                      disabled={row.hidden}
                      {...(row.hidden
                        ? { title: LEDGER_STRINGS.historyRowHiddenTitle }
                        : {})}
                      onClick={() => {
                        if (row.hidden) return;
                        const s = store.getState();
                        // **年を先に動かす**（手直し G3）。いま存在しない地物でも、
                        // その錨の年へ移れば居るので選べる。
                        s.setCurrentTime(row.start, TIME_CHANGE_SOURCE.AnchorSync);
                        s.setActiveFeature(row.featureId);
                        onFocusFeatureCamera?.(row.featureId);
                      }}
                    >
                      <span className="ledger__name-text">{row.label}</span>
                    </button>
                  </div>
                ))
              : built.rows.slice(win.startIndex, win.endIndex).map((row) => (
                  <LedgerRowView
                    key={row.featureId as unknown as string}
                    row={row}
                    active={activeFeature === row.featureId}
                    editing={
                      editing !== null && editing.featureId === row.featureId
                        ? editing.field
                        : null
                    }
                    onSelect={() => selectFeature(row.featureId)}
                    onToggleExpand={() =>
                      store.getState().toggleLedgerExpanded(row.featureId, row.expanded)
                    }
                    onEye={() => onEye(row)}
                    onStartEdit={(field) => startEdit(row.featureId, field)}
                    onCommitEdit={(field, value) => commitEdit(row.featureId, field, value)}
                    onCancelEdit={() => setEditing(null)}
                  />
                ))}
          </div>
        </div>
      </div>

      {showFooter && (
        <p className="ledger__footer" data-testid="ledger-footer">
          {footerText}
        </p>
      )}
    </div>
  );
}

/** 作業のまとまりの帯（選ぶ・式・まとめる・送り）。 */
function BundleBar(props: {
  readonly bundle: Bundle | null;
  readonly presetId: string;
  readonly expression: string;
  readonly onlyUnfinished: boolean;
  readonly onPreset: (id: string) => void;
  readonly onExpression: (expression: string) => void;
  readonly onMake: () => void;
  readonly onClear: () => void;
  readonly onOnlyUnfinished: (only: boolean) => void;
  readonly onStep: (delta: number) => void;
}): JSX.Element {
  const {
    bundle,
    presetId,
    expression,
    onlyUnfinished,
    onPreset,
    onExpression,
    onMake,
    onClear,
    onOnlyUnfinished,
    onStep,
  } = props;
  const preset = BUNDLE_PRESETS.find((p) => p.id === presetId);
  const isExpression = (preset?.kind ?? BUNDLE_KIND.Expression) === BUNDLE_KIND.Expression;
  return (
    <div className="ledger__bundle" data-testid="ledger-bundle">
      {/* **1 行に詰める。** 右パネルの列は時刻レールがまだ 112px に縮んでいないぶん
          低いので（増分 6）、見出しを 1 行減らすと行がそのぶん見える。 */}
      <div className="ledger__bundle-row">
        <select
          className="ledger__bundle-select"
          data-testid="bundle-preset"
          aria-label={BUNDLE_STRINGS.selectAria}
          value={presetId}
          onChange={(e) => onPreset(e.target.value)}
        >
          {BUNDLE_PRESETS.map((p) => (
            // **まだ作っていない既定は選べない**（手直し G5）。「手で印を付けたもの」は
            // 印を付ける手段そのものが増分 7 なので、選べると必ず 0 件で断られる
            // （押しても何も起きないボタン ＝ C9 の②）。
            <option key={p.id} value={p.id} disabled={p.available === false}>
              {p.available === false ? BUNDLE_STRINGS.presetUnavailable(p.label) : p.label}
            </option>
          ))}
        </select>
        {isExpression && (
          <input
            type="text"
            className="ledger__bundle-expression"
            data-testid="bundle-expression"
            aria-label={BUNDLE_STRINGS.expressionAria}
            placeholder={BUNDLE_STRINGS.expressionPlaceholder}
            value={expression}
            onChange={(e) => onExpression(e.target.value)}
          />
        )}
        <button
          type="button"
          className="ledger__bundle-make"
          data-testid="bundle-make"
          title={BUNDLE_STRINGS.makeTitle}
          onClick={onMake}
        >
          {BUNDLE_STRINGS.makeLabel}
        </button>
      </div>
      {/* **送りの行は、まとまりがあるときだけ出す。** 束が無ければ「◀前へ 0/0 次へ▶」は
          意味が無く、常に無効なボタンを並べることになる（C9 の②「押しても何も起きない
          ボタンを置かない」）。右パネルの列が低いあいだ（増分 6 まで）は、1 行減ることが
          そのまま見える行数になる。 */}
      {bundle !== null && (
        <div className="ledger__bundle-row">
          <button
            type="button"
            className="ledger__bundle-step"
            data-testid="bundle-prev"
            onClick={() => onStep(-1)}
          >
            {BUNDLE_STRINGS.prevLabel}
          </button>
          <span className="ledger__bundle-position" data-testid="bundle-position">
            {BUNDLE_STRINGS.position(bundle.cursor + 1, bundle.members.length)}
          </span>
          <button
            type="button"
            className="ledger__bundle-step"
            data-testid="bundle-next"
            onClick={() => onStep(1)}
          >
            {BUNDLE_STRINGS.nextLabel}
          </button>
          <label className="ledger__bundle-only">
            <input
              type="checkbox"
              data-testid="bundle-only-unfinished"
              checked={onlyUnfinished}
              onChange={(e) => onOnlyUnfinished(e.target.checked)}
            />
            <span>{BUNDLE_STRINGS.onlyUnfinishedLabel}</span>
          </label>
          <button
            type="button"
            className="ledger__bundle-step"
            data-testid="bundle-clear"
            onClick={onClear}
          >
            {BUNDLE_STRINGS.clearLabel}
          </button>
        </div>
      )}
    </div>
  );
}
