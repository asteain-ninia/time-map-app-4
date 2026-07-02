// HB3-9 regression: the edit-handles render layer (FR-87 / FR-17). Locks that a
// resolved domain `EditHandles` set is turned into screen-fixed `HandlePrimitive`s — the
// render接続 that was missing (computeHandles had NO render consumer, 診断 HB3-9).

import { describe, expect, it } from 'vitest';

import type { EditHandles } from '../domain/editing/handles';
import { HANDLE_KIND } from '../domain/editing/handles';
import { asFeatureId, asVertexId, type VertexId } from '../domain/ids';

import {
  buildEditHandlePrimitives,
  DEFAULT_EDIT_HANDLE_STYLE,
} from './edit-handles-layer';
import type { HandlePrimitive } from './map-renderer';

function sampleHandles(): EditHandles {
  return {
    vertices: [
      {
        kind: HANDLE_KIND.Vertex,
        featureId: asFeatureId('f1'),
        vertexId: asVertexId('v1'),
        position: { lon: 10, lat: 20 },
      },
      {
        kind: HANDLE_KIND.Vertex,
        featureId: asFeatureId('f1'),
        vertexId: asVertexId('v2'),
        position: { lon: 30, lat: 40 },
      },
    ],
    edges: [
      {
        kind: HANDLE_KIND.Edge,
        featureId: asFeatureId('f1'),
        startVertexId: asVertexId('v1'),
        endVertexId: asVertexId('v2'),
        midpoint: { lon: 20, lat: 30 },
      },
    ],
  };
}

describe('buildEditHandlePrimitives (HB3-9)', () => {
  it('emits one handle primitive per vertex AND per edge midpoint (受け入れ基準1)', () => {
    const prims = buildEditHandlePrimitives(sampleHandles());
    const handles = prims.filter((p): p is HandlePrimitive => p.kind === 'handle');
    expect(handles).toHaveLength(3); // 2 vertices + 1 edge
    expect(handles.filter((h) => h.handleKind === 'vertex')).toHaveLength(2);
    expect(handles.filter((h) => h.handleKind === 'edge')).toHaveLength(1);
  });

  it('places handles at the WORLD vertex position / edge midpoint (教訓5.29 一致)', () => {
    const prims = buildEditHandlePrimitives(sampleHandles());
    const handles = prims.filter((p): p is HandlePrimitive => p.kind === 'handle');
    const vertexHandles = handles.filter((h) => h.handleKind === 'vertex');
    const edgeHandle = handles.find((h) => h.handleKind === 'edge')!;
    expect(vertexHandles.map((h) => h.at)).toEqual([
      { lon: 10, lat: 20 },
      { lon: 30, lat: 40 },
    ]);
    expect(edgeHandle.at).toEqual({ lon: 20, lat: 30 });
  });

  it('carries SCREEN-FIXED sizes (FR-17): radiusPx / strokeWidthPx are CSS px constants', () => {
    const prims = buildEditHandlePrimitives(sampleHandles());
    const handles = prims.filter((p): p is HandlePrimitive => p.kind === 'handle');
    for (const h of handles) {
      expect(Number.isFinite(h.radiusPx)).toBe(true);
      expect(h.radiusPx).toBeGreaterThan(0);
      expect(h.strokeWidthPx).toBe(DEFAULT_EDIT_HANDLE_STYLE.strokeWidthPx);
    }
  });

  it('draws vertices AFTER edges so a move handle sits on top of an add handle (教訓5.14)', () => {
    const prims = buildEditHandlePrimitives(sampleHandles());
    const kinds = prims
      .filter((p): p is HandlePrimitive => p.kind === 'handle')
      .map((h) => h.handleKind);
    // The single edge handle precedes both vertex handles.
    expect(kinds.indexOf('edge')).toBeLessThan(kinds.indexOf('vertex'));
  });

  it('returns an empty array for an empty handle set (受け入れ基準: 非存在は描画指示に現れない)', () => {
    expect(buildEditHandlePrimitives({ vertices: [], edges: [] })).toEqual([]);
  });
});

describe('buildEditHandlePrimitives shared-vertex distinction (FR-30)', () => {
  it('fills a SHARED vertex handle with sharedVertexFill and a normal one with vertexFill', () => {
    const shared: ReadonlySet<VertexId> = new Set([asVertexId('v1')]);
    const prims = buildEditHandlePrimitives(
      sampleHandles(),
      DEFAULT_EDIT_HANDLE_STYLE,
      shared,
    );
    const vertexHandles = prims
      .filter((p): p is HandlePrimitive => p.kind === 'handle')
      .filter((h) => h.handleKind === 'vertex');
    // v1 is shared → sharedVertexFill; v2 is not → normal vertexFill.
    expect(vertexHandles[0]!.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.sharedVertexFill);
    expect(vertexHandles[1]!.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.vertexFill);
    // Edge handles are never re-colored by sharing.
    const edge = prims
      .filter((p): p is HandlePrimitive => p.kind === 'handle')
      .find((h) => h.handleKind === 'edge')!;
    expect(edge.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.edgeFill);
  });

  it('uses the normal vertexFill for ALL vertices when no shared set is supplied', () => {
    const prims = buildEditHandlePrimitives(sampleHandles());
    const vertexHandles = prims
      .filter((p): p is HandlePrimitive => p.kind === 'handle')
      .filter((h) => h.handleKind === 'vertex');
    for (const h of vertexHandles) {
      expect(h.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.vertexFill);
    }
  });

  it('uses the normal vertexFill when the shared set contains none of the vertices', () => {
    const shared: ReadonlySet<VertexId> = new Set([asVertexId('zzz')]);
    const prims = buildEditHandlePrimitives(sampleHandles(), DEFAULT_EDIT_HANDLE_STYLE, shared);
    const vertexHandles = prims
      .filter((p): p is HandlePrimitive => p.kind === 'handle')
      .filter((h) => h.handleKind === 'vertex');
    for (const h of vertexHandles) {
      expect(h.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.vertexFill);
    }
  });
});
