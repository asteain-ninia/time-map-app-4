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

// --- FR-80 / FR-82 選択頂点・ドラッグ中頂点の視覚区別 --------------------------------
//
// The four quadrants the highlight must keep separable (共有 × 選択 の直交性):
//   非選択・非共有 / 選択・非共有 / 非選択・共有 / 選択∧共有 / ドラッグ中。
// The highlight is a COMPOSABLE outer ring — it must NEVER replace `fill`, because the
// FR-30 shared-vertex amber lives in `fill` and both facts have to stay readable.

function vh(prims: readonly { kind: string }[]): HandlePrimitive[] {
  return prims
    .filter((p): p is HandlePrimitive => p.kind === 'handle')
    .filter((h) => h.handleKind === 'vertex');
}

describe('buildEditHandlePrimitives selected/dragging vertex distinction (FR-80/FR-82)', () => {
  it('gives a SELECTED vertex a selection ring and leaves a non-selected one ringless', () => {
    const prims = buildEditHandlePrimitives(
      sampleHandles(),
      DEFAULT_EDIT_HANDLE_STYLE,
      undefined,
      { selectedVertexIds: new Set([asVertexId('v1')]) },
    );
    const [selected, plain] = vh(prims);
    expect(selected!.ring).toEqual({
      radiusPx:
        DEFAULT_EDIT_HANDLE_STYLE.vertexRadiusPx + DEFAULT_EDIT_HANDLE_STYLE.selectedRing.gapPx,
      stroke: DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke,
      widthPx: DEFAULT_EDIT_HANDLE_STYLE.selectedRing.widthPx,
    });
    expect(plain!.ring).toBeUndefined();
  });

  it('keeps the FR-30 shared amber FILL on a vertex that is BOTH shared and selected', () => {
    const prims = buildEditHandlePrimitives(
      sampleHandles(),
      DEFAULT_EDIT_HANDLE_STYLE,
      new Set([asVertexId('v1')]),
      { selectedVertexIds: new Set([asVertexId('v1')]) },
    );
    const both = vh(prims)[0]!;
    // 共有∧選択: the fill still says "shared", the ring says "selected" (両方読める).
    expect(both.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.sharedVertexFill);
    expect(both.ring?.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke);
  });

  it('gives a DRAGGING vertex a distinct ring from a merely selected one (FR-82 別スタイル)', () => {
    const prims = buildEditHandlePrimitives(
      sampleHandles(),
      DEFAULT_EDIT_HANDLE_STYLE,
      undefined,
      {
        selectedVertexIds: new Set([asVertexId('v1'), asVertexId('v2')]),
        draggingVertexIds: new Set([asVertexId('v1')]),
      },
    );
    const [dragging, selected] = vh(prims);
    expect(dragging!.ring).toEqual({
      radiusPx:
        DEFAULT_EDIT_HANDLE_STYLE.vertexRadiusPx + DEFAULT_EDIT_HANDLE_STYLE.draggingRing.gapPx,
      stroke: DEFAULT_EDIT_HANDLE_STYLE.draggingRing.stroke,
      widthPx: DEFAULT_EDIT_HANDLE_STYLE.draggingRing.widthPx,
    });
    // Dragging wins over Selected (the more specific category, 単一の分類順序).
    expect(dragging!.ring).not.toEqual(selected!.ring);
    expect(selected!.ring?.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke);
  });

  it('never rings an EDGE handle (only vertices carry selection state)', () => {
    const prims = buildEditHandlePrimitives(
      sampleHandles(),
      DEFAULT_EDIT_HANDLE_STYLE,
      undefined,
      { selectedVertexIds: new Set([asVertexId('v1'), asVertexId('v2')]) },
    );
    const edge = prims
      .filter((p): p is HandlePrimitive => p.kind === 'handle')
      .find((h) => h.handleKind === 'edge')!;
    expect(edge.ring).toBeUndefined();
  });

  it('emits no rings at all when no highlight input is supplied (default unchanged)', () => {
    for (const h of vh(buildEditHandlePrimitives(sampleHandles()))) {
      expect(h.ring).toBeUndefined();
    }
  });

  it('keeps the selection ring STRICTLY OUTSIDE the disc so the fill stays visible', () => {
    // 合成可能な強調の不変条件: ring radius > handle radius (never an over-paint).
    expect(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.gapPx).toBeGreaterThan(0);
    expect(DEFAULT_EDIT_HANDLE_STYLE.draggingRing.gapPx).toBeGreaterThan(
      DEFAULT_EDIT_HANDLE_STYLE.selectedRing.gapPx,
    );
    // And the three hues never collide (normal / shared / selected / dragging).
    const hues = new Set([
      DEFAULT_EDIT_HANDLE_STYLE.vertexFill,
      DEFAULT_EDIT_HANDLE_STYLE.sharedVertexFill,
      DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke,
      DEFAULT_EDIT_HANDLE_STYLE.draggingRing.stroke,
    ]);
    expect(hues.size).toBe(4);
  });
});
