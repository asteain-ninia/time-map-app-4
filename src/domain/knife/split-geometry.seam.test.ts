// U26 regression — seam-vertex quantization integrity for SCREEN-derived cuts.
//
// ROOT CAUSE (CONVERGE-2): a split driven by SCREEN pixel coordinates
// (screen→world→quantize) carries sub-grid float residue on the cut line. If the
// clip is built from those raw floats, U06 quantizes the clip and the target
// INDEPENDENTLY inside intersection() (=sideA) and difference() (=sideB), so the
// seam crossing the kernel computes can land a sub-grid distance apart between the
// two halves. U10 then sees a thin positive-area SEAM SLIVER and U06's difference
// never converges within the round cap (ConvergenceFailure) — exactly the failure
// that gated the split E2E (e2e/regression.spec.ts).
//
// THE FIX (split-geometry.snapCutLine): the cut line — the only non-grid input —
// is snapped onto U06's integer grid BEFORE the clip is built and BEFORE the
// FR-95 edge-cut crossings are computed, so both halves derive their shared seam
// vertices from the identical grid-aligned segments and共有辺途中切断点 land on the
// split's exact seam node. This is defense-in-depth that COMPLEMENTS the proposal
// layer's quantize-on-mint (proposal.ts mints every vertex via quantizeCoordinate,
// so the resolved halves already coincide for the overlap predicate): snapping the
// cut line makes the seam construction explicitly grid-deterministic at the
// GEOMETRY boundary, independent of how the kernel happens to compute crossings,
// and keeps computeEdgeCuts on the same grid as the boolean op (the FR-95 fix).
//
// These tests pin the seam INVARIANT the combined fix guarantees, with NON-INTEGER
// cuts that model screen→world residue: (1) every seam vertex of side A coincides
// EXACTLY with a seam vertex of side B (same grid node — no sliver), (2) area is
// preserved (the two halves sum to the whole within a grid-derived bound), and
// (3) the two halves do NOT overlap with positive area (U10's overlap predicate is
// empty — the convergence precondition). A clean integer cut is the control, and
// two further tests directly exercise the new code: a snap-collapse degenerate
// line is rejected with the honest 点が足りません message, and a screen-derived
// edge-cut crossing lands on the SAME grid node the split seam produced.

import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  difference,
  intersection,
  isMultiPolygonEmpty,
  isOk,
  quantizeCoordinate,
  union,
  type GeoMultiPolygon,
} from '../geometry/index';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { createVertexStore } from '../vertex';
import { withLeafShape } from '../feature';
import {
  SPLIT_CHECK_STATUS,
  SPLIT_REJECT,
  checkSplittable,
  executeSplit,
} from './split-geometry';
import { createClosedKnifeLine, createOpenKnifeLine, type KnifeLine } from './knife-line';
import {
  assembleSplitProposal,
  createInheritanceChoice,
  INHERITANCE_SIDE,
} from './proposal';
import { ATTRS, COLOR, freshIdPorts, squareLeaf, unitSquare } from './fixtures';

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

/** Every coordinate of a multi-polygon, snapped to the grid, as "lon,lat" keys. */
function gridKeys(mp: GeoMultiPolygon): Set<string> {
  const keys = new Set<string>();
  for (const poly of mp) {
    for (const ring of poly) {
      for (const v of ring) {
        const q = quantizeCoordinate(v);
        keys.add(`${q.lon},${q.lat}`);
      }
    }
  }
  return keys;
}

/**
 * Drive the full split → proposal → resolved-shape pipeline for a [0,10]² square,
 * returning both resolved halves exactly as the live binding's U10 detection sees
 * them (resolveLeafShape over the minted, quantized vertices).
 */
function splitHalves(line: KnifeLine): { a: GeoMultiPolygon; b: GeoMultiPolygon } {
  const { feature, store } = unitSquare('sq');
  const result = executeSplit(feature, store, line);
  expect(result).toBeDefined();
  if (!result) throw new Error('split did not produce a result');
  const split = assembleSplitProposal({
    target: feature,
    store: store.byId,
    result,
    choice: createInheritanceChoice(INHERITANCE_SIDE.A),
    nonInherited: { attributes: ATTRS, color: COLOR },
    ids: freshIdPorts(),
  });
  const vs = createVertexStore([...split.vertices]);
  const inheritor = withLeafShape(feature, split.inheritorShape);
  const a = resolveLeafShape(inheritor.shape, vs);
  const b = resolveLeafShape(split.newFeature.shape, vs);
  if (a === undefined || b === undefined) throw new Error('halves did not resolve');
  return { a, b };
}

