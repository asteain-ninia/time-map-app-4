// HB3-9 / HB3-4 — the active-feature edit-handle + live-drag PREVIEW render input.
//
// Proves (HB3-9) the handle layer is computed for the active feature, and (HB3-4) that a
// LIVE drag session moves the handles AND a preview outline to the preview position so
// the vertex / feature follows the cursor and release does not jump. Built from the REAL
// domain factories via the persistence fixtures (教訓 5.39: instantiate, never hand-write).

import { afterEach, describe, expect, it } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  pointFeature,
  squareLeaf,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import { asFeatureId, asVertexId } from '../../domain/ids';
import {
  EDIT_TOOL,
  beginDrag,
  updateDrag,
  type DragSession,
} from '../../domain/editing/drag-session';
import type { HandlePrimitive, LinePrimitive } from '../../render/map-renderer';
import type { DisplayControlInput } from '../../render/display-pipeline';

import { buildActiveFeatureHandlePrimitives } from './active-feature-handles';
import { clearDisplayResolutionCache } from './display-resolution-cache';

const DISPLAY: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

/** A project with one square leaf (4 vertices) effective from year 0. */
function leafProject() {
  const leaf = squareLeaf('leaf-1', 'A国', 0, 0, 10);
  const root: DomainProject = {
    histories: [
      singleAnchorHistory('leaf-1', [leaf.feature], createVertexStore(leaf.vertices), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
  return { root, leaf };
}

afterEach(() => clearDisplayResolutionCache());

function handles(prims: readonly { kind: string }[]): HandlePrimitive[] {
  return prims.filter((p): p is HandlePrimitive => p.kind === 'handle');
}
function vertexHandles(prims: readonly { kind: string }[]): HandlePrimitive[] {
  return handles(prims).filter((h) => h.handleKind === 'vertex');
}
function lines(prims: readonly { kind: string }[]): LinePrimitive[] {
  return prims.filter((p): p is LinePrimitive => p.kind === 'line');
}

describe('buildActiveFeatureHandlePrimitives (HB3-9 static handles)', () => {
  it('emits a vertex handle per vertex + edge handles for the active leaf', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
    );
    // 4 vertices + 4 closed-ring edges.
    expect(vertexHandles(prims)).toHaveLength(4);
    expect(handles(prims)).toHaveLength(8);
    // No live session → NO preview outline.
    expect(lines(prims)).toHaveLength(0);
  });

  it('returns no primitives when there is no active feature', () => {
    const { root } = leafProject();
    expect(
      buildActiveFeatureHandlePrimitives(root, timePointYear(0), null, DISPLAY),
    ).toEqual([]);
  });
});

describe('buildActiveFeatureHandlePrimitives (FR-110 vertexMarkerCap perf gate)', () => {
  it('draws ALL handles when the vertex count is <= cap', () => {
    const { root } = leafProject(); // 4-vertex square
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      4, // cap == count → still all handles
    );
    expect(vertexHandles(prims)).toHaveLength(4);
    expect(handles(prims)).toHaveLength(8);
  });

  it('suppresses ALL handles WHOLESALE (vertex + edge) when count > cap', () => {
    const { root } = leafProject(); // 4-vertex square
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      3, // 4 > 3 → nothing drawn (not a leading-N slice)
    );
    expect(handles(prims)).toHaveLength(0);
    expect(prims).toHaveLength(0);
  });

  it('cap === 0 suppresses all handles', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      0,
    );
    expect(handles(prims)).toHaveLength(0);
    expect(prims).toHaveLength(0);
  });

  it('undefined cap leaves handles unlimited (default behaviour)', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
    );
    expect(handles(prims)).toHaveLength(8);
  });

  it('gates the live-drag preview too when over cap (perf guard is wholesale)', () => {
    const { root } = leafProject();
    // A live vertex drag would normally draw handles + a preview outline; over cap
    // the whole handle path is suppressed (no partial preview).
    let session: DragSession = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('leaf-1'),
        vertexId: asVertexId('leaf-1-0'),
      } as const,
      { lon: 0, lat: 0 },
    );
    session = updateDrag(session, { preview: { lon: 3, lat: 4 } });
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
      undefined,
      undefined,
      1, // 4 > 1 → suppress everything, including the preview outline
    );
    expect(prims).toHaveLength(0);
  });
});

