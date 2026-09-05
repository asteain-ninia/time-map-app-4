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
import { buildForest } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';

import { featuresAt, verticesAt } from '../live-lookup';
import { resolveDisplayFor } from '../map/display-resolution-cache';
import { isFeatureVisibleUnderFilter } from '../map/filtered-display';
import { canEdit } from '../shell/permissions';
import { type SessionStore, TIME_CHANGE_SOURCE } from '../state/store';
import { formatTimePoint } from '../timeline/time-display';

import {
  BUNDLE_KIND,
  BUNDLE_PRESETS,
  buildBundle,
  bundleIndexOf,
  doneIdsOf,
  firstUnfinishedIndex,
  indexOfMember,
  nextUnfinishedIndex,
  type Bundle,
  type BundleSource,
} from './bundle';
import {
  LEDGER_ROW_HEIGHT,
  buildLedgerRows,
  ledgerWindow,
  scrollTopForRow,
  type LedgerRow,
} from './ledger';
import {
  anchorCountsOf,
  buildLedgerFeatures,
  duplicateNamedIds,
  representativePoints,
} from './ledger-source';
import { LEDGER_MODE } from './ledger-state';
import { BUNDLE_STRINGS, LEDGER_STRINGS } from './strings';

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
  /** 拒否理由の共通枠（オプションバーの「次の一手」＋状態行）へ出す口。 */
  readonly onRefusal?: (message: string) => void;
  /**
   * 束の送りで次の地物を選んだあと、**素性欄の名前欄へ焦点を入れる**要求（設計書 §C.5）。
   * 器（素性欄）が持っている焦点を一覧が直接触らないための口。
   */
  readonly onFocusNameField?: () => void;
}

