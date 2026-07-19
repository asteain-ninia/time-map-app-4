// U20 / shell — SidebarContent wiring tests (HB-3 regression).
//
// HB-3: the sidebar slots were never wired in the composition root, so the
// PropertyPanel / 地物一覧 / イベント一覧 never mounted. These tests assert the slots
// build over the LIVE store + domain root: the property panel resolves the active
// feature, the 地物一覧 lists committed features and promotes one through the SAME
// store.setActiveFeature path, and the property panel then re-resolves to it.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// FR-20 perf (bughunt #6): spy on the LIVE `featuresAt` lookup so a test can COUNT
// how many O(histories × anchors) scans the area resolver runs. The real
// implementation is preserved (delegated to) — only the call count is observed.
// A holder object survives `vi.mock` hoisting (the factory captures it by reference).
const featuresAtCalls = { count: 0 };
vi.mock('../live-lookup', async (importActual) => {
  const actual = await importActual<typeof import('../live-lookup')>();
  return {
    ...actual,
    featuresAt: (...args: Parameters<typeof actual.featuresAt>) => {
      featuresAtCalls.count += 1;
      return actual.featuresAt(...args);
    },
  };
});

import { applyAddProposal, applyEditProposal } from '../../domain/editing/apply-proposal';
import { createEditProposal } from '../../domain/consistency/index';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  withAttributes,
  type AggregateFeature,
  type LeafFeature,
} from '../../domain/feature';
import type { FeatureSnapshot } from '../../domain/editing/edit-flow';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createGeoParams } from '../../domain/geo/geo-params';
import { multiPolygonAreaKm2 } from '../../domain/geo/geodesy';
import { buildForest } from '../../domain/hierarchy/forest';
import { resolveFeatureArea } from '../../domain/hierarchy/resolve-shape';
import { FEATURE_KIND } from '../../domain/feature';
import type { AddSnapshot } from '../../domain/add/index';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';

