// HB3-9 regression: the edit-handles render layer (FR-87 / FR-17). Locks that a
// resolved domain `EditHandles` set is turned into screen-fixed `HandlePrimitive`s — the
// render接続 that was missing (computeHandles had NO render consumer, 診断 HB3-9).

import { describe, expect, it } from 'vitest';

import type { EditHandles } from '../domain/editing/handles';
import { HANDLE_KIND } from '../domain/editing/handles';

import {
  buildEditHandlePrimitives,
  DEFAULT_EDIT_HANDLE_STYLE,
} from './edit-handles-layer';
import type { HandlePrimitive } from './map-renderer';

const asFeatureId = (s: string): never => s as never; // branded id placeholder

function sampleHandles(): EditHandles {
  return {
    vertices: [
      {
        kind: HANDLE_KIND.Vertex,
        featureId: asFeatureId('f1'),
        vertexId: asFeatureId('v1'),
        position: { lon: 10, lat: 20 },
      },
      {
        kind: HANDLE_KIND.Vertex,
        featureId: asFeatureId('f1'),
        vertexId: asFeatureId('v2'),
        position: { lon: 30, lat: 40 },
      },
    ],
    edges: [
      {
        kind: HANDLE_KIND.Edge,
        featureId: asFeatureId('f1'),
        startVertexId: asFeatureId('v1'),
        endVertexId: asFeatureId('v2'),
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
