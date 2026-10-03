// 増分 8A（N-06）— 辺の中点の印のクリックで足す座標は「描いている印と同じ中点」。

import { afterEach, describe, expect, it } from 'vitest';

import { beginDrag, EDIT_TOOL } from '../../domain/editing/drag-session';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
  squareLeaf,
} from '../../domain/persistence/fixtures';
import { timePointYear } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';
import type { DisplayControlInput } from '../../render/display-pipeline';

import { clearDisplayResolutionCache, resolveDisplayFor } from './display-resolution-cache';
import { edgeAddMidpoint } from './edge-click';

const DISPLAY: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

afterEach(() => clearDisplayResolutionCache());

function project(ox: number): DomainProject {
  const leaf = squareLeaf('A', 'A国', ox, 0, 10);
  return {
    histories: [singleAnchorHistory('A', [leaf.feature], createVertexStore(leaf.vertices), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function edgeSession(start: string, end: string) {
  return beginDrag(
    {
      tool: EDIT_TOOL.EdgeAdd,
      featureId: asFeatureId('A'),
      startVertexId: asVertexId(start),
      endVertexId: asVertexId(end),
      ringId: asRingId('A-r'),
      newVertexId: asVertexId('new'),
    },
    { lon: 3, lat: 1 }, // 押した点（中点からずれている）
  );
}

describe('辺の中点', () => {
  it('押した点ではなく、辺のちょうど中点を返す', () => {
    const r = resolveDisplayFor(project(0), timePointYear(5), DISPLAY);
    expect(edgeAddMidpoint(r, edgeSession('A-0', 'A-1'))).toEqual({ lon: 5, lat: 0 });
  });

  it('経度 180° をまたぐ辺でも、描いている印と同じ中点（反対側の 0° ではない）', () => {
    // A-0 = (175, 0), A-1 = (185 → -175, 0)。
    const r = resolveDisplayFor(project(175), timePointYear(5), DISPLAY);
    const mid = edgeAddMidpoint(r, edgeSession('A-0', 'A-1'))!;
    expect(Math.abs(Math.abs(mid.lon) - 180)).toBeLessThan(1e-9);
  });

  it('押した所と同じ経度の巻きで返す（±360° の複製の上で押しても、確定が「半周以上」で断られない）', () => {
    const r = resolveDisplayFor(project(0), timePointYear(5), DISPLAY);
    // 東へ 1 周した複製の上（経度 363°）で押した。中点は 5° ではなく 365°。
    const onReplica = beginDrag(edgeSession('A-0', 'A-1').target, { lon: 363, lat: 1 });
    expect(edgeAddMidpoint(r, onReplica)).toEqual({ lon: 365, lat: 0 });
    // 経度 180° をまたぐ辺を、東側（179.9°）で押した。中点は −180° ではなく 180°。
    const seam = resolveDisplayFor(project(175), timePointYear(5), DISPLAY);
    const nearSeam = beginDrag(edgeSession('A-0', 'A-1').target, { lon: 179.9, lat: 0.2 });
    const mid = edgeAddMidpoint(seam, nearSeam)!;
    expect(mid.lon).toBeCloseTo(180, 9);
  });

  it('隣り合っていない 2 点・無い地物・辺を足す操作でないときは返さない', () => {
    const r = resolveDisplayFor(project(0), timePointYear(5), DISPLAY);
    expect(edgeAddMidpoint(r, edgeSession('A-0', 'A-2'))).toBeUndefined();
    const vertexMove = beginDrag(
      { tool: EDIT_TOOL.VertexMove, featureId: asFeatureId('A'), vertexId: asVertexId('A-0') },
      { lon: 0, lat: 0 },
    );
    expect(edgeAddMidpoint(r, vertexMove)).toBeUndefined();
    const s = edgeSession('A-0', 'A-1');
    const missing = { ...s, target: { ...s.target, featureId: asFeatureId('Z') } };
    expect(edgeAddMidpoint(r, missing)).toBeUndefined();
  });
});
