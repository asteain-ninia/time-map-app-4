// U20 / shell — SidebarContent wiring tests (HB-3 regression).
//
// HB-3: the sidebar slots were never wired in the composition root, so the
// PropertyPanel / 地物一覧 / イベント一覧 never mounted. These tests assert the slots
// build over the LIVE store + domain root: the property panel resolves the active
// feature, the 地物一覧 lists committed features and promotes one through the SAME
// store.setActiveFeature path, and the property panel then re-resolves to it.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
import { createSessionStore } from '../state/store';
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

  it('lists committed features in the 地物一覧 section', () => {
    const a = squareLeaf('f-a', '織田領');
    const root = withLeaf(emptyProject(), a, 1000);
    renderWith(root);
    const list = screen.getByTestId('feature-list');
    expect(within(list).getByText('織田領')).toBeInTheDocument();
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

  it('shows the empty-state guidance when there are no features / events', () => {
    renderWith(emptyProject());
    expect(screen.getByTestId('feature-list-empty')).toBeInTheDocument();
    expect(screen.getByTestId('event-list-empty')).toBeInTheDocument();
  });

  it('lists each feature anchor as an event row', () => {
    const a = squareLeaf('f-a', '織田領');
    const root = withLeaf(emptyProject(), a, 1000);
    renderWith(root);
    const list = screen.getByTestId('event-list');
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

    // The 地物一覧 already shows the id fallback…
    const features = screen.getByTestId('feature-list');
    expect(within(features).getByText('f-5-4')).toBeInTheDocument();

    // …and the イベント一覧 row must show the SAME visible id, never a blank button.
    const events = screen.getByTestId('event-list');
    const row = within(events).getByText('f-5-4');
    expect(row).toBeInTheDocument();
    expect(row.textContent?.trim()).not.toBe('');
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