describe('buildActiveFeatureHandlePrimitives (HB3-4 live drag preview)', () => {
  it('moves the dragged vertex handle to the preview position (follows the cursor)', () => {
    const { root } = leafProject();
    // Drag vertex leaf-1-0 (committed at (0,0)) to (3,4).
    const target = {
      tool: EDIT_TOOL.VertexMove,
      featureId: asFeatureId('leaf-1'),
      vertexId: asVertexId('leaf-1-0'),
    } as const;
    let session: DragSession = beginDrag(target, { lon: 0, lat: 0 });
    session = updateDrag(session, { preview: { lon: 3, lat: 4 } });

    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
    );

    // The dragged vertex handle is now at the PREVIEW position, not the committed (0,0).
    const vh = vertexHandles(prims);
    expect(vh.some((h) => h.at.lon === 3 && h.at.lat === 4)).toBe(true);
    expect(vh.some((h) => h.at.lon === 0 && h.at.lat === 0)).toBe(false);
    // A live drag also draws a preview outline (so the SHAPE follows, not just handles).
    expect(lines(prims).length).toBeGreaterThanOrEqual(1);
    // The preview outline contains the moved vertex coordinate.
    expect(
      lines(prims).some((l) => l.points.some((p) => p.lon === 3 && p.lat === 4)),
    ).toBe(true);
  });

  it('a whole-feature move shifts EVERY vertex handle by the drag delta', () => {
    const { root } = leafProject();
    const target = {
      tool: EDIT_TOOL.FeatureMove,
      featureId: asFeatureId('leaf-1'),
    } as const;
    // Press at (1,1), drag to (6,3) → delta (+5,+2).
    let session: DragSession = beginDrag(target, { lon: 1, lat: 1 });
    session = updateDrag(session, { preview: { lon: 6, lat: 3 } });

    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
    );
    const vh = vertexHandles(prims);
    // Original corners (0,0),(10,0),(10,10),(0,10) shifted by (+5,+2).
    const moved = vh.map((h) => `${h.at.lon},${h.at.lat}`).sort();
    expect(moved).toEqual(['5,2', '15,2', '15,12', '5,12'].sort());
  });

  it('ignores a session that targets a DIFFERENT feature (no stale bleed)', () => {
    const { root } = leafProject();
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('other'),
        vertexId: asVertexId('x'),
      } as const,
      { lon: 99, lat: 99 },
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
    );
    // Committed positions only — no preview outline, handle still at (0,0).
    expect(lines(prims)).toHaveLength(0);
    expect(vertexHandles(prims).some((h) => h.at.lon === 0 && h.at.lat === 0)).toBe(true);
  });

  it('previews a point feature drag at the cursor', () => {
    const pt = pointFeature('pt-1', '首都', 50, 30);
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('pt-1', [pt.feature], createVertexStore([pt.vertex]), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const session = updateDrag(
      beginDrag(
        {
          tool: EDIT_TOOL.VertexMove,
          featureId: asFeatureId('pt-1'),
          vertexId: pt.vertex.id,
        } as const,
        { lon: 50, lat: 30 },
      ),
      { preview: { lon: 70, lat: 35 } },
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('pt-1'),
      DISPLAY,
      session,
    );
    // The vertex handle AND a preview point marker sit at the cursor.
    expect(vertexHandles(prims).some((h) => h.at.lon === 70 && h.at.lat === 35)).toBe(true);
    const points = prims.filter((p) => p.kind === 'point');
    expect(points.length).toBeGreaterThanOrEqual(1);
  });
});
