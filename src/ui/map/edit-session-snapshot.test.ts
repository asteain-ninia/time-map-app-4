// U40↔U24 — the after-state snapshot builder for an FR-87 edge-add release. Proves
// buildEditSnapshot turns an EDIT_TOOL.EdgeAdd DragSession into a FeatureSnapshot whose
// feature record has the new vertex spliced onto the pressed edge (via the domain
// addVertexToLine / addVertexToLeafRing ops) and whose vertex body sits at the drag's
// final preview. Built from the REAL domain factories (教訓 5.39).

import { describe, expect, it } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';
import { createVertexStore, getVertex } from '../../domain/vertex';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  lineFeature,
  squareLeaf,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import {
  EDIT_TOOL,
  beginDrag,
  updateDrag,
  type DragTarget,
} from '../../domain/editing/drag-session';
import { FEATURE_KIND } from '../../domain/feature';

import { buildEditSnapshot, type EditSnapshotContext } from './edit-session-snapshot';

function ctxFor(root: DomainProject): EditSnapshotContext {
  return { getRoot: () => root, getTime: () => timePointYear(10) };
}

describe('buildEditSnapshot — EDIT_TOOL.EdgeAdd (FR-87)', () => {
  it('adds a new vertex on a LINE edge, splicing the id between the endpoints', () => {
    const ln = lineFeature('ln-1', '街道'); // vertices ln-1-a (0,0) → ln-1-b (5,5)
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('ln-1', [ln.feature], createVertexStore(ln.vertices), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const target: DragTarget = {
      tool: EDIT_TOOL.EdgeAdd,
      featureId: asFeatureId('ln-1'),
      startVertexId: asVertexId('ln-1-a'),
      endVertexId: asVertexId('ln-1-b'),
      newVertexId: asVertexId('new-1'),
    };
    // Press at the edge midpoint, drag the new vertex to (3, 2).
    let session = beginDrag(target, { lon: 2.5, lat: 2.5 });
    session = updateDrag(session, { preview: { lon: 3, lat: 2 } });

    const snapshot = buildEditSnapshot(ctxFor(root), session);
    expect(snapshot.feature).toBeDefined();
    expect(snapshot.feature!.kind).toBe(FEATURE_KIND.Line);
    if (snapshot.feature!.kind === FEATURE_KIND.Line) {
      // The new id is spliced between a and b: [a, new, b].
      expect(snapshot.feature!.vertexIds).toEqual([
        asVertexId('ln-1-a'),
        asVertexId('new-1'),
        asVertexId('ln-1-b'),
      ]);
    }
    // The new vertex body is carried at the drag's final preview.
    expect(snapshot.vertices).toHaveLength(1);
    expect(snapshot.vertices[0]!.id).toBe(asVertexId('new-1'));
    expect(snapshot.vertices[0]!.coordinate).toEqual({ lon: 3, lat: 2 });
  });

  it('adds a new vertex on a LEAF ring edge, splicing between the ring endpoints', () => {
    const leaf = squareLeaf('leaf-1', 'A国', 0, 0, 10); // ring leaf-1-r, verts leaf-1-0..3
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('leaf-1', [leaf.feature], createVertexStore(leaf.vertices), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const target: DragTarget = {
      tool: EDIT_TOOL.EdgeAdd,
      featureId: asFeatureId('leaf-1'),
      ringId: asRingId('leaf-1-r'),
      startVertexId: asVertexId('leaf-1-0'),
      endVertexId: asVertexId('leaf-1-1'),
      newVertexId: asVertexId('new-1'),
    };
    let session = beginDrag(target, { lon: 5, lat: 0 });
    session = updateDrag(session, { preview: { lon: 5, lat: 1 } });

    const snapshot = buildEditSnapshot(ctxFor(root), session);
    expect(snapshot.feature).toBeDefined();
    expect(snapshot.feature!.kind).toBe(FEATURE_KIND.Leaf);
    if (snapshot.feature!.kind === FEATURE_KIND.Leaf) {
      const ring = snapshot.feature!.shape.rings.find((r) => r.id === asRingId('leaf-1-r'));
      expect(ring!.vertexIds).toEqual([
        asVertexId('leaf-1-0'),
        asVertexId('new-1'),
        asVertexId('leaf-1-1'),
        asVertexId('leaf-1-2'),
        asVertexId('leaf-1-3'),
      ]);
    }
    expect(snapshot.vertices).toHaveLength(1);
    const store = createVertexStore(snapshot.vertices);
    expect(getVertex(store, asVertexId('new-1'))!.coordinate).toEqual({ lon: 5, lat: 1 });
  });

  it('returns an EMPTY snapshot for a stale edge (endpoints not adjacent) — no half insert', () => {
    const ln = lineFeature('ln-1', '街道');
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('ln-1', [ln.feature], createVertexStore(ln.vertices), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const target: DragTarget = {
      tool: EDIT_TOOL.EdgeAdd,
      featureId: asFeatureId('ln-1'),
      // Reversed endpoints: b→a is not a forward edge of the open line, so no insert.
      startVertexId: asVertexId('ln-1-b'),
      endVertexId: asVertexId('ln-1-a'),
      newVertexId: asVertexId('new-1'),
    };
    let session = beginDrag(target, { lon: 2.5, lat: 2.5 });
    session = updateDrag(session, { preview: { lon: 3, lat: 2 } });

    const snapshot = buildEditSnapshot(ctxFor(root), session);
    expect(snapshot.feature).toBeUndefined();
    expect(snapshot.vertices).toHaveLength(0);
  });

  it('returns an EMPTY snapshot when a leaf edge-add has no ringId (safe no-op)', () => {
    const leaf = squareLeaf('leaf-1', 'A国', 0, 0, 10);
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('leaf-1', [leaf.feature], createVertexStore(leaf.vertices), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const target: DragTarget = {
      tool: EDIT_TOOL.EdgeAdd,
      featureId: asFeatureId('leaf-1'),
      startVertexId: asVertexId('leaf-1-0'),
      endVertexId: asVertexId('leaf-1-1'),
      newVertexId: asVertexId('new-1'),
      // ringId omitted → leaf edge-add cannot resolve the ring → empty snapshot.
    };
    let session = beginDrag(target, { lon: 5, lat: 0 });
    session = updateDrag(session, { preview: { lon: 5, lat: 1 } });

    const snapshot = buildEditSnapshot(ctxFor(root), session);
    expect(snapshot.feature).toBeUndefined();
    expect(snapshot.vertices).toHaveLength(0);
  });
});
