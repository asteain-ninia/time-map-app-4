// UI layer (U20 / shell): the LIVE sidebar content wiring (HB-3 root fix).
//
// HB-3 ROOT CAUSE (合成ルートの結線漏れ, 教訓 5.7「ロジックがあっても UI から呼ば
// れず機能しない」): the sidebar sections — 一覧 / プロパティ — are pure "入れ物" in
// {@link Sidebar} that take their content through optional slots (listContent /
// propertiesContent). The composition root (App.tsx) mounted {@link AppShell}
// WITHOUT passing the `sidebar` prop, so every slot stayed empty and the U32
// {@link PropertyPanel} was never mounted at all. (The "PropertyPanel が画面下部に
// 無スタイルで並ぶ" symptom is the absence of any styled host — the panel had no
// sidebar cell to live in, so nothing styled it.) This module builds the slots over
// the LIVE session store and hands them to AppShell so they render INSIDE the sidebar
// with the existing .sidebar__panel chrome (技術方針 2.5: the panels subscribe to the
// store; no parallel truth lives here).
//
// HB6: the former 地物一覧 / 錨一覧 tabs are unified into ONE「一覧」slot whose
// 現在時刻(旧地物一覧) / 通史(旧錨一覧) mode toggle lives in {@link UnifiedListSection}.
//
// The lookups are LIVE over the committed DomainProject at the current time
// (single truth source, 教訓 5.29): featureLookup / anchorLookup resolve against
// the same domain root the renderer draws, so the property panel can never show a
// feature the map does not. Selecting a row in the 地物一覧 promotes it through the
// SAME store.setActiveFeature path every selection uses (no second selection
// source); the property panel then re-resolves to it automatically.

