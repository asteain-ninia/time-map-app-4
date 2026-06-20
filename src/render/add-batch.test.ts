import { describe, expect, it } from 'vitest';

import {
  ADD_TOOL_KIND,
  placeVertex,
  startSession,
  updatePreview,
} from '../domain/add/index';

import { DEFAULT_ADD_STYLE, buildAddPrimitives } from './add-batch';

const C = (lon: number, lat: number) => ({ lon, lat });

function face3() {
  let s = startSession(ADD_TOOL_KIND.Face);
  s = placeVertex(s, C(0, 0));
  s = placeVertex(s, C(2, 0));
  s = placeVertex(s, C(1, 2));
  return s;
}

describe('buildAddPrimitives (FR-78 / 教訓 5.18)', () => {
  it('a null session yields an empty frame', () => {
    expect(buildAddPrimitives(null)).toEqual([]);
  });

  it('draws a marker per placed vertex', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(1, 1));
    const prims = buildAddPrimitives(s);
    const markers = prims.filter((p) => p.kind === 'point');
    expect(markers).toHaveLength(2);
  });

  it('draws the placed-edge polyline for line/face (≥2 vertices)', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(1, 1));
    const lines = buildAddPrimitives(s).filter((p) => p.kind === 'line');
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('a face closing line is TRANSLUCENT and only drawn once closable (≥3)', () => {
    // 2 vertices: not closable yet — no closing line.
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(2, 0));
    const closingStroke = DEFAULT_ADD_STYLE.closingStroke;
    const before = buildAddPrimitives(s).filter(
      (p) => p.kind === 'line' && p.stroke === closingStroke,
    );
    expect(before).toHaveLength(0);

    // 3 vertices: closing line appears, with the translucent stroke.
    const s3 = face3();
    const closing = buildAddPrimitives(s3).filter(
      (p) => p.kind === 'line' && p.stroke === closingStroke,
    );
    expect(closing).toHaveLength(1);
    expect(closingStroke).toMatch(/rgba\(/);
  });

  it('a point tool never draws an edge or closing line', () => {
    let s = startSession(ADD_TOOL_KIND.Point);
    s = placeVertex(s, C(3, 3));
    s = updatePreview(s, C(4, 4));
    const lines = buildAddPrimitives(s).filter((p) => p.kind === 'line');
    expect(lines).toHaveLength(0);
  });

  it('draws a cursor-follow preview edge for line once a vertex + preview exist', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0));
    s = updatePreview(s, C(5, 5));
    const lines = buildAddPrimitives(s).filter((p) => p.kind === 'line');
    // The placed edge needs ≥2 vertices; with 1 vertex + preview the only line is
    // the preview edge.
    expect(lines).toHaveLength(1);
  });

  it('uses screen-fixed sizes (FR-17): marker radius / line width are px constants', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0));
    const marker = buildAddPrimitives(s).find((p) => p.kind === 'point');
    expect(marker && marker.kind === 'point' && marker.radiusPx).toBe(
      DEFAULT_ADD_STYLE.markerRadiusPx,
    );
  });
});