/** The seam vertices = coordinates the two halves SHARE (the cut boundary). */
function sharedSeamKeys(a: GeoMultiPolygon, b: GeoMultiPolygon): string[] {
  const ka = gridKeys(a);
  const kb = gridKeys(b);
  return [...ka].filter((k) => kb.has(k));
}

// Screen→world residue: arbitrary non-integer cut lines (a pixel grid mapped
// through an equirectangular transform never lands on the world integer grid).
const SCREEN_CUTS: ReadonlyArray<{ name: string; line: KnifeLine }> = [
  {
    name: 'near-vertical jitter (screen pixel column)',
    line: createOpenKnifeLine([c(5.0001, -0.0003), c(4.9997, 10.0002)]),
  },
  {
    name: 'diagonal slant',
    line: createOpenKnifeLine([c(3.137, -2.9), c(6.831, 12.4)]),
  },
  {
    name: 'shallow slope through both side edges',
    line: createOpenKnifeLine([c(-0.5, 3.33337), c(10.5, 6.66663)]),
  },
  {
    name: 'multi-vertex cut bending near an edge',
    line: createOpenKnifeLine([c(3.3, -1), c(9.999777, 5.123), c(4.1, 11)]),
  },
];

describe('split seam — screen-derived non-integer cuts coincide to the quantum', () => {
  for (const { name, line } of SCREEN_CUTS) {
    it(`both halves share grid-identical seam vertices: ${name}`, () => {
      const { a, b } = splitHalves(line);
      const shared = sharedSeamKeys(a, b);
      // A 2-piece convex split shares its two seam endpoints (where the cut meets
      // the boundary); a multi-vertex cut shares those plus its interior bends.
      expect(shared.length).toBeGreaterThanOrEqual(2);
      // EVERY shared seam key is a true grid node (no sub-grid residue survived).
      for (const key of shared) {
        const [lon, lat] = key.split(',').map(Number);
        const q = quantizeCoordinate({ lon: lon!, lat: lat! });
        expect(q.lon).toBe(lon);
        expect(q.lat).toBe(lat);
      }
    });

    it(`the two halves do not overlap with positive area (convergence precondition): ${name}`, () => {
      const { a, b } = splitHalves(line);
      const inter = intersection(a, b);
      expect(isOk(inter)).toBe(true);
      if (isOk(inter)) {
        // No SEAM SLIVER: the overlap U10 would test is empty (zero-area contact).
        expect(inter.result.length).toBe(0);
      }
    });

    it(`the halves EXACTLY reconstruct the whole face (no gap, no sliver): ${name}`, () => {
      const { a, b } = splitHalves(line);
      const whole: GeoMultiPolygon = [[[c(0, 0), c(10, 0), c(10, 10), c(0, 10)]]];
      const merged = union(a, b);
      expect(isOk(merged)).toBe(true);
      if (!isOk(merged)) return;
      // Set-exact reconstruction (review P2: not an area tolerance — even a single
      // grid-cell sliver/gap is a non-empty symmetric difference). The union of the
      // two halves must equal the original face: nothing the split added beyond it
      // (whole \ merged empty) and nothing it lost (merged \ whole empty). This
      // detects the SMALLEST sliver U06 can represent, which an area-difference
      // threshold cannot.
      const lost = difference(whole, merged.result);
      const extra = difference(merged.result, whole);
      expect(isOk(lost) && isMultiPolygonEmpty(lost.result)).toBe(true);
      expect(isOk(extra) && isMultiPolygonEmpty(extra.result)).toBe(true);
    });
  }

  it('control — a clean axis-aligned INTEGER cut behaves identically (no regression)', () => {
    const { a, b } = splitHalves(createOpenKnifeLine([c(4, -5), c(4, 15)]));
    expect(sharedSeamKeys(a, b).length).toBeGreaterThanOrEqual(2);
    const inter = intersection(a, b);
    expect(isOk(inter) && inter.result.length === 0).toBe(true);
  });

  it('a CLOSED screen-derived cut shares its whole boundary as grid-identical seam', () => {
    const line = createClosedKnifeLine([
      c(3.1234, 3.5678),
      c(6.7891, 3.2345),
      c(6.5432, 6.8765),
      c(3.4567, 6.1234),
    ]);
    const check = checkSplittable(unitSquare('sq').feature, unitSquare('sq').store, line);
    expect(check.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    const { a, b } = splitHalves(line);
    // The closed cut's 4 corners form the shared seam between the inner piece and
    // the outer piece's hole — all four coincide to the grid.
    expect(sharedSeamKeys(a, b).length).toBeGreaterThanOrEqual(4);
    const inter = intersection(a, b);
    expect(isOk(inter) && inter.result.length === 0).toBe(true);
  });

  it('a cut whose two points collapse onto one grid node after snap is rejected as 点が足りません', () => {
    const { feature, store } = unitSquare('sq');
    // Two distinct screen points within a SINGLE grid cell (< 1e-7° apart): they
    // snap to the same node, leaving one unique vertex — no cut. The pre-snap
    // length check (2) passes, so only the POST-snap re-check (the review P2 fix)
    // can catch this; without it the degenerate input would mis-report as 貫通せず.
    const line = createOpenKnifeLine([c(5.00000001, -3), c(5.00000002, -3)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.DegenerateLine);
    }
  });

  it('FR-95 edge-cut lands on the SAME grid node the split seam produces (sub-grid target edge)', () => {
    // A face whose right edge endpoints carry sub-grid residue (screen-derived):
    // the edge runs from (10+ε, 0) up to (10+ε, 8). An OPEN cut enters the left
    // edge and exits THROUGH that right edge mid-way, producing one FR-95 edge cut.
    const eps = 6e-8; // < one grid cell (1e-7°)
    const { feature, store } = squareLeaf('sub', [
      c(0, 0),
      c(10 + eps, 0 - eps),
      c(10 + eps, 8 + eps),
      c(0, 8),
    ]);
    // Cut from outside-left, slanting up, exiting through the right edge mid-height.
    const line = createOpenKnifeLine([c(-2, 1.234567), c(12, 5.234567)]);
    const result = executeSplit(feature, store, line);
    expect(result).toBeDefined();
    if (!result) return;
    // REQUIRED (review P1: not vacuous): this cut crosses the right edge mid-way, so
    // at least one FR-95 edge cut MUST be produced. A regression that broke crossing
    // detection on a sub-grid edge would empty edgeCuts and silently pass otherwise.
    expect(result.edgeCuts.length).toBeGreaterThanOrEqual(1);
    // The edge cut on the sub-grid RIGHT edge (lon ≈ 10) must be present specifically.
    const rightCut = result.edgeCuts.find((cut) => quantizeCoordinate(cut.coordinate).lon >= 10);
    expect(rightCut).toBeDefined();
    // Every edge cut's coordinate is a true grid node (quantize is idempotent).
    for (const cut of result.edgeCuts) {
      const q = quantizeCoordinate(cut.coordinate);
      expect(q.lon).toBe(cut.coordinate.lon);
      expect(q.lat).toBe(cut.coordinate.lat);
    }
    // And each cut node must actually appear on BOTH rebuilt halves' boundaries (the
    // split seam) — i.e. the FR-95 cut point is the SAME node the split seam used, so
    // a partner-edge insertion would coincide (review P1: edge endpoints quantized).
    const split = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    const vs = createVertexStore([...split.vertices]);
    const a = resolveLeafShape(withLeafShape(feature, split.inheritorShape).shape, vs);
    const b = resolveLeafShape(split.newFeature.shape, vs);
    if (a === undefined || b === undefined) throw new Error('halves did not resolve');
    const seam = new Set(sharedSeamKeys(a, b));
    for (const cut of result.edgeCuts) {
      const q = quantizeCoordinate(cut.coordinate);
      expect(seam.has(`${q.lon},${q.lat}`)).toBe(true);
    }
  });

  it('a CLOSED cut whose closing vertex collapses onto the first is rejected as 点が足りません', () => {
    const { feature, store } = unitSquare('sq');
    // A "triangle" whose THIRD point sits within one grid cell of the FIRST: after
    // snap the implicit closing edge is zero-length, leaving only 2 distinct nodes —
    // not a polygon. Only the closed-aware post-snap check (review P2) catches this;
    // snapCutLine's consecutive-dedupe alone would leave length 3 and mis-classify.
    const line = createClosedKnifeLine([
      c(3.5, 3.5),
      c(6.5, 4.5),
      c(3.50000001, 3.50000001),
    ]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.DegenerateLine);
    }
  });
});