import { useCallback, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { AnchorSeries } from '../../domain/anchor-series';
import { FEATURE_KIND, featureDisplayName, type Feature } from '../../domain/feature';
import { createGeoParams, type GeoParams } from '../../domain/geo/geo-params';
import { multiPolygonAreaKm2 } from '../../domain/geo/geodesy';
import { isMultiPolygonEmpty } from '../../domain/geometry/types';
import { buildForest } from '../../domain/hierarchy/forest';
import { resolveFeatureArea } from '../../domain/hierarchy/resolve-shape';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import {
  ownerLookupFromMap,
  type VertexOwnerLookup,
} from '../../domain/selection';
import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';

import { featuresAt, verticesAt } from '../live-lookup';
import { DisplayFilterPanel } from '../discovery/DisplayFilterPanel';
import { FILTER_STRINGS } from '../discovery/index';
import { resolveDisplayFor } from '../map/display-resolution-cache';
import { isFeatureVisibleUnderFilter } from '../map/filtered-display';
import { type SessionStore, TIME_CHANGE_SOURCE } from '../state/store';
import {
  PropertyPanel,
  PROPERTY_STRINGS,
  type AnchorSeriesLookup,
  type AssetResolver,
  type DetailDocumentDispatch,
  type EditDispatch,
  type AnchorIntervalEditDispatch,
  type FeatureLookup,
} from '../property/index';

import { SIDEBAR_CONTENT_STRINGS } from './strings';
import type { SidebarProps } from './Sidebar';

/**
 * Build the LIVE FeatureLookup over the domain root. Resolves a feature by id at
 * the CURRENT time so the property panel matches what is effective on the map
 * (教訓 5.29). Read fresh per call (never a stale capture, 教訓 5.6).
 */
function featureLookupOf(
  getRoot: () => DomainProject,
  getTime: () => TimePoint,
): FeatureLookup {
  return {
    featureAt(featureId: FeatureId): Feature | null {
      return featuresAt(getRoot(), getTime()).find((f) => f.id === featureId) ?? null;
    },
  };
}

/**
 * Build the LIVE AnchorSeriesLookup. A feature's full history-anchor series lives
 * on its {@link FeatureHistory} in the project root (U09); we return it whole so
 * the property panel DISPLAYS the series without re-deriving it (spec §やらないこと).
 */
function anchorLookupOf(getRoot: () => DomainProject): AnchorSeriesLookup {
  return {
    anchorSeriesOf(featureId: FeatureId): AnchorSeries | null {
      const history = getRoot().histories.find((h) => h.featureId === featureId);
      return history?.series ?? null;
    },
  };
}

export interface SidebarContentDeps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  readonly calendar: Calendar;
  /**
   * The edit-command dispatch (U16 → command base). The composition root wires
   * the real bridge; the property panel only assembles + hands off the intent
   * (教訓 5.33 契約越し). When omitted a guarded no-op is used so the panel never
   * crashes pre-binding (the same honest-stub discipline App.tsx uses for the
   * U13 seam — the WIRING is real and observable).
   */
  readonly editDispatch?: EditDispatch;
  /**
   * HB3-12: the存続期間編集 dispatch (U09 changeStart / setEnd / deleteAnchor). The
   * composition root wires the real whole-state-swap command bridge; when omitted the
   * panel hides the存続期間 editor (honest-stub discipline — no dead control). DISTINCT
   * from {@link editDispatch}, which only rewrites the snapshot, never the interval.
   */
  readonly anchorIntervalDispatch?: AnchorIntervalEditDispatch;
  /**
   * FR-98 後段: the 詳細文書 edit dispatch (live-detail-document.ts). The composition
   * root wires the real ONE-undo-unit bridge; when omitted the panel's 詳細文書
   * section stays a sanitized read-only preview (honest-stub discipline — no dead
   * 保存 control). DISTINCT from {@link editDispatch}: it rewrites only the record's
   * optional detailDocument field, never the attributes/color.
   */
  readonly detailDocumentDispatch?: DetailDocumentDispatch;
  /** FR-98 / FR-02: ZIP-internal asset resolution for the 詳細文書 preview. */
  readonly assetResolver?: AssetResolver;
  readonly onOpenDetail?: (featureId: FeatureId) => void;
  /** FR-85: delete the given feature (the property-panel「地物を削除」button's confirm). */
  readonly onDeleteFeature?: (featureId: FeatureId) => void;
  /**
   * Focus the camera on the feature just selected from a一覧 row (錨一覧 HB5-3 AND
   * 地物一覧 A1 — both導線 share the SAME fit path, the user's「地物一覧にも視点移動が
   * 欲しい」). Called AFTER the row promotes the feature (地物一覧) / promotes + syncs
   * the time (錨一覧), so the host resolves the feature's shape at the effective time
   * and frames the view through the single camera write path (ports.writeCamera).
   * Omitted (tests / pre-mount) → the row still selects (+ syncs time for錨), only the
   * camera does not move (honest absence, no crash). A map-click selection routes
   * through the live-selection-port, never here, so a map click never fits the view.
   */
  readonly onFocusFeatureCamera?: (featureId: FeatureId) => void;
}

/**
 * Assemble the three sidebar slots over the live store. Returns a {@link
 * SidebarProps} the composition root spreads into {@link AppShell}'s `sidebar`
 * prop, so the panels render INSIDE the styled sidebar cell (HB-3 fix).
 */
