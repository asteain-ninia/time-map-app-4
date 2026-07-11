// UI layer (U20 / shell): the LIVE sidebar content wiring (HB-3 root fix).
//
// HB-3 ROOT CAUSE (合成ルートの結線漏れ, 教訓 5.7「ロジックがあっても UI から呼ば
// れず機能しない」): the three sidebar sections — イベント一覧 / 地物一覧 / プロパティ —
// are pure "入れ物" in {@link Sidebar} that take their content through optional
// slots (eventsContent / featuresContent / propertiesContent). The composition
// root (App.tsx) mounted {@link AppShell} WITHOUT passing the `sidebar` prop, so
// every slot stayed empty and the U32 {@link PropertyPanel} was never mounted at
// all. (The "PropertyPanel が画面下部に無スタイルで並ぶ" symptom is the absence of
// any styled host — the panel had no sidebar cell to live in, so nothing styled
// it.) This module builds the three slots over the LIVE session store and hands
// them to AppShell so they render INSIDE the sidebar with the existing
// .sidebar__panel chrome (技術方針 2.5: the panels subscribe to the store; no
// parallel truth lives here).
//
// The lookups are LIVE over the committed DomainProject at the current time
// (single truth source, 教訓 5.29): featureLookup / anchorLookup resolve against
// the same domain root the renderer draws, so the property panel can never show a
// feature the map does not. Selecting a row in the 地物一覧 promotes it through the
// SAME store.setActiveFeature path every selection uses (no second selection
// source); the property panel then re-resolves to it automatically.

import { useCallback, useMemo } from 'react';
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
import { resolveDisplayFor } from '../map/display-resolution-cache';
import { type SessionStore, TIME_CHANGE_SOURCE } from '../state/store';
import {
  PropertyPanel,
  PROPERTY_STRINGS,
  type AnchorSeriesLookup,
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
  readonly onOpenDetail?: (featureId: FeatureId) => void;
  /** FR-85: delete the given feature (the property-panel「地物を削除」button's confirm). */
  readonly onDeleteFeature?: (featureId: FeatureId) => void;
  /**
   * HB5-3: focus the camera on the feature just selected from an錨 row (錨一覧起点).
   * Called AFTER the row promotes the feature + syncs the time, so the host resolves
   * the feature's shape at the錨の開始 time and frames the view onto it through the
   * single camera write path. Omitted (tests / pre-mount) → the錨 click still selects
   * + syncs time, only the camera does not move (honest absence, no crash).
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
    eventsContent: (
      <EventsSection
        store={store}
        getRoot={getRoot}
        {...(onFocusFeatureCamera ? { onFocusFeatureCamera } : {})}
      />
    ),
    featuresContent: <FeaturesSection store={store} getRoot={getRoot} getTime={getTime} />,
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
 * 地物一覧 — the list of features effective at the current time (FR-111). Selecting
 * a row promotes it through the SAME store.setActiveFeature path every selection
 * uses (no second selection source); the property panel re-resolves to it. The
 * active row is highlighted from the live selection mirror (技術方針 2.5).
 */
function FeaturesSection<S>(props: {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
}): JSX.Element {
  const { store, getRoot, getTime } = props;
  // Re-render on any committed-domain / time / selection change: reading these
  // selectors subscribes this component, so the list below re-derives from the
  // live root whenever they change (技術方針 2.5; single truth source 教訓 5.29).
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const activeFeature = useStore(store, (s) => s.activeFeature);
  // The render reads `domain` / `currentTime` only to subscribe (the lookup reads
  // them fresh through getRoot/getTime — never a stale capture, 教訓 5.6).
  const features = featuresAt(getRoot(), getTime());
  void domain;
  void currentTime;

  return (
    <div className="sidebar-list" data-testid="feature-list">
      <p className="sidebar-list__caption" data-testid="feature-list-caption">
        {SIDEBAR_CONTENT_STRINGS.featuresCaption}
      </p>
      {features.length === 0 ? (
        <p className="sidebar-list__empty" data-testid="feature-list-empty">
          {SIDEBAR_CONTENT_STRINGS.featuresEmpty}
        </p>
      ) : (
        <ul className="sidebar-list__items">
          {features.map((feature) => (
            <li key={feature.id as unknown as string}>
              <button
                type="button"
                className="sidebar-list__item"
                aria-pressed={activeFeature === feature.id}
                data-testid={`feature-list-item-${feature.id as unknown as string}`}
                onClick={() => store.getState().setActiveFeature(feature.id)}
              >
                {featureLabel(feature)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * イベント一覧 — every feature's history anchors (its 時間軸イベント) at-a-glance,
 * grouped by feature (FR-111 / FR-84). Each anchor row syncs the session time to
 * its start through the SAME store.setCurrentTime path the timeline uses (教訓
 * 5.6 / 5.15), and promotes its owner feature, so jumping to an event re-resolves
 * the property panel to that feature at that time. No independent time/selection
 * source lives here.
 */
function EventsSection<S>(props: {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  /** HB5-3: focus the camera on the row's feature after selecting + syncing time. */
  readonly onFocusFeatureCamera?: (featureId: FeatureId) => void;
}): JSX.Element {
  const { store, getRoot, onFocusFeatureCamera } = props;
  const domain = useStore(store, (s) => s.domain);
  void domain; // recompute the event rows when the committed domain changes.
  const root = getRoot();
  const rows = root.histories.flatMap((history) =>
    history.series.entries.map((entry) => {
      // Resolve EACH row's label from ITS OWN anchor's snapshot (the state
      // effective AT that anchor's start, the same单一真実源 featuresAt/resolveAt
      // read — 教訓 5.29). A rename committed at a NON-first anchor lives only in
      // that later anchor's snapshot, so deriving every row from entries[0] hid it
      // and showed the first name on every row. Defer to the domain's single
      // fallback rule (教訓 5.30): an unnamed feature carries a present-but-blank
      // name (''), so featureDisplayName trims and falls back to the id, matching
      // the 地物一覧 so every event row carries a visible identifier.
      const owner = entry.anchor.snapshot.features.find(
        (f) => f.id === history.featureId,
      );
      const label = owner
        ? featureDisplayName(owner)
        : (history.featureId as unknown as string);
      return {
        featureId: history.featureId,
        anchorId: entry.anchor.id as unknown as string,
        start: entry.start,
        name: label,
      };
    }),
  );

  return (
    <div className="sidebar-list" data-testid="event-list">
      <p className="sidebar-list__caption" data-testid="event-list-caption">
        {SIDEBAR_CONTENT_STRINGS.eventsCaption}
      </p>
      {rows.length === 0 ? (
        <p className="sidebar-list__empty" data-testid="event-list-empty">
          {SIDEBAR_CONTENT_STRINGS.eventsEmpty}
        </p>
      ) : (
        <ul className="sidebar-list__items">
          {rows.map((row) => (
            <li key={`${row.featureId as unknown as string}:${row.anchorId}`}>
              <button
                type="button"
                className="sidebar-list__item"
                data-testid={`event-list-item-${row.anchorId}`}
                onClick={() => {
                  // Promote the feature + sync the time FIRST (unchanged single
                  // selection / time path), THEN focus the camera on the feature at
                  // that time (HB5-3). The camera write funnels through the host's
                  // single ports.writeCamera; this錨導線 is the only caller, so a
                  // map-click selection never moves the view.
                  store.getState().setActiveFeature(row.featureId);
                  store
                    .getState()
                    .setCurrentTime(row.start, TIME_CHANGE_SOURCE.AnchorSync);
                  onFocusFeatureCamera?.(row.featureId);
                }}
              >
                {row.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
