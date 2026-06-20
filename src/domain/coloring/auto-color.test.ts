import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../ids';
import { buildAdjacencyGraph, type AdjacencyEdge } from './adjacency';
import { computeColorPlan, computeColorPlanFor } from './auto-color';
import { deriveSelectedColor } from './color-math';
import { DEFAULT_PALETTE, colorAtIndex } from './palette';

function f(n: number): FeatureId {
  return asFeatureId(`f${String(n).padStart(2, '0')}`);
}

function graphOf(nodeCount: number, edges: ReadonlyArray<[number, number]>) {
  const nodes: FeatureId[] = [];
  for (let i = 0; i < nodeCount; i += 1) nodes.push(f(i));
  const adjEdges: AdjacencyEdge[] = edges.map(([a, b]) => ({ a: f(a), b: f(b) }));
  return buildAdjacencyGraph(nodes, adjEdges);
}

function allNodes(nodeCount: number): ReadonlySet<FeatureId> {
  const s = new Set<FeatureId>();
  for (let i = 0; i < nodeCount; i += 1) s.add(f(i));
  return s;
}

describe('auto-color: plan resolves index -> palette color + selected color', () => {
  it('assigns base palette colors and derives the selected color (FR-101)', () => {
    const g = graphOf(2, [[0, 1]]);
    const plan = computeColorPlan(g, DEFAULT_PALETTE, allNodes(2));
    const p0 = plan.get(f(0));
    const p1 = plan.get(f(1));
    expect(p0?.fillColor).toBe(colorAtIndex(DEFAULT_PALETTE, 0));
    expect(p1?.fillColor).toBe(colorAtIndex(DEFAULT_PALETTE, 1));
    expect(p0?.selectedColor).toBe(deriveSelectedColor(colorAtIndex(DEFAULT_PALETTE, 0)));
  });

  it('adjacent features get different fill colors (隣接同色ゼロ)', () => {
    const g = graphOf(3, [[0, 1], [1, 2], [0, 2]]);
    const plan = computeColorPlan(g, DEFAULT_PALETTE, allNodes(3));
    const colors = new Set([
      plan.get(f(0))?.fillColor,
      plan.get(f(1))?.fillColor,
      plan.get(f(2))?.fillColor,
    ]);
    expect(colors.size).toBe(3);
  });

  it('degenerate clique beyond base colors still has no adjacent-same fill', () => {
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < 8; i += 1) {
      for (let j = i + 1; j < 8; j += 1) edges.push([i, j]);
    }
    const g = graphOf(8, edges);
    const plan = computeColorPlan(g, DEFAULT_PALETTE, allNodes(8));
    const fills = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const fill = plan.get(f(i))?.fillColor;
      expect(fill).toBeDefined();
      if (fill !== undefined) fills.add(fill);
    }
    // a full clique => every fill distinct (some are derived colors).
    expect(fills.size).toBe(8);
  });
});

describe('auto-color: only auto-color targets are colored (FR-101)', () => {
  it('manual features are excluded from the plan', () => {
    const g = graphOf(3, [[0, 1], [1, 2]]);
    const enabled = new Map<FeatureId, boolean>([
      [f(0), true],
      [f(1), false], // manual
      [f(2), true],
    ]);
    const plan = computeColorPlanFor(g, DEFAULT_PALETTE, enabled);
    expect(plan.has(f(1))).toBe(false);
    expect(plan.has(f(0))).toBe(true);
    expect(plan.has(f(2))).toBe(true);
  });
});

describe('auto-color: determinism (受け入れ基準2)', () => {
  it('same inputs -> identical plan', () => {
    const g = graphOf(4, [[0, 1], [1, 2], [2, 3], [3, 0]]);
    const a = computeColorPlan(g, DEFAULT_PALETTE, allNodes(4));
    const b = computeColorPlan(g, DEFAULT_PALETTE, allNodes(4));
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});