export function buildSidebarContent<S>(deps: SidebarContentDeps<S>): SidebarProps {
  const {
    store,
    getRoot,
    getTime,
    calendar,
    editDispatch,
    anchorIntervalDispatch,
    detailDocumentDispatch,
    assetResolver,
    onOpenDetail,
    onDeleteFeature,
    onFocusFeatureCamera,
  } = deps;

  const dispatch: EditDispatch = editDispatch ?? {
    // 教訓 5.7: the SAVE trigger is fully wired + observable; the live edit-apply
    // (snapshot → anchor → history insert) is an unassigned new-domain op (NOT
    // U42; same seam class as the U13 apply in App.tsx). Until that binding lands
    // a confirm THROWS an honest error (PropertyPanel.handleSave catches it and
    // surfaces 保存に失敗) rather than reporting a SILENT success — the user must
    // never be told an edit landed when it did not (HB-3 Codex P1).
    dispatchEdit() {
      throw new Error(PROPERTY_STRINGS.editNotWired);
    },
  };

  const featureLookup = featureLookupOf(getRoot, getTime);
  const anchorLookup = anchorLookupOf(getRoot);

  return {
    // HB6: 地物一覧 + 錨一覧 を 1タブ「一覧」+ モードトグル(現在時刻/通史)へ統合
    // (ユーザー GO 済). 現在時刻=旧地物一覧, 通史=旧錨一覧. 共通コア SidebarRowList を
    // 両モードで共有し、モードごとにフィルタ・件数・選択挙動・視点フィットを現行踏襲。
    listContent: (
      <>
        <UnifiedListSection
          store={store}
          getRoot={getRoot}
          getTime={getTime}
          {...(onFocusFeatureCamera ? { onFocusFeatureCamera } : {})}
        />
        {/* FR-113 表示制御フィルタ (U41): mounted in the 一覧 slot (a display control over
            which features the list / map show). NOT in the topBar (占有不変量 a4f6be9). */}
        <DisplayFilterPanel<S> store={store} />
      </>
    ),
    propertiesContent: (
      <PropertyPanelHost<S>
        store={store}
        getRoot={getRoot}
        getTime={getTime}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={dispatch}
        calendar={calendar}
        {...(anchorIntervalDispatch ? { anchorIntervalDispatch } : {})}
        {...(detailDocumentDispatch ? { detailDocumentDispatch } : {})}
        {...(assetResolver ? { assetResolver } : {})}
        {...(onOpenDetail ? { onOpenDetail } : {})}
        {...(onDeleteFeature ? { onDeleteFeature } : {})}
      />
    ),
  };
}

/**
 * Subscribing host for the U32 {@link PropertyPanel}. It reads the LIVE FR-109
 * geodesic settings (赤道長・扁平率) and the committed domain / current time from the
 * store, derives the {@link GeoParams}, and hands the panel a `resolveAreaKm2(id)`
 * port so a 面 feature's 面積（km²）row (FR-20 / FR-35) re-derives whenever those
 * change (教訓 5.3, no stale cache). This keeps the panel a pure prop-consumer
 * (port-clean, unit-testable) while the host owns reactivity — mirroring how
 * FeaturesSection / EventsSection subscribe and pass down.
 *
 * THE AREA IS LIVE (bughunt review 穴1): the resolver reads the domain + time FRESH
 * per call, and its closure is `useCallback`-memoized on the exact area INPUTS
 * (settings + domain + currentTime, bughunt #6). The host re-renders on every
 * committed-domain change (a vertex add/delete swaps the `domain` reference), which
 * yields a NEW resolver reference, so the panel's memo — keyed to that reference —
 * re-derives the area against the CURRENT shape rather than a feature object frozen at
 * selection time. When those inputs hold, the reference is stable, so a re-render from
 * another source reuses the memoized area instead of re-resolving every frame.
 *
 * BOTH 末端 AND 集約 (bughunt review 穴2 / FR-35): the area is `resolveFeatureArea`
 * (U08's single derived-shape resolution — a leaf's own shape OR an aggregate's child
 * union, the SAME source the map draws), converted to km² by the geodesy area kernel.
 * Point / line features and unresolvable / childless shapes yield `undefined` (no row).
 *
 * WHY the LIVE UI settings (not domain.settings.geo): the project's geodesic
 * parameters live in the UI store's `projectSettings` (equatorLengthKm / flattening,
 * FR-109); the domain-side `settings.geo` is only synced at save. Reading the store
 * slices here subscribes the host so an equator/flattening edit reflects immediately
 * (単一真実源: the same values the survey readout derives from).
 */
