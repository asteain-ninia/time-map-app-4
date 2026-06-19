// U10 terminal-extraction tests — criterion 1 (FR-27 / 教訓5.25): aggregates are
// never indexed nor tested. We build a real forest (U08) with a leaf terminal
// and an aggregate, and confirm the aggregate never appears as a terminal shape
// nor in an overlap pair, even when its DERIVED area overlaps a terminal.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { buildForest } from '../hierarchy/forest';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';
import { detectTerminalOverlaps } from './overlap';
import { extractTerminalShapes } from './terminals';

const attrs = createBasicAttributes('n', 0, 100);
const color = createColorInfo(true, '#fff', '#0ff', '#000');

/**
 * Build a vertex store + a leaf feature whose single territory ring is the given
 * square. Returns the leaf and the vertex entries to merge into a shared store.
 */
function leafSquare(
  featureName: string,
  x: number,
  y: number,
  size: number,
  parentId?: FeatureId,
): { feature: Feature; vertices: ReturnType<typeof createVertex>[] } {
  const ringId = asRingId(`${featureName}-r`);
  const corners: WorldCoordinate[] = [
    createCoordinate(x, y),
    createCoordinate(x + size, y),
    createCoordinate(x + size, y + size),
    createCoordinate(x, y + size),
  ];
  const vertices = corners.map((c, i) => createVertex(asVertexId(`${featureName}-v${i}`), c));
  const ring = createTerritoryRing(
    ringId,
    vertices.map((v) => v.id),
  );
  const shape = createShape([ring]);
  const optional = parentId === undefined ? {} : { parentId };
  const feature = createLeafFeature(asFeatureId(featureName), attrs, color, shape, optional);
  return { feature, vertices };
}

function storeOf(...groups: ReturnType<typeof createVertex>[][]): VertexStore {
  return createVertexStore(groups.flat());
}

describe('criterion 1: aggregates excluded from terminal extraction (FR-27)', () => {
  it('an aggregate (feature with children) is never returned as a terminal shape', () => {
    // CHILD is a leaf under aggregate PARENT. The aggregate derives its area from
    // CHILD, so it spatially coincides with CHILD — yet it must NOT be a terminal.
    const child = leafSquare('CHILD', 0, 0, 10, asFeatureId('PARENT'));
    const parent = createAggregateFeature(
      asFeatureId('PARENT'),
      attrs,
      color,
      [asFeatureId('CHILD')],
    );
    const forest = buildForest([parent, child.feature]);
    const store = storeOf(child.vertices);

    const terminals = extractTerminalShapes(forest, store);
    const ids = new Set(terminals.map((t) => t.id));
    expect(ids.has(asFeatureId('CHILD'))).toBe(true);
    expect(ids.has(asFeatureId('PARENT'))).toBe(false);
  });

  it('the aggregate never appears in an overlap pair, even when its derived area overlaps a terminal', () => {
    // OUTSIDER is a standalone terminal overlapping CHILD's square. CHILD is under
    // aggregate PARENT. We expect exactly CHILD|OUTSIDER — PARENT must not appear
    // although PARENT's derived area (== CHILD) also overlaps OUTSIDER.
    const child = leafSquare('CHILD', 0, 0, 10, asFeatureId('PARENT'));
    const parent = createAggregateFeature(
      asFeatureId('PARENT'),
      attrs,
      color,
      [asFeatureId('CHILD')],
    );
    const outsider = leafSquare('OUTSIDER', 5, 0, 10);

    const forest = buildForest([parent, child.feature, outsider.feature]);
    const store = storeOf(child.vertices, outsider.vertices);

    const terminals = extractTerminalShapes(forest, store);
    const pairs = detectTerminalOverlaps(terminals, { seamTurns: [0] });
    const keys = new Set(pairs.map((p) => `${p.a}|${p.b}`));

    expect(keys.has('CHILD|OUTSIDER')).toBe(true);
    // PARENT (aggregate) must never be a member of any reported pair.
    for (const p of pairs) {
      expect(p.a).not.toBe(asFeatureId('PARENT'));
      expect(p.b).not.toBe(asFeatureId('PARENT'));
    }
  });
});