/** 一覧の行 1 つぶんの見た目。**28px 固定**なので中身は 1 行に収める。 */
function LedgerRowView(props: {
  readonly row: LedgerRow;
  readonly active: boolean;
  readonly editable: boolean;
  readonly editing: 'name' | 'kindLabel' | null;
  readonly onSelect: () => void;
  readonly onToggleExpand: () => void;
  readonly onToggleHidden: () => void;
  readonly onStartEdit: (field: 'name' | 'kindLabel') => void;
  readonly onCommitEdit: (field: 'name' | 'kindLabel', value: string) => void;
  readonly onCancelEdit: () => void;
}): JSX.Element {
  const {
    row,
    active,
    editable,
    editing,
    onSelect,
    onToggleExpand,
    onToggleHidden,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
  } = props;
  const id = row.featureId as unknown as string;
  return (
    <div
      className="ledger__row"
      data-testid={`ledger-row-${id}`}
      data-done={row.done ? 'true' : 'false'}
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
          aria-expanded={row.expanded}
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
          onDoubleClick={() => {
            if (editable) onStartEdit('name');
          }}
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
              title={LEDGER_STRINGS.doneTitle}
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
          onClick={() => {
            if (editable) onStartEdit('kindLabel');
            else onSelect();
          }}
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
        onClick={onToggleHidden}
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
  const { store, getRoot, getTime, onFocusFeatureCamera, onQuickEdit, onRefusal, onFocusNameField } =
    props;

  // 購読するのは、行の中身が変わりうる入力だけ（教訓 5.6: 根と年は fresh に読む）。
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const activeFeature = useStore(store, (s) => s.activeFeature);
  const filter = useStore(store, (s) => s.filter);
  const displayControl = useStore(store, (s) => s.displayControl);
  const ledger = useStore(store, (s) => s.ledger);
  const mode = useStore(store, (s) => s.mode);

  const editable = canEdit(mode);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [editing, setEditing] = useState<{
    readonly featureId: FeatureId;
    readonly field: 'name' | 'kindLabel';
  } | null>(null);
  /** 束を作る前の式の下書き（画面に出して編集できる＝設計書 §C.5）。 */
  const [expressionDraft, setExpressionDraft] = useState<string>(
    BUNDLE_PRESETS[0]?.expression ?? '',
  );
  const [presetId, setPresetId] = useState<string>(BUNDLE_PRESETS[0]?.id ?? '');

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // --- 母集団（現在時刻） -----------------------------------------------------
  //
  // **描画・当たり判定・検索と同じ単一判定**を通す（教訓 5.3 / 5.29）。
  // **`featuresAt` は 1 回だけ呼ぶ**（教訓 5.30 過剰計算の戒め）。母集団と親子関係を
  // 別々の memo で作ると、時刻を動かすたびに O(履歴 × 錨) の走査が 2 回走る
  // （`SidebarContent.test.tsx` の「featuresAt を 1 回だけ」がこれを固定している）。
  const { ledgerFeatures, forest } = useMemo(() => {
    const root = getRoot();
    const time = getTime();
    const all = featuresAt(root, time);
    const resolution = resolveDisplayFor(root, time, displayControl);
    const visible = (id: FeatureId): boolean =>
      isFeatureVisibleUnderFilter(resolution, filter, id);
    const shown = all.filter((f) => visible(f.id));
    // 代表点は **重複名のものだけ**（実データで 12 件）。全件やると毎回 5 万頂点を走る。
    const dup = duplicateNamedIds(shown);
    const points =
      dup.size === 0
        ? new Map<FeatureId, { lon: number; lat: number }>()
        : representativePoints(shown, verticesAt(root, time), dup);
    return {
      ledgerFeatures: buildLedgerFeatures({
        features: shown,
        anchorCounts: anchorCountsOf(root),
        hidden: (id) => filter.individual.get(id)?.hidden === true,
        visible: () => true,
        points,
      }),
      // 親子関係は **見えているものだけ**で組む。隠した親を残すと、木の途中に
      // 押せない行が出る（一覧・描画・当たりの母集団を 1 つにする＝教訓 5.29）。
      forest: buildForest(shown),
    };
    // domain / currentTime は購読の門で、中身は getRoot / getTime から fresh に読む。
  }, [getRoot, getTime, domain, currentTime, filter, displayControl]);

  // --- 作業のまとまり ---------------------------------------------------------
  const bundle = ledger.bundle;
  const currentOf = useCallback(
    (featureId: FeatureId) => {
      const f = ledgerFeatures.find((x) => x.id === featureId);
      return f === undefined ? undefined : { name: f.name, kindLabel: f.kindLabel };
    },
    [ledgerFeatures],
  );
  const doneIds = useMemo(
    () => (bundle === null ? new Set<FeatureId>() : doneIdsOf(bundle, currentOf)),
    [bundle, currentOf],
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
        query: ledger.query,
        tree: ledger.tree,
        ...(bundleIndex !== undefined ? { bundleIndex } : {}),
        done: doneIds,
        onlyUnfinished: ledger.onlyUnfinished && bundle !== null,
      }),
    [
      ledgerFeatures,
      forest,
      ledger.expanded,
      ledger.query,
      ledger.tree,
      ledger.onlyUnfinished,
      bundleIndex,
      doneIds,
      bundle,
    ],
  );

  // --- 通史（錨の一覧）--------------------------------------------------------
  const historyRows = useMemo(() => {
    if (ledger.mode !== LEDGER_MODE.History) return { rows: [], total: 0 };
    const root = getRoot();
    const time = getTime();
    const resolution = resolveDisplayFor(root, time, displayControl);
    const query = ledger.query.trim().toLowerCase();
    let total = 0;
    const out: {
      readonly key: string;
      readonly anchorId: string;
      readonly featureId: FeatureId;
      readonly label: string;
      readonly hidden: boolean;
      readonly start: TimePoint;
    }[] = [];
    for (const history of root.histories) {
      const hidden = !isFeatureVisibleUnderFilter(resolution, filter, history.featureId);
      for (const entry of history.series.entries) {
        const owner = entry.anchor.snapshot.features.find((f) => f.id === history.featureId);
        const name =
          owner === undefined
            ? (history.featureId as unknown as string)
            : featureDisplayName(owner);
        const label = LEDGER_STRINGS.historyRowLabel(formatTimePoint(entry.start), name);
        total += 1;
        if (query !== '' && !label.toLowerCase().includes(query)) continue;
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
  }, [ledger.mode, ledger.query, getRoot, getTime, domain, currentTime, filter, displayControl]);

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
    const marked = new Set<FeatureId>();
    const family = new Set<FeatureId>();
    const active = store.getState().activeFeature;
    if (active !== null) {
      family.add(active);
      for (const id of forest.childrenOf.get(active) ?? []) family.add(id);
      const parent = ledgerFeatures.find((f) => f.id === active)?.parentId;
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
  }, [getRoot, getTime, ledgerFeatures, forest, store]);

  const makeBundle = useCallback((): void => {
    const preset = BUNDLE_PRESETS.find((p) => p.id === presetId);
    const kind = preset?.kind ?? BUNDLE_KIND.Expression;
    const built2 = buildBundle(
      {
        presetId: preset?.id ?? null,
        label: preset?.label ?? BUNDLE_STRINGS.label,
        kind,
        expression: kind === BUNDLE_KIND.Expression ? expressionDraft : '',
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
    // **束を作った瞬間に、先頭の未処理を選び、カメラを合わせ、名前欄に焦点を入れる**
    // （設計書 §C.5。旧版はここが未定義で V4 の第 1 手が止まっていた）。
    const done = doneIdsOf(built2.bundle, currentOf);
    const first = firstUnfinishedIndex(built2.bundle, done);
    if (first === null) {
      onRefusal?.(BUNDLE_STRINGS.allDone);
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
    selectFeature,
    onFocusNameField,
    onRefusal,
  ]);

  // Ctrl+Z（改名の取り消し）で戻った地物へカーソルを移す（設計書 §C.5）。
  // **束のカーソルは取り消しの単位に含めない** ―― 取り消しはドメインのコマンドで、
  // カーソルは画面の状態である。だから「取り消しの結果を追いかける」形にする。
  useEffect(() => {
    if (bundle === null || activeFeature === null) return;
    const at = indexOfMember(bundle, activeFeature);
    if (at === null || at === bundle.cursor) return;
    store.getState().setBundleCursor(at);
  }, [bundle, activeFeature, store]);

  // --- その場編集 -------------------------------------------------------------
  const commitEdit = useCallback(
    (featureId: FeatureId, field: 'name' | 'kindLabel', value: string): void => {
      setEditing(null);
      if (!editable) {
        onRefusal?.(LEDGER_STRINGS.editRefusedViewOnly);
        return;
      }
      if (onQuickEdit === undefined) return;
      const refusal = onQuickEdit(
        featureId,
        field === 'name' ? { name: value } : { kindLabel: value },
      );
      if (refusal !== null) onRefusal?.(refusal);
    },
    [editable, onQuickEdit, onRefusal],
  );

  // F2 でその場改名（設計書 §I.2）。一覧にフォーカスがあるときだけ。
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key !== 'F2') return;
      const active = store.getState().activeFeature;
      if (active === null) return;
      e.preventDefault();
      if (!editable) {
        onRefusal?.(LEDGER_STRINGS.editRefusedViewOnly);
        return;
      }
      setEditing({ featureId: active, field: 'name' });
    },
    [store, editable, onRefusal],
  );

  const total = isHistory ? historyRows.total : built.totalCount;
  const shown = isHistory ? historyRows.rows.length : built.matchCount;
  const filtering = ledger.query.trim() !== '';

  return (
    <div className="ledger" data-testid="unified-list" onKeyDown={onListKeyDown}>
      <div className="ledger__filter">
        <input
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

      <BundleBar
        bundle={bundle}
        presetId={presetId}
        expression={expressionDraft}
        onlyUnfinished={ledger.onlyUnfinished}
        doneCount={doneIds.size}
        onPreset={(id) => {
          setPresetId(id);
          const preset = BUNDLE_PRESETS.find((p) => p.id === id);
          setExpressionDraft(preset?.expression ?? '');
        }}
        onExpression={setExpressionDraft}
        onMake={makeBundle}
        onClear={() => store.getState().setBundle(null)}
        onOnlyUnfinished={(v) => store.getState().setBundleOnlyUnfinished(v)}
        onStep={(delta) => {
          if (bundle === null) return;
          const at =
            delta > 0
              ? (nextUnfinishedIndex(bundle, doneIds, bundle.cursor) ??
                Math.min(bundle.cursor + 1, bundle.members.length - 1))
              : Math.max(bundle.cursor - 1, 0);
          goToBundleIndex(at);
        }}
      />

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
                      {...(row.hidden ? { title: LEDGER_STRINGS.doneTitle } : {})}
                      onClick={() => {
                        if (row.hidden) return;
                        const s = store.getState();
                        s.setActiveFeature(row.featureId);
                        s.setCurrentTime(row.start, TIME_CHANGE_SOURCE.AnchorSync);
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
                    editable={editable}
                    editing={
                      editing !== null && editing.featureId === row.featureId
                        ? editing.field
                        : null
                    }
                    onSelect={() => selectFeature(row.featureId)}
                    onToggleExpand={() =>
                      store.getState().toggleLedgerExpanded(row.featureId)
                    }
                    onToggleHidden={() =>
                      store.getState().setFeatureHidden(row.featureId, !row.hidden)
                    }
                    onStartEdit={(field) => setEditing({ featureId: row.featureId, field })}
                    onCommitEdit={(field, value) => commitEdit(row.featureId, field, value)}
                    onCancelEdit={() => setEditing(null)}
                  />
                ))}
          </div>
        </div>
      </div>

      <p className="ledger__footer" data-testid="ledger-footer">
        {LEDGER_STRINGS.footer(shown, total, bundle === null ? null : doneIds.size)}
      </p>
    </div>
  );
}

