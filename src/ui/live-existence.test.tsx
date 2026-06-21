// UI — live-existence resolver regression tests.
//
// REGRESSION (bughunt: the live store was created with NO ExistenceResolver, so a
// time change never deselected a feature/vertex that ceased to exist — the U22
// re-validation funnel was a silent no-op in the shipped app, FR-64/66/70). These
// tests pin BOTH halves of the fix:
//   1. createLiveExistenceResolver answers existence from the LIVE committed root
//      via the SAME featuresAt/verticesAt live-lookup the renderer/hit-test use.
//   2. A session store wired with that resolver (as App.tsx now does) drops the
//      active feature + vertex selection when setCurrentTime moves to a time the
//      feature no longer exists at, and keeps it while the feature is present.

import { describe, expect, it } from 'vitest';

import { createLiveExistenceResolver } from './live-existence';
import type { DomainRoot } from './consistency-binding';
import { createSessionStore, TIME_CHANGE_SOURCE, type SessionStore } from './state/store';
import type { StoreApi } from 'zustand/vanilla';
import { applyAddProposal } from '../domain/editing/apply-proposal';
import { createEditProposal } from '../domain/consistency/index';
import { timePointYear } from '../domain/time/time-point';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createLeafFeature, type LeafFeature } from '../domain/feature';
import { createShape, createTerritoryRing } from '../domain/ring';
import { createVertex, type Vertex } from '../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../domain/ids';
import { createGeoParams } from '../domain/geo/geo-params';
import type { AddSnapshot } from '../domain/add/index';

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

/** A 2×2 square leaf at the given lon/lat offset. */
function squareLeaf(
  idRaw: string,
  vPrefix: string,
  ox: number,
  oy: number,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: c[0]! + ox, lat: c[1]! + oy }),
  );
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

function snapshotOf(feature: LeafFeature, vertices: Vertex[]): AddSnapshot {
  return { feature, vertices, sharedCandidateIds: new Map() };
}

/** Commit one leaf at the given time and return the new root. */
function withLeaf(
  root: DomainRoot,
  leaf: { feature: LeafFeature; vertices: Vertex[] },
  year: number,
): DomainRoot {
  return applyAddProposal(
    root,
    createEditProposal(leaf.feature.id, timePointYear(year), snapshotOf(leaf.feature, leaf.vertices)),
  );
}

describe('createLiveExistenceResolver', () => {
  it('answers feature/vertex existence from the live committed root', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const root = withLeaf(emptyProject(), a, 1000);
    const resolver = createLiveExistenceResolver(() => root);
    const vid = a.vertices[0]!.id;

    // Present at and after the anchor time.
    expect(resolver.featureExistsAt(a.feature.id, timePointYear(1000))).toBe(true);
    expect(resolver.vertexExistsAt(a.feature.id, vid, timePointYear(1000))).toBe(true);

    // Absent BEFORE the anchor exists (bounded existence, lower edge).
    expect(resolver.featureExistsAt(a.feature.id, timePointYear(500))).toBe(false);
    expect(resolver.vertexExistsAt(a.feature.id, vid, timePointYear(500))).toBe(false);

    // An id that was never committed is never present.
    expect(resolver.featureExistsAt(asFeatureId('ghost'), timePointYear(1000))).toBe(false);
  });

  it('reads the root LIVE through the thunk (never a stale capture)', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    let root = emptyProject();
    const resolver = createLiveExistenceResolver(() => root);

    expect(resolver.featureExistsAt(a.feature.id, timePointYear(1000))).toBe(false);
    root = withLeaf(root, a, 1000); // swap the live root after the resolver was built
    expect(resolver.featureExistsAt(a.feature.id, timePointYear(1000))).toBe(true);
  });
});

describe('session store wired with the live existence resolver (App.tsx wiring)', () => {
  it('drops the active feature when a time change moves past its existence', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const root = withLeaf(emptyProject(), a, 1000);

    // Hold the store behind a ref so the resolver thunk can read it AFTER creation
    // (the same chicken/egg the App.tsx liveRootRef resolves).
    const ref: { store: StoreApi<SessionStore<DomainRoot>> | null } = { store: null };
    const store = createSessionStore<DomainRoot>({
      initialDomain: root,
      existence: createLiveExistenceResolver(() => ref.store!.getState().domain),
      initial: {
        activeFeature: a.feature.id,
        currentTime: timePointYear(1000),
      },
    });
    ref.store = store;

    // Selected while present.
    expect(store.getState().activeFeature).toBe(a.feature.id);

    // A time change BACK to before the feature exists must deselect it (FR-64/66/70).
    store.getState().setCurrentTime(timePointYear(500), TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().activeFeature).toBeNull();

    // Returning to a time it exists keeps it deselected (no auto-reselect), but a
    // re-selection then survives a time change that stays within existence.
    store.getState().setCurrentTime(timePointYear(2000), TIME_CHANGE_SOURCE.Slider);
    store.getState().setActiveFeature(a.feature.id);
    store.getState().setCurrentTime(timePointYear(3000), TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().activeFeature).toBe(a.feature.id);
  });

  it('drops the vertex selection when its vertices cease to exist at the new time', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const root = withLeaf(emptyProject(), a, 1000);

    const ref: { store: StoreApi<SessionStore<DomainRoot>> | null } = { store: null };
    const store = createSessionStore<DomainRoot>({
      initialDomain: root,
      existence: createLiveExistenceResolver(() => ref.store!.getState().domain),
      initial: { currentTime: timePointYear(1000) },
    });
    ref.store = store;
    store.getState().replaceVertexSelection(a.feature.id, [a.vertices[0]!.id, a.vertices[1]!.id]);
    expect(store.getState().selection.vertexIds.size).toBe(2);

    store.getState().setCurrentTime(timePointYear(500), TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().selection.vertexIds.size).toBe(0);
    expect(store.getState().selection.vertexOwner).toBeNull();
  });
});
