// UI — useKnifeTargetShape 回帰ロック (bughunt: 「選択中リーフがあると pan/zoom の
// 毎フレームで React 再レンダーが発生」, 技術方針 2.3「camera は React 描画パスに乗せない」).
//
// WHY THIS SPEC EXISTS:
// useKnifeTargetShape mirrors the selected leaf's resolved shape into React state
// via a store.subscribe bridge. The bare subscription fired on EVERY set(), and a
// pan / wheel emits two camera set()s per frame (updateCamera + setCenterLon).
// `leafShapeAt` allocates a FRESH GeoMultiPolygon every call, so the old
// unconditional `setShape(compute())` handed React a new reference on every camera
// frame and forced a per-frame re-render of App + KnifeToolController while a leaf
// was selected — putting the camera on the React render path.
//
// The fix gates the recompute on the ONLY inputs leafShapeAt reads
// (activeFeature / currentTime / domain). This spec locks that behaviour:
//   - a camera-only change does NOT change the hook's output reference, and does
//     NOT re-run the hook body (no re-render);
//   - a selection / time / domain change STILL flows through (the gate is a
//     skip, not a freeze).

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useKnifeTargetShape } from './App';
import { createSessionStore } from './state/store';
import type { DomainRoot } from './consistency-binding';
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

describe('useKnifeTargetShape — camera は React 描画パスに乗せない (回帰ロック)', () => {
  it('a camera-only change does NOT recompute the shape (no per-frame re-render)', () => {
    const leaf = squareLeaf('f-a', 'va', 0, 0);
    const root = withLeaf(emptyProject(), leaf, 1000);
    const store = createSessionStore<DomainRoot>({
      initialDomain: root,
      initial: { currentTime: timePointYear(1000), activeFeature: leaf.feature.id },
    });

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useKnifeTargetShape(store);
    });

    // A leaf is selected, so the shape resolved on mount.
    const initialShape = result.current;
    expect(initialShape).toBeDefined();
    expect(initialShape!.length).toBeGreaterThan(0);

    const rendersAfterMount = renders;

    // Simulate ONE pan/wheel frame: the live cameraPort.write path emits exactly
    // these two set()s per frame (updateCamera + setCenterLon, App.tsx). Before the
    // fix each of these fired the subscriber, recomputed leafShapeAt (a fresh
    // array), and setShape'd a new reference → a re-render per set().
    act(() => {
      store.getState().updateCamera({ zoom: 2, centerLon: 5, centerLat: 3 });
      store.getState().setCenterLon(5);
    });

    // The output reference is UNCHANGED (no new shape allocated into state) and the
    // hook body did NOT re-run for the camera frame.
    expect(result.current).toBe(initialShape);
    expect(renders).toBe(rendersAfterMount);

    // Many more camera frames must stay free of re-renders (drag = many frames).
    act(() => {
      for (let i = 0; i < 20; i += 1) {
        store.getState().updateCamera({ centerLon: i });
        store.getState().setCenterLon(i);
      }
    });
    expect(result.current).toBe(initialShape);
    expect(renders).toBe(rendersAfterMount);
  });

  it('a time change STILL flows through the gate (skip, not freeze)', () => {
    const leaf = squareLeaf('f-a', 'va', 0, 0);
    // A single open-ended anchor at year 1000: the leaf is present at every time
    // ≥ 1000, so a jump to 1500 keeps it selectable and re-resolves its shape.
    const root = withLeaf(emptyProject(), leaf, 1000);
    const store = createSessionStore<DomainRoot>({
      initialDomain: root,
      initial: { currentTime: timePointYear(1000), activeFeature: leaf.feature.id },
    });

    const { result } = renderHook(() => useKnifeTargetShape(store));
    const at1000 = result.current;
    expect(at1000).toBeDefined();

    act(() => {
      store.getState().setCurrentTime(timePointYear(1500), 'numericJump');
    });

    // The shape recomputed for the new time: the gate let the time change through
    // (a fresh leafShapeAt allocation, so a NEW reference even for the same geom).
    expect(result.current).toBeDefined();
    expect(result.current).not.toBe(at1000);
  });

  it('a selection change STILL flows through the gate', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const b = squareLeaf('f-b', 'vb', 50, 50);
    let root = withLeaf(emptyProject(), a, 1000);
    root = withLeaf(root, b, 1000);
    const store = createSessionStore<DomainRoot>({
      initialDomain: root,
      initial: { currentTime: timePointYear(1000) },
    });

    const { result } = renderHook(() => useKnifeTargetShape(store));
    // No active feature → no shape.
    expect(result.current).toBeUndefined();

    act(() => {
      store.getState().setActiveFeature(a.feature.id);
    });
    expect(result.current).toBeDefined();
    expect(result.current!.length).toBeGreaterThan(0);

    // Clearing selection drops the shape again.
    act(() => {
      store.getState().setActiveFeature(null);
    });
    expect(result.current).toBeUndefined();
  });
});