import type { DomainRoot } from '../consistency-binding';
import { featuresAt, verticesAt } from '../live-lookup';
import { createSessionStore, TIME_CHANGE_SOURCE } from '../state/store';
import { formatAreaKm2 } from '../property/messages';
import { Sidebar } from './Sidebar';
import { buildSidebarContent } from './SidebarContent';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function emptyProject(): DomainRoot {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

function squareLeaf(
  idRaw: string,
  name: string,
  lonOffset = 0,
  latOffset = 0,
  side = 2,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${idRaw}-v${i}`), {
      lon: c[0]! + lonOffset,
      lat: c[1]! + latOffset,
    }),
  );
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(name, 1000, 1100),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

function withLeaf(
  root: DomainRoot,
  leaf: { feature: LeafFeature; vertices: Vertex[] },
  year: number,
): DomainRoot {
  const snapshot: AddSnapshot = {
    feature: leaf.feature,
    vertices: leaf.vertices,
    sharedCandidateIds: new Map(),
  };
  return applyAddProposal(
    root,
    createEditProposal(leaf.feature.id, timePointYear(year), snapshot),
  );
}

/**
 * Add a SECOND history anchor to `leaf`'s series at `year` that renames it to
 * `newName` (a past-edit on its own series — FR-55). The renamed feature carries
 * the SAME id, so the event list has two anchors for one feature whose effective
 * snapshot names differ by anchor time.
 */
function renameLeafAt(
  root: DomainRoot,
  leaf: { feature: LeafFeature; vertices: Vertex[] },
  newName: string,
  year: number,
): DomainRoot {
  const renamed = withAttributes(
    leaf.feature,
    createBasicAttributes(newName, 1000, 1100),
  );
  const snapshot: FeatureSnapshot = { feature: renamed, vertices: [] };
  return applyEditProposal(
    root,
    createEditProposal(leaf.feature.id, timePointYear(year), snapshot),
    calendar,
  );
}

function renderWith(root: DomainRoot) {
  const store = createSessionStore<DomainRoot>({
    initialDomain: root,
    initial: { currentTime: timePointYear(1000) },
  });
  const sidebar = buildSidebarContent<DomainRoot>({
    store,
    getRoot: () => store.getState().domain,
    getTime: () => store.getState().currentTime,
    calendar,
  });
  const utils = render(<Sidebar {...sidebar} />);
  return { store, ...utils };
}

describe('SidebarContent — HB-3 wiring', () => {
  it('mounts the PropertyPanel inside the sidebar properties panel', () => {
    renderWith(emptyProject());
    const panel = screen.getByTestId('sidebar-panel-properties');
    expect(within(panel).getByTestId('property-panel')).toBeInTheDocument();
  });

  it('lists committed features in the 一覧 現在時刻 mode (旧地物一覧)', () => {
    const a = squareLeaf('f-a', '織田領');
    const root = withLeaf(emptyProject(), a, 1000);
    renderWith(root);
    // 現在時刻 mode is the default; the unified list holds the feature rows.
    const list = screen.getByTestId('unified-list');
    expect(within(list).getByText('織田領')).toBeInTheDocument();
  });

  it('FR-113 (Codex F3): 個別非表示 removes the feature row from the 現在時刻 一覧; 全て再表示 restores it', () => {
    const a = squareLeaf('f-a', '織田領', 0, 0);
    const b = squareLeaf('f-b', '徳川領', 10, 0);
    let root = withLeaf(emptyProject(), a, 1000);
    root = withLeaf(root, b, 1000);
    const { store } = renderWith(root);
    expect(screen.getByTestId('feature-list-item-f-a')).toBeInTheDocument();
    expect(screen.getByTestId('feature-list-item-f-b')).toBeInTheDocument();

    // Hide f-a via the display filter → its LIST row disappears (不変条件: 非表示は一覧からも
    // 消える), while f-b stays. The list母集合 now agrees with draw / hit / search.
    act(() => store.getState().setFeatureHidden(a.feature.id, true));
    expect(screen.queryByTestId('feature-list-item-f-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('feature-list-item-f-b')).toBeInTheDocument();

    // 全て再表示 → the row returns.
    act(() => store.getState().showAllHiddenFeatures());
    expect(screen.getByTestId('feature-list-item-f-a')).toBeInTheDocument();
  });

  it('selecting a feature row promotes it through the store and the panel shows its fields', () => {
    const a = squareLeaf('f-a', '織田領');
    const root = withLeaf(emptyProject(), a, 1000);
    const { store } = renderWith(root);

    // Empty selection: the property panel shows guidance, not a form.
    expect(screen.getByTestId('property-guidance')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('feature-list-item-f-a'));

    // The single selection truth was promoted through the store (no second source).
    expect(store.getState().activeFeature).toBe(a.feature.id);
    // The property panel re-resolved to the feature: its basic-info form (a field
    // host) is now visible INSIDE the properties panel.
    const panel = screen.getByTestId('sidebar-panel-properties');
    expect(within(panel).getByTestId('basic-info')).toBeInTheDocument();
  });

  it('shows the empty-state guidance when there are no features / events (both modes)', () => {
    renderWith(emptyProject());
    // 現在時刻 (default): 地物 0件 → the shared empty state.
    expect(screen.getByTestId('unified-list-empty')).toBeInTheDocument();
    // 通史: 錨 0件 → same empty state after switching mode.
    fireEvent.click(screen.getByTestId('list-mode-history'));
    expect(screen.getByTestId('unified-list-empty')).toBeInTheDocument();
  });

  it('lists each feature anchor as a row in 通史 mode (旧錨一覧)', () => {
    const a = squareLeaf('f-a', '織田領');
    const root = withLeaf(emptyProject(), a, 1000);
    renderWith(root);
    fireEvent.click(screen.getByTestId('list-mode-history'));
    const list = screen.getByTestId('unified-list');
    expect(within(list).getByText('織田領')).toBeInTheDocument();
  });

  // Regression (BUGHUNT4): each event row must resolve its label from ITS OWN
  // anchor's effective snapshot at that anchor time, not from the FIRST anchor for
  // the whole feature. A rename committed at a NON-first anchor (a past-edit that
  // inserts a later anchor with a new name) was invisible because every row reused
  // the first anchor's label. The first anchor's row must keep the OLD name and the
  // renamed anchor's row must show the NEW name (single source of truth, 教訓 5.29).
  it('resolves each event row label from its own anchor (a non-first rename shows on its row)', () => {
    const a = squareLeaf('f-a', '織田領');
    let root = withLeaf(emptyProject(), a, 1000); // anchor 1 @1000: 織田領
    root = renameLeafAt(root, a, '豊臣領', 1100); // anchor 2 @1100: 豊臣領
    renderWith(root);
    fireEvent.click(screen.getByTestId('list-mode-history')); // 通史 mode holds the anchor rows.

    // The two anchor rows are keyed by anchor id (feature id @ anchor year).
    const firstRow = screen.getByTestId('event-list-item-anchor:f-a@1000');
    const secondRow = screen.getByTestId('event-list-item-anchor:f-a@1100');

    // The OLD name shows on the first anchor's row; the NEW name on the second.
    // (The bug rendered the first name '織田領' on BOTH rows.)
    expect(firstRow.textContent?.trim()).toBe('織田領');
    expect(secondRow.textContent?.trim()).toBe('豊臣領');
  });

  // Regression (BUGHUNT R3): an unnamed feature is the DEFAULT (the add form
  // commits an empty name), so its attributes.name is present-but-blank (''). A
  // bare `name ?? id` never fires for '' and the イベント一覧 row rendered as a
  // blank, illegible button. The row must defer to the domain fallback rule and
  // show the feature id — matching the 地物一覧 — so every row is identifiable.
  it('falls back to the feature id when an event owner feature is unnamed', () => {
    const a = squareLeaf('f-5-4', ''); // unnamed (default) — present-but-blank name.
    const root = withLeaf(emptyProject(), a, 1000);
    renderWith(root);

    // 現在時刻 (default) already shows the id fallback…
    const features = screen.getByTestId('unified-list');
    expect(within(features).getByText('f-5-4')).toBeInTheDocument();

    // …and the 通史 row must show the SAME visible id, never a blank button.
    fireEvent.click(screen.getByTestId('list-mode-history'));
    const events = screen.getByTestId('unified-list');
    const row = within(events).getByText('f-5-4');
    expect(row).toBeInTheDocument();
    expect(row.textContent?.trim()).not.toBe('');
  });
});

// HB5-3 — the錨一覧 row is the ONLY selection導線 that also focuses the camera. It must
// (a) still promote the feature + sync the time through the SAME store path, and (b)
// then invoke the host's camera-focus callback with the row's feature AFTER the time
// sync, so the host resolves the shape at the錨の開始 time. A map-click selection goes
// through the live-selection-port (not this component) so it never focuses — that is
// guaranteed by construction (only this row calls the callback).
describe('SidebarContent — HB5-3 錨起点の視点合わせ', () => {
  function renderWithFocus(root: DomainRoot, startTime = timePointYear(1500)) {
    const store = createSessionStore<DomainRoot>({
      initialDomain: root,
      initial: { currentTime: startTime },
    });
    const focusCalls: { id: string; timeYearAtCall: number }[] = [];
    const sidebar = buildSidebarContent<DomainRoot>({
      store,
      getRoot: () => store.getState().domain,
      getTime: () => store.getState().currentTime,
      calendar,
      onFocusFeatureCamera: (id) => {
        // Capture the time AT THE MOMENT the focus fires to prove ordering.
        focusCalls.push({
          id: id as unknown as string,
          timeYearAtCall: store.getState().currentTime.year,
        });
      },
    });
    const utils = render(<Sidebar {...sidebar} />);
    return { store, focusCalls, ...utils };
  }

  it('clicking an錨 row selects the feature, syncs the time, THEN focuses the camera', () => {
    const a = squareLeaf('f-a', '織田領');
    const root = withLeaf(emptyProject(), a, 1000);
    const { store, focusCalls } = renderWithFocus(root, timePointYear(1500));

    fireEvent.click(screen.getByTestId('list-mode-history')); // 通史 mode holds the 錨 rows.
    fireEvent.click(screen.getByTestId('event-list-item-anchor:f-a@1000'));

    // (a) selection + time synced through the store (single truth source, unchanged).
    expect(store.getState().activeFeature).toBe(a.feature.id);
    expect(store.getState().currentTime.year).toBe(1000);
    // (b) camera focus fired ONCE, for the row's feature, AFTER the time sync (sees 1000).
    expect(focusCalls).toHaveLength(1);
    expect(focusCalls[0]!.id).toBe('f-a');
    expect(focusCalls[0]!.timeYearAtCall).toBe(1000);
  });

  it('still selects + syncs time when NO camera-focus callback is wired (honest absence)', () => {
    const a = squareLeaf('f-a', '織田領');
    const root = withLeaf(emptyProject(), a, 1000);
    // The default renderWith wires NO onFocusFeatureCamera.
    const { store } = renderWith(root);
    fireEvent.click(screen.getByTestId('list-mode-history'));
    fireEvent.click(screen.getByTestId('event-list-item-anchor:f-a@1000'));
    expect(store.getState().activeFeature).toBe(a.feature.id);
    expect(store.getState().currentTime.year).toBe(1000);
  });

  // A1 (ユーザー要望「地物一覧にも視点移動が欲しい」): a 地物一覧 row must ALSO focus the
  // camera through the SAME onFocusFeatureCamera path 錨一覧 uses. The feature is effective
  // NOW, so it selects + fits WITHOUT a time sync (unlike錨一覧, which snaps the time first).
  it('clicking a 地物一覧 row selects the feature AND focuses the camera, with no time sync (A1)', () => {
    const a = squareLeaf('f-a', '織田領'); // effective [1000,1100]
    const root = withLeaf(emptyProject(), a, 1000);
    // Start the session WITHIN the feature's interval so it appears in the 地物一覧.
    const { store, focusCalls } = renderWithFocus(root, timePointYear(1050));

    fireEvent.click(screen.getByTestId('feature-list-item-f-a'));

    // Selection promoted through the single store path; the time is UNCHANGED (no sync).
    expect(store.getState().activeFeature).toBe(a.feature.id);
    expect(store.getState().currentTime.year).toBe(1050);
    // The camera focus fired ONCE for the row's feature, at the current (unchanged) time.
    expect(focusCalls).toHaveLength(1);
    expect(focusCalls[0]!.id).toBe('f-a');
    expect(focusCalls[0]!.timeYearAtCall).toBe(1050);
  });
});

// A1 一覧フィルタ (ユーザー要望「一覧に検索が欲しい」): the shared list core adds a name
// partial-match filter with a live count, to BOTH the 地物一覧 and the 錨一覧 (共通コア). The
// filter folds width/case identically to the FR-99 search so the two agree (整合).
describe('SidebarContent — A1 一覧フィルタ (検索)', () => {
  it('filters the 地物一覧 by name (partial match) and shows the 一致/全件 count', () => {
    let root = withLeaf(emptyProject(), squareLeaf('f-oda', '織田領'), 1000);
    root = withLeaf(root, squareLeaf('f-toku', '徳川領'), 1000);
    renderWith(root); // currentTime = 1000 → both features effective (現在時刻 mode default).

    // Both rows present; the count shows the total (no filter yet).
    expect(screen.getByTestId('feature-list-item-f-oda')).toBeInTheDocument();
    expect(screen.getByTestId('feature-list-item-f-toku')).toBeInTheDocument();
    expect(screen.getByTestId('unified-list-count').textContent).toBe('2件');

    // A partial name keeps only the matching row; the count reflects 一致 / 全件.
    fireEvent.change(screen.getByTestId('unified-list-filter'), {
      target: { value: '織田' },
    });
    expect(screen.getByTestId('feature-list-item-f-oda')).toBeInTheDocument();
    expect(screen.queryByTestId('feature-list-item-f-toku')).not.toBeInTheDocument();
    expect(screen.getByTestId('unified-list-count').textContent).toBe('1 / 2件');
  });

  it('shows the no-match message (not the empty state) when the filter excludes all rows', () => {
    const root = withLeaf(emptyProject(), squareLeaf('f-oda', '織田領'), 1000);
    renderWith(root);
    fireEvent.change(screen.getByTestId('unified-list-filter'), {
      target: { value: 'zzzz' },
    });
    // The rows are gone, a distinct no-match message shows (NOT unified-list-empty,
    // which means「0件」— here there IS data, it is just filtered out).
    expect(screen.getByTestId('unified-list-no-match')).toBeInTheDocument();
    expect(screen.queryByTestId('unified-list-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('feature-list-item-f-oda')).not.toBeInTheDocument();
    expect(screen.getByTestId('unified-list-count').textContent).toBe('0 / 1件');
  });

  it('filters the 通史 mode by name too (shared core, same behaviour)', () => {
    let root = withLeaf(emptyProject(), squareLeaf('f-oda', '織田領'), 1000);
    root = withLeaf(root, squareLeaf('f-toku', '徳川領'), 1000);
    renderWith(root);
    fireEvent.click(screen.getByTestId('list-mode-history'));

    expect(screen.getByTestId('unified-list-count').textContent).toBe('2件');
    fireEvent.change(screen.getByTestId('unified-list-filter'), {
      target: { value: '徳川' },
    });
    expect(
      screen.getByTestId('event-list-item-anchor:f-toku@1000'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('event-list-item-anchor:f-oda@1000'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('unified-list-count').textContent).toBe('1 / 2件');
  });

  it('resets the name filter when switching mode (モードごとに現行を踏襲)', () => {
    let root = withLeaf(emptyProject(), squareLeaf('f-oda', '織田領'), 1000);
    root = withLeaf(root, squareLeaf('f-toku', '徳川領'), 1000);
    renderWith(root);
    // Filter in 現在時刻, then switch to 通史: the filter is empty again (keyed remount).
    fireEvent.change(screen.getByTestId('unified-list-filter'), { target: { value: '織田' } });
    expect(screen.getByTestId('unified-list-count').textContent).toBe('1 / 2件');
    fireEvent.click(screen.getByTestId('list-mode-history'));
    expect(screen.getByTestId('unified-list-count').textContent).toBe('2件');
    expect((screen.getByTestId('unified-list-filter') as HTMLInputElement).value).toBe('');
  });

  it('folds full-width / case so the 一覧フィルタ matches like the FR-99 検索 (整合)', () => {
    const root = withLeaf(emptyProject(), squareLeaf('f-rome', 'ROMA'), 1000);
    renderWith(root);
    // A full-width ｒ + lowercase query still matches 'ROMA' (NFKC + lowercase fold).
    fireEvent.change(screen.getByTestId('unified-list-filter'), {
      target: { value: 'ｒoma' },
    });
    expect(screen.getByTestId('feature-list-item-f-rome')).toBeInTheDocument();
    expect(screen.getByTestId('unified-list-count').textContent).toBe('1 / 1件');
  });
});

// FR-20 / FR-35 — the property panel's 面積（km²）row over the LIVE host wiring. The
// host resolves the area from the CURRENT domain + time + FR-109 store settings, so
// it must (穴1) re-derive after a structural edit that keeps the same feature id, and
// (穴2) show a 集約 feature's child-union area, not just a 末端's own shape.
describe('SidebarContent — 面積表示 (FR-20 / FR-35, bughunt review)', () => {
  /** GeoParams the host derives from the store's default projectSettings (FR-109). */
  function hostGeoParams(store: ReturnType<typeof renderWith>['store']) {
    const s = store.getState().projectSettings;
    return createGeoParams(s.equatorLengthKm, s.flattening);
  }

  /** The area the host WOULD compute for `featureId` at the current time (single truth
   * source: the SAME resolveFeatureArea + geodesy kernel the host uses). */
  function expectedAreaKm2(
    store: ReturnType<typeof renderWith>['store'],
    featureId: ReturnType<typeof asFeatureId>,
  ): number {
    const root = store.getState().domain;
    const time = store.getState().currentTime;
    const areaFeatures = featuresAt(root, time).filter(
      (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
    );
    const forest = buildForest(areaFeatures);
    const resolution = resolveFeatureArea(forest, verticesAt(root, time), featureId);
    if (resolution.status === 'failed') throw new Error('fixture resolution failed');
    return multiPolygonAreaKm2(resolution.area, hostGeoParams(store));
  }

  it('re-derives the leaf 面積 after a structural (shape) edit — no stale value (穴1)', () => {
    const a = squareLeaf('f-a', '尾張国', 0, 0, 2); // 2×2 square
    const root = withLeaf(emptyProject(), a, 1000);
    const { store } = renderWith(root);

    fireEvent.click(screen.getByTestId('feature-list-item-f-a'));
    const before = screen.getByTestId('area-value').textContent;
    expect(before).toBe(formatAreaKm2(expectedAreaKm2(store, a.feature.id)));

    // Commit a STRUCTURAL edit: the SAME feature id, a LARGER 4×4 shape (new vertex
    // coordinates). This swaps the committed `domain` reference; the panel keys its
    // resolved feature to the id (教訓 5.2), so ONLY a live re-resolution reflects the
    // new area. A stale memo (bughunt review 穴1) would keep the old 2×2 value.
    const bigger = squareLeaf('f-a', '尾張国', 0, 0, 4); // same id, 4×4 square
    const nextRoot = applyEditProposal(
      store.getState().domain,
      createEditProposal(bigger.feature.id, timePointYear(1000), {
        feature: bigger.feature,
        vertices: bigger.vertices,
      }),
      calendar,
    );
    act(() => {
      store.getState().setDomainState(nextRoot);
    });

    const after = screen.getByTestId('area-value').textContent;
    expect(after).not.toBe(before);
    expect(after).toBe(formatAreaKm2(expectedAreaKm2(store, bigger.feature.id)));
  });

  it('shows an 集約 feature 面積 = child union, not just 末端 (FR-35, 穴2)', () => {
    // Two edge-adjacent child leaves [0,2]² and [2,4]×[0,2] under one aggregate parent.
    const a = squareLeaf('child-a', 'ca', 0, 0, 2); // [0,2]×[0,2]
    const b = squareLeaf('child-b', 'cb', 2, 0, 2); // [2,4]×[0,2] — adjacent on x=2
    const childA: LeafFeature = { ...a.feature, parentId: asFeatureId('agg') };
    const childB: LeafFeature = { ...b.feature, parentId: asFeatureId('agg') };
    const aggregate: AggregateFeature = createAggregateFeature(
      asFeatureId('agg'),
      createBasicAttributes('尾張＋三河', 1000, 1100),
      color,
      [childA.id, childB.id],
    );
    let root = withLeaf(emptyProject(), { feature: childA, vertices: a.vertices }, 1000);
    root = withLeaf(root, { feature: childB, vertices: b.vertices }, 1000);
    root = applyAddProposal(
      root,
      createEditProposal(aggregate.id, timePointYear(1000), {
        feature: aggregate,
        vertices: [],
        sharedCandidateIds: new Map(),
      }),
    );
    const { store } = renderWith(root);

    // Select the AGGREGATE (via the store, the same path the 地物一覧 uses).
    act(() => {
      store.getState().setActiveFeature(aggregate.id);
    });

    // The 面積 row is present for the aggregate (穴2: NOT leaf-only) and equals the
    // child UNION area — the two adjacent squares union to a 4×2 rectangle, which is
    // what resolveFeatureArea returns and the geodesy kernel measures (単一真実源).
    expect(screen.getByTestId('area-row')).toBeInTheDocument();
    const shown = screen.getByTestId('area-value').textContent;
    expect(shown).toBe(formatAreaKm2(expectedAreaKm2(store, aggregate.id)));
    // Sanity: the union area exceeds a single child's area (it spans both children).
    expect(expectedAreaKm2(store, aggregate.id)).toBeGreaterThan(
      expectedAreaKm2(store, childA.id),
    );
  });

  it('shows NO 面積 row for a CHILDLESS 集約 — no fabricated 0 (集約穴)', () => {
    // A childless aggregate (or one whose only children are point / line) resolves via
    // resolveFeatureArea to status 'ok' + EMPTY_MULTI_POLYGON, so the km² kernel would
    // yield 0. The panel must show NO 面積 row (parity with the map, which draws nothing)
    // rather than a fabricated '0.00 km²' — the honest-stub contract (bughunt review 集約穴).
    const aggregate: AggregateFeature = createAggregateFeature(
      asFeatureId('agg-empty'),
      createBasicAttributes('空集約', 1000, 1100),
      color,
      [], // no children → empty derived shape
    );
    const root = applyAddProposal(
      emptyProject(),
      createEditProposal(aggregate.id, timePointYear(1000), {
        feature: aggregate,
        vertices: [],
        sharedCandidateIds: new Map(),
      }),
    );
    const { store } = renderWith(root);

    act(() => {
      store.getState().setActiveFeature(aggregate.id);
    });

    // No fabricated value: the 面積 row is ABSENT (not '0.00 km²').
    expect(screen.queryByTestId('area-row')).not.toBeInTheDocument();
  });
});

// FR-20 perf (bughunt #6): the area resolver must not run its O(histories × anchors)
// `featuresAt` scan TWICE per resolve, and re-renders that leave the area inputs
// (domain / currentTime / geoParams) UNCHANGED must reuse the panel's memoized area
// rather than re-deriving it every frame during a time scrub / playback. The fix
// (a) computes the effective feature set ONCE inside the resolver and (b) memoizes the
// resolver so its reference — the panel's area-memo key — is stable when its inputs are.
describe('SidebarContent — 面積 resolve is not recomputed per frame (FR-20 perf, bughunt #6)', () => {
  it('runs featuresAt ONCE per area resolve (no double scan) on a same-interval scrub', () => {
    const a = squareLeaf('f-a', '尾張国', 0, 0, 2);
    const root = withLeaf(emptyProject(), a, 1000);
    const { store } = renderWith(root);
    fireEvent.click(screen.getByTestId('feature-list-item-f-a'));
    // The 面積 row is shown, so the resolver DID run and produced a value.
    expect(screen.getByTestId('area-value').textContent).not.toBe('');

    // Now count the scans of a SINGLE fresh area resolution: scrub the time to a new
    // instant WITHIN the same anchor interval (1000..1100) with the SAME committed
    // domain. This re-renders the 地物一覧 (FeaturesSection, exactly ONE featuresAt scan),
    // the property host (a fresh area resolve, exactly ONE scan — the bughunt #6 no-
    // double-scan invariant this test protects), and the panel's `feature` memo, which is
    // keyed to [featureLookup, targetFeatureId, currentTime]. That currentTime dep is the
    // bughunt 第12波 #1 data-safety fix: a多錨 feature shows a DIFFERENT snapshot at each
    // anchor, so `feature` MUST re-resolve on a time move (via featureLookup.featureAt →
    // one more featuresAt scan) — otherwise a stale earlier-anchor snapshot is written
    // onto the current anchor on save. イベント一覧 subscribes only to `domain` (no scan).
    // The host's FR-81 ownerLookup (S4b 結線) ALSO re-derives on a time move — ONE
    // resolveDisplayFor compute for the NEW (root, time, control) generation = ONE more
    // featuresAt scan here. (In the shipped app that generation is SHARED with the
    // renderer / hit-test via the display-resolution memo — a cache hit, not an extra
    // pipeline run; under jsdom no renderer resolved it first, so the host's compute IS
    // the generation's single run.)
    // So the delta MUST be exactly: FeaturesSection(1) + area resolver(1) + feature
    // re-resolve(1) + ownerLookup display resolution(1) = 4. The bughunt #6 regression
    // this test guards (a DOUBLE scan inside the area resolver) would make the delta 5.
    featuresAtCalls.count = 0;
    act(() => {
      store.getState().setCurrentTime(timePointYear(1050), TIME_CHANGE_SOURCE.Slider);
    });
    // The area is unchanged (same shape at the new instant) but the row is still shown.
    expect(screen.getByTestId('area-value').textContent).not.toBe('');
    expect(featuresAtCalls.count).toBe(4);
  });

  it('reuses the memoized area (no resolve) on a re-render that leaves area inputs unchanged', () => {
    const a = squareLeaf('f-a', '尾張国', 0, 0, 2);
    const root = withLeaf(emptyProject(), a, 1000);
    const { store } = renderWith(root);
    fireEvent.click(screen.getByTestId('feature-list-item-f-a'));

    // A selection re-validation (setActiveFeature to the SAME id) re-renders the panel
    // via its selection subscription WITHOUT changing the area inputs (domain / time /
    // geoParams). The host does NOT re-render (it subscribes to none of those slices),
    // so its `resolveAreaKm2` reference is stable and the panel's area memo — keyed to
    // [targetFeatureId, resolveAreaKm2] — is REUSED: the resolver runs zero times.
    featuresAtCalls.count = 0;
    act(() => {
      store.getState().setActiveFeature(a.feature.id);
    });
    expect(featuresAtCalls.count).toBe(0);
  });
});