/** 作業のまとまりの帯（選ぶ・式・まとめる・送り）。 */
function BundleBar(props: {
  readonly bundle: Bundle | null;
  readonly presetId: string;
  readonly expression: string;
  readonly onlyUnfinished: boolean;
  readonly doneCount: number;
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
      <div className="ledger__bundle-row">
        <label className="ledger__bundle-label">
          <span>{BUNDLE_STRINGS.label}</span>
          <select
            className="ledger__bundle-select"
            data-testid="bundle-preset"
            aria-label={BUNDLE_STRINGS.selectAria}
            value={presetId}
            onChange={(e) => onPreset(e.target.value)}
          >
            {BUNDLE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
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
      <div className="ledger__bundle-row">
        <button
          type="button"
          className="ledger__bundle-step"
          data-testid="bundle-prev"
          disabled={bundle === null}
          onClick={() => onStep(-1)}
        >
          {BUNDLE_STRINGS.prevLabel}
        </button>
        <span className="ledger__bundle-position" data-testid="bundle-position">
          {bundle === null
            ? BUNDLE_STRINGS.none
            : BUNDLE_STRINGS.position(bundle.cursor + 1, bundle.members.length)}
        </span>
        <button
          type="button"
          className="ledger__bundle-step"
          data-testid="bundle-next"
          disabled={bundle === null}
          onClick={() => onStep(1)}
        >
          {BUNDLE_STRINGS.nextLabel}
        </button>
        <label className="ledger__bundle-only">
          <input
            type="checkbox"
            data-testid="bundle-only-unfinished"
            checked={onlyUnfinished}
            disabled={bundle === null}
            onChange={(e) => onOnlyUnfinished(e.target.checked)}
          />
          <span>{BUNDLE_STRINGS.onlyUnfinishedLabel}</span>
        </label>
        {bundle !== null && (
          <button
            type="button"
            className="ledger__bundle-step"
            data-testid="bundle-clear"
            onClick={onClear}
          >
            {BUNDLE_STRINGS.clearLabel}
          </button>
        )}
      </div>
    </div>
  );
}
