// U20 / shell — SidebarContent wiring tests (HB-3 regression).
//
// HB-3: the sidebar slots were never wired in the composition root, so the
// PropertyPanel / 地物一覧 / イベント一覧 never mounted. These tests assert the slots
// build over the LIVE store + domain root: the property panel resolves the active
// feature, the 地物一覧 lists committed features and promotes one through the SAME
// store.setActiveFeature path, and the property panel then re-resolves to it.

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createEditProposal } from '../../domain/consistency/index';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature, type LeafFeature } from '../../domain/feature';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createGeoParams } from '../../domain/geo/geo-params';
import type { AddSnapshot } from '../../domain/add/index';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';

import type { DomainRoot } from '../consistency-binding';
import { createSessionStore } from '../state/store';
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

function squareLeaf(idRaw: string, name: string): { feature: LeafFeature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${idRaw}-v${i}`), { lon: c[0]!, lat: c[1]! }),
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
