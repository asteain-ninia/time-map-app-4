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

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { AnchorSeries } from '../../domain/anchor-series';
import { featureDisplayName, type Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';

import { featuresAt } from '../live-lookup';
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
    eventsContent: <EventsSection store={store} getRoot={getRoot} />,
    featuresContent: <FeaturesSection store={store} getRoot={getRoot} getTime={getTime} />,
    propertiesContent: (
      <PropertyPanel<S>
        store={store}
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
}): JSX.Element {
  const { store, getRoot } = props;
  const domain = useStore(store, (s) => s.domain);
  void domain; // recompute the event rows when the committed domain changes.
  const root = getRoot();
  const rows = root.histories.flatMap((history) => {
    // Defer to the domain's single fallback rule (教訓 5.30): an unnamed feature
    // carries a present-but-blank name (''), so a bare `??` never fires and the
    // row would render blank. featureDisplayName trims and falls back to the id,
    // matching the 地物一覧 so every event row carries a visible identifier.
    const owner = history.series.entries[0]?.anchor.snapshot.features.find(
      (f) => f.id === history.featureId,
    );
    const label = owner
      ? featureDisplayName(owner)
      : (history.featureId as unknown as string);
    return history.series.entries.map((entry) => ({
      featureId: history.featureId,
      anchorId: entry.anchor.id as unknown as string,
      start: entry.start,
      name: label,
    }));
  });

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
                  store.getState().setActiveFeature(row.featureId);
                  store
                    .getState()
                    .setCurrentTime(row.start, TIME_CHANGE_SOURCE.AnchorSync);
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