function PropertyPanelHost<S>(props: {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  readonly featureLookup: FeatureLookup;
  readonly anchorLookup: AnchorSeriesLookup;
  readonly editDispatch: EditDispatch;
  readonly calendar: Calendar;
  readonly anchorIntervalDispatch?: AnchorIntervalEditDispatch;
  readonly detailDocumentDispatch?: DetailDocumentDispatch;
  readonly assetResolver?: AssetResolver;
  readonly onOpenDetail?: (featureId: FeatureId) => void;
  readonly onDeleteFeature?: (featureId: FeatureId) => void;
}): JSX.Element {
  const { store, getRoot, getTime } = props;
  // Subscribe to the pieces that must re-derive the shown area: the FR-109 geodesic
  // settings and the committed domain (a shape edit swaps the domain reference).
  const equatorLengthKm = useStore(store, (s) => s.projectSettings.equatorLengthKm);
  const flattening = useStore(store, (s) => s.projectSettings.flattening);
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  // The display-control slice — an owner-lookup input (below): a depth/focus change
  // swaps this reference wholesale (identity == value, bughunt3), re-deriving the lookup.
  const displayControl = useStore(store, (s) => s.displayControl);

  // FR-81 / 現状.md §5「owner lookup の結線」(S4b root fix): the panel's `ownerLookup`
  // resolves each selected vertex to its OWNING feature so a vertex-only selection
  // (no active feature) shows that feature's properties (ContextFeature). Before this
  // wiring the host passed NO lookup, so the panel fell back to the EMPTY lookup and
  // EVERY vertex-only selection classified as Unknown —「選択頂点の所有地物を特定でき
  // ません」on real hardware — regardless of display state (honest-stub left un-wired,
  // 教訓 5.7).
  //
  // SINGLE TRUTH SOURCE (教訓 5.29): owners come from resolveDisplayFor's `owners` map
  // — the EXACT vertex→feature map the click hit-test grabs from and the renderer
  // draws (display-resolution-cache). What the user could CLICK to select is precisely
  // what the panel can resolve back to a feature; the two can never drift. The bundle
  // is memoized by (root, time, displayControl) IDENTITY and those are the live
  // store's own references, so this is a cache HIT off the frame the renderer already
  // resolved — no second pipeline run.
  //
  // MEMOIZED ON ITS EXACT INPUTS (the same discipline as resolveAreaKm2 below): the
  // committed `domain`, the effective `currentTime`, and the `displayControl` slice.
  // When none moved, the lookup reference is stable so the panel's decision memo does
  // not re-run; when any moves (edit / time scrub / depth change) the lookup re-derives
  // against the live resolution (教訓 5.3, no stale capture: the body reads the root /
  // time FRESH through getRoot / getTime — `domain` / `currentTime` gate the closure).
  const ownerLookup = useMemo<VertexOwnerLookup>(
    () => ownerLookupFromMap(resolveDisplayFor(getRoot(), getTime(), displayControl).owners),
    [getRoot, getTime, domain, currentTime, displayControl],
  );

  // FR-20 / FR-35: the target feature's 面積（km²）, resolved LIVE from the domain +
  // time effective now.
  //
  // MEMOIZED ON ITS INPUTS (bughunt #6 perf): the resolver is a `useCallback` keyed to
  // the FR-109 settings + the committed `domain` + the effective `currentTime` — the
  // exact inputs that can change the derived area. The panel's area memo is keyed to
  // this resolver's reference, so a re-render that leaves those inputs unchanged reuses
  // the memoized area instead of re-running the O(histories × anchors) featuresAt scan +
  // boolean-union resolve every frame during a time scrub / playback. Because `domain`
  // and `currentTime` ARE deps, a structural edit (domain swap) or a time move yields a
  // NEW closure ⇒ the memo re-derives against the CURRENT shape — the穴1 liveness the
  // previous "new closure every render" gave, now WITHOUT the per-frame recompute for
  // inputs that did not move. The resolver still reads the root/time FRESH through
  // getRoot/getTime (never a stale capture, 教訓 5.6); the deps only gate the closure.
  //
  // The area is the SINGLE derived-shape resolution `resolveFeatureArea` (a 末端's own
  // shape OR an 集約's child union — the same source the map draws, 教訓 5.29 / FR-35
  // 穴2), turned into km² by the geodesy area kernel. A point / line, an unresolvable /
  // childless shape, or an unknown id yields `undefined` ⇒ the panel shows no 面積 row.
  const resolveAreaKm2 = useCallback((featureId: FeatureId): number | undefined => {
    const geoParams: GeoParams = createGeoParams(equatorLengthKm, flattening);
    const time = getTime();
    const root = getRoot();
    // ONE featuresAt scan per resolve (bughunt #6): the effective feature set is read
    // once and reused both to identify the target's kind and to build the AREA forest —
    // the previous two calls doubled the O(histories × anchors) scan every frame.
    const effective = featuresAt(root, time);
    const feature = effective.find((f) => f.id === featureId);
    if (
      feature === undefined ||
      (feature.kind !== FEATURE_KIND.Leaf && feature.kind !== FEATURE_KIND.Aggregate)
    ) {
      // Point / line (no area) or an id not effective now → no row.
      return undefined;
    }
    // Build the forest over the AREA features so an aggregate's child union resolves
    // through the SAME U08 path the renderer uses (single truth source, 教訓 5.29).
    const areaFeatures = effective.filter(
      (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
    );
    const forest = buildForest(areaFeatures);
    const resolution = resolveFeatureArea(forest, verticesAt(root, time), featureId);
    if (resolution.status === 'failed' || isMultiPolygonEmpty(resolution.area)) {
      // No area to show: either unresolvable (missing vertex / child / rejected union)
      // OR resolved to an EMPTY multipolygon — a CHILDLESS aggregate (or one whose only
      // children are point / line, filtered out above) resolves to status 'ok' + empty
      // (resolveFeatureArea → ok(EMPTY_MULTI_POLYGON)). Both must yield `undefined` so the
      // panel shows NO 面積 row rather than a fabricated '0.00 km²' — restoring parity with
      // the map (which draws nothing for such a feature) and honouring the honest-stub
      // contract (bughunt review 集約穴 / 教訓 5.7 / 5.26: no fabricated value).
      return undefined;
    }
    return multiPolygonAreaKm2(resolution.area, geoParams);
    // Deps = the exact area INPUTS (bughunt #6): the FR-109 geodesic settings + the
    // committed `domain` + the effective `currentTime`. When any moves, the closure —
    // and thus the panel's area-memo key — changes, so the area re-derives against the
    // live shape (穴1 liveness). When they hold, the reference is stable, so a re-render
    // from another source reuses the memoized area (no per-frame re-resolve). `domain` /
    // `currentTime` gate the closure only; the body still reads them FRESH through
    // getRoot / getTime (never a stale capture, 教訓 5.6). getRoot / getTime are stable
    // (built once in the composition root), listed for completeness.
  }, [getRoot, getTime, equatorLengthKm, flattening, domain, currentTime]);

  return (
    <PropertyPanel<S>
      store={props.store}
      featureLookup={props.featureLookup}
      anchorLookup={props.anchorLookup}
      editDispatch={props.editDispatch}
      calendar={props.calendar}
      ownerLookup={ownerLookup}
      resolveAreaKm2={resolveAreaKm2}
      {...(props.anchorIntervalDispatch ? { anchorIntervalDispatch: props.anchorIntervalDispatch } : {})}
      {...(props.detailDocumentDispatch ? { detailDocumentDispatch: props.detailDocumentDispatch } : {})}
      {...(props.assetResolver ? { assetResolver: props.assetResolver } : {})}
      {...(props.onOpenDetail ? { onOpenDetail: props.onOpenDetail } : {})}
      {...(props.onDeleteFeature ? { onDeleteFeature: props.onDeleteFeature } : {})}
    />
  );
}

/** A short human label for a feature row (name falls back to its id). Defers to
 * the domain's single fallback rule so this list and the selection pickers share
 * one source of truth (教訓 5.30). */
const featureLabel = featureDisplayName;

/**
 * Fold rule for the一覧フィルタ, IDENTICAL to the FR-99 feature search normalize
 * (discovery/search.ts `fold`): NFKC + lowercase, so絞り込み matches the SAME way検索
 * does — a全角／半角・大文字小文字 difference never hides a row (整合, 教訓 5.19 表示
 * 文字列で判定しない). Kept a primitive one-liner rather than crossing the shell→
 * discovery layer boundary; if the search fold rule changes, this must track it.
 */
function foldName(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * One selectable row in a sidebar一覧 (地物一覧 / 錨一覧 共通コア). The caller builds
 * the row + its select side-effect; the shared list owns the chrome / filter / count.
 */
interface SidebarListRow {
  /** React key (+ filter iteration identity). */
  readonly key: string;
  /** The row button's data-testid — 既存 e2e 契約を温存 (feature-list-item-* / event-list-item-*). */
  readonly testid: string;
  /** The visible AND filterable label (feature display name, 名前部分一致 の対象). */
  readonly label: string;
  /** aria-pressed 状態 (地物一覧 は現在選択中の地物を強調; 錨一覧 は常に false). */
  readonly pressed: boolean;
  /**
   * FR-113 (Codex F3): the row is 選択/フィット不可 (a 通史 row whose feature is hidden at
   * the current time — the current-time 一覧 removes such rows outright instead). Renders a
   * disabled button with {@link disabledTitle}; `onSelect` also no-ops defensively.
   */
  readonly disabled?: boolean;
  /** Tooltip explaining why the row is disabled (FR-113). */
  readonly disabledTitle?: string;
  /** 行選択時の副作用 (選択 [+ 時刻同期] + 視点フィット) を呼び出し側が組み立てる。 */
  readonly onSelect: () => void;
}

/**
 * 地物一覧 と 錨一覧 の共通コア (ユーザー要望「地物一覧と錨一覧ってほぼ同一の機能として
 * 実装できるのでは」). 両者はともに「絞り込み可能な選択行リスト」で、違いは (a) 行の生成
 * 規則 = 現在時刻に存在する地物か 通史の全錨か、(b) 選択時副作用 = 時刻同期の有無、の2点
 * だけ。ここに共通の見た目・名前フィルタ・件数表示・空状態を1箇所へ集約する (単一の真実源、
 * 教訓 5.30 過少共有の戒め)。
 *
 * 表示モード「現在時刻 / 通史」は既存のタブ2枚で表現する (地物一覧 = 現在時刻に存在する地物、
 * 錨一覧 = 全時刻の錨 = 通史)。タブを1枚へ統合してモードトグルにする案も可能だが、
 * feature-list / event-list / sidebar-tab-* 等の既存 testid を多数の e2e が参照しており、
 * 統合は testid 契約を壊すため、暫定決定として「2タブ維持 + 内部コア共通化」を採る (完了報告)。
 *
 * フィルタ: 名前部分一致 (foldName 正規化)。IME 対応 — 制御 input の value をそのまま述語に
 * 使うだけで、変換確定後の onChange で自然に反映される (キー単位の割り込み処理をしないので、
 * 変換中の未確定文字列を壊さない)。件数: 絞り込みなし=全件、絞り込み中=一致/全件。
 */
function SidebarRowList(props: {
  readonly listTestid: string;
  readonly caption: string;
  readonly emptyText: string;
  readonly filterPlaceholder: string;
  readonly filterAria: string;
  readonly rows: readonly SidebarListRow[];
}): JSX.Element {
  const { listTestid, caption, emptyText, filterPlaceholder, filterAria, rows } = props;
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const filtered =
    trimmed === ''
      ? rows
      : rows.filter((r) => foldName(r.label).includes(foldName(trimmed)));

  return (
    <div className="sidebar-list" data-testid={listTestid}>
      <p className="sidebar-list__caption" data-testid={`${listTestid}-caption`}>
        {caption}
      </p>
      {rows.length === 0 ? (
        <p className="sidebar-list__empty" data-testid={`${listTestid}-empty`}>
          {emptyText}
        </p>
      ) : (
        <>
          <div className="sidebar-list__filter">
            <input
              type="search"
              className="sidebar-list__filter-input"
              data-testid={`${listTestid}-filter`}
              aria-label={filterAria}
              placeholder={filterPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span
              className="sidebar-list__count"
              data-testid={`${listTestid}-count`}
            >
              {trimmed === ''
                ? SIDEBAR_CONTENT_STRINGS.countAll(rows.length)
                : SIDEBAR_CONTENT_STRINGS.countFiltered(filtered.length, rows.length)}
            </span>
          </div>
          {filtered.length === 0 ? (
            <p className="sidebar-list__empty" data-testid={`${listTestid}-no-match`}>
              {SIDEBAR_CONTENT_STRINGS.noMatch}
            </p>
          ) : (
            <ul className="sidebar-list__items">
              {filtered.map((row) => (
                <li key={row.key}>
                  <button
                    type="button"
                    className="sidebar-list__item"
                    aria-pressed={row.pressed}
                    data-testid={row.testid}
                    disabled={row.disabled === true}
                    {...(row.disabledTitle !== undefined ? { title: row.disabledTitle } : {})}
                    onClick={row.onSelect}
                  >
                    {row.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** The 一覧 tab's two display modes (HB6): 現在時刻(旧地物一覧) / 通史(旧錨一覧). */
const LIST_MODE = {
  /** 現在時刻: the features effective at the current year (旧地物一覧). */
  Current: 'current',
  /** 通史: every feature's history anchors across all time (旧錨一覧). */
  History: 'history',
} as const;

type ListMode = (typeof LIST_MODE)[keyof typeof LIST_MODE];

/**
 * 一覧 — the unified feature/anchor list (HB6, ユーザー GO 済). ONE panel with a
 * 現在時刻 / 通史 mode toggle REPLACES the former 地物一覧 / 錨一覧 tabs (ユーザー:
 * 「地物一覧と錨一覧ってほぼ同一の機能として実装できるのでは」). Both modes are the
 * SAME「絞り込み可能な選択行リスト」(the SidebarRowList 共通コア); the mode only changes
 * (a) the row-generation rule (現在時刻に存在する地物 か 通史の全錨) and (b) the select
 * side-effect (通史 のみ時刻同期). フィルタ・件数・視点フィット・選択挙動はモードごとに
 * 現行を踏襲 (単一真実源, 教訓 5.30).
 *
 * 現在時刻 (旧地物一覧): rows = the features effective now; selecting promotes through
 * the SAME store.setActiveFeature path (no second selection source) AND fits the camera
 * at 現在時刻 with NO time sync (A1「地物一覧にも視点移動が欲しい」). The active row is
 * highlighted from the live selection mirror (技術方針 2.5).
 *
 * 通史 (旧錨一覧): rows = every feature's history anchors, each label resolved from ITS
 * OWN anchor snapshot (教訓 5.29 — a rename at a non-first anchor stays visible). Selecting
 * syncs the session time to the anchor start (教訓 5.6 / 5.15), promotes the owner, THEN
 * fits the camera at that time (HB5-3). No independent time/selection source lives here.
 */
function UnifiedListSection<S>(props: {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  readonly onFocusFeatureCamera?: (featureId: FeatureId) => void;
}): JSX.Element {
  const { store, getRoot, getTime, onFocusFeatureCamera } = props;
  const [mode, setMode] = useState<ListMode>(LIST_MODE.Current);

  // Subscribe to committed-domain / time / selection so the rows re-derive from the live
  // root whenever they change (技術方針 2.5; single truth source 教訓 5.29). The row
  // builder reads the root/time FRESH through getRoot/getTime (never a stale capture,
  // 教訓 5.6); these selectors gate the recompute.
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const activeFeature = useStore(store, (s) => s.activeFeature);
  // FR-113 (Codex F3): the 一覧 母集合 must agree with draw / hit — a hidden feature drops
  // its row. Subscribe to the filter + displayControl so a filter change re-derives the list.
  const filter = useStore(store, (s) => s.filter);
  const displayControl = useStore(store, (s) => s.displayControl);

  const isCurrent = mode === LIST_MODE.Current;

  const rows: SidebarListRow[] = useMemo(() => {
    // The SAME single FR-113 verdict the draw / hit / tool-target paths use (単一解決,
    // 教訓 5.29). Reuses the resolveDisplayFor memo (a HIT off the live frame). Raw-feature
    // visibility (not the drawn-set visibleIds), so an FR-42 aggregation-omitted child stays
    // listed while a 個別非表示 / 種別 / 深度 feature is removed — the invariant without an
    // FR-42 list-behaviour change.
    const resolution = resolveDisplayFor(getRoot(), getTime(), displayControl);
    const visible = (featureId: FeatureId): boolean =>
      isFeatureVisibleUnderFilter(resolution, filter, featureId);

    if (isCurrent) {
      // 現在時刻 (旧地物一覧): FR-113-visible features effective now; a hidden feature's row
      // is removed outright (行ごと非表示 — 一貫 with draw / search, not a disabled row).
      return featuresAt(getRoot(), getTime())
        .filter((feature) => visible(feature.id))
        .map((feature) => ({
          key: feature.id as unknown as string,
          testid: `feature-list-item-${feature.id as unknown as string}`,
          label: featureLabel(feature),
          pressed: activeFeature === feature.id,
          onSelect: () => {
            store.getState().setActiveFeature(feature.id);
            onFocusFeatureCamera?.(feature.id);
          },
        }));
    }
    // 通史 (旧錨一覧): every feature's history anchors, each labelled from ITS OWN snapshot.
    // A row whose feature is hidden at the CURRENT time is DISABLED (選択/フィット不可) — the
    // minimal, honest handling of the cross-time case (applying anchor-time visibility per row
    // is out of scope; 個別非表示 / 種別 off are time-independent so this covers the common case).
    return getRoot().histories.flatMap((history) => {
      const hidden = !visible(history.featureId);
      return history.series.entries.map((entry) => {
        const owner = entry.anchor.snapshot.features.find(
          (f) => f.id === history.featureId,
        );
        const label = owner
          ? featureDisplayName(owner)
          : (history.featureId as unknown as string);
        const anchorId = entry.anchor.id as unknown as string;
        return {
          key: `${history.featureId as unknown as string}:${anchorId}`,
          testid: `event-list-item-${anchorId}`,
          label,
          pressed: false,
          ...(hidden ? { disabled: true, disabledTitle: FILTER_STRINGS.hiddenListRowTitle } : {}),
          onSelect: () => {
            // FR-113 (F3): a hidden feature's row never selects / syncs / fits (defensive —
            // the button is disabled too).
            if (hidden) return;
            // Promote + sync the time FIRST (single selection / time path), THEN fit the
            // camera at that time (HB5-3). Only this 錨導線 (+ the 地物導線) writes the
            // camera, so a map-click selection never fits.
            store.getState().setActiveFeature(history.featureId);
            store.getState().setCurrentTime(entry.start, TIME_CHANGE_SOURCE.AnchorSync);
            onFocusFeatureCamera?.(history.featureId);
          },
        };
      });
    });
    // domain / currentTime are subscribe-gates (read fresh via getRoot/getTime, 教訓 5.6).
  }, [isCurrent, getRoot, getTime, activeFeature, store, onFocusFeatureCamera, domain, currentTime, filter, displayControl]);

  return (
    <div className="sidebar-list-panel" data-testid="sidebar-list-panel">
      <div
        className="sidebar-list__modes"
        role="group"
        aria-label={SIDEBAR_CONTENT_STRINGS.listModeAria}
      >
        <button
          type="button"
          className="sidebar-list__mode"
          data-testid="list-mode-current"
          aria-pressed={isCurrent}
          onClick={() => setMode(LIST_MODE.Current)}
        >
          {SIDEBAR_CONTENT_STRINGS.listModeCurrentLabel}
        </button>
        <button
          type="button"
          className="sidebar-list__mode"
          data-testid="list-mode-history"
          aria-pressed={!isCurrent}
          onClick={() => setMode(LIST_MODE.History)}
        >
          {SIDEBAR_CONTENT_STRINGS.listModeHistoryLabel}
        </button>
      </div>
      {/* Keyed by mode so the name filter resets on a mode switch — each mode keeps its
          own filter/count (モードごとに現行を踏襲, 教訓 5.2). listTestid「unified-list」is
          the single container; the row testids stay mode-semantic (feature-list-item-* /
          event-list-item-*) so aggregate-select / hb3-12 等の消費側の検証意図を温存する。 */}
      <SidebarRowList
        key={mode}
        listTestid="unified-list"
        caption={isCurrent ? SIDEBAR_CONTENT_STRINGS.featuresCaption : SIDEBAR_CONTENT_STRINGS.eventsCaption}
        emptyText={isCurrent ? SIDEBAR_CONTENT_STRINGS.featuresEmpty : SIDEBAR_CONTENT_STRINGS.eventsEmpty}
        filterPlaceholder={SIDEBAR_CONTENT_STRINGS.filterPlaceholder}
        filterAria={
          isCurrent
            ? SIDEBAR_CONTENT_STRINGS.featuresFilterAria
            : SIDEBAR_CONTENT_STRINGS.eventsFilterAria
        }
        rows={rows}
      />
    </div>
  );
}
