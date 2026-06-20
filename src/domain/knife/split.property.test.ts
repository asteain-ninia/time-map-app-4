import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createLeafFeature, type LeafFeature } from '../feature';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { isAlternationValid } from '../ring';
import { createHoleRing, createShape, createTerritoryRing, type Ring } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { createClosedKnifeLine, createOpenKnifeLine } from './knife-line';
import {
  SPLIT_CHECK_STATUS,
  checkSplittable,
  MIN_POLYGON_VERTICES,
  type SplitSide,
} from './split-geometry';
import {
  INHERITANCE_SIDE,
  assembleSplitProposal,
  createInheritanceChoice,
} from './proposal';

const ATTRS = createBasicAttributes('p', 0, 100);
const COLOR = createColorInfo(true, '#fff', '#0f0', '#000');

let n = 0;
const freshVid = () => asVertexId(`pv-${n++}`);
const freshRid = () => asRingId(`pr-${n++}`);
const ids = () => ({
  nextFeatureId: () => asFeatureId(`pnf-${n++}`),
  nextVertexId: () => asVertexId(`pnv-${n++}`),
  nextRingId: () => asRingId(`pnr-${n++}`),
});

/** A rectangle [x0,x1]×[y0,y1] leaf feature + its store. */
function rectLeaf(x0: number, x1: number, y0: number, y1: number) {
  const coords = [
    createCoordinate(x0, y0),
    createCoordinate(x1, y0),
    createCoordinate(x1, y1),
    createCoordinate(x0, y1),
  ];
  const vids = coords.map((_, i) => asVertexId(`pv-${i}`));
  const vertices = coords.map((coord, i) => createVertex(vids[i]!, coord));
  const ring = createTerritoryRing(asRingId('pr-0'), vids);
  const feature = createLeafFeature(asFeatureId('pf'), ATTRS, COLOR, createShape([ring]));
  return { feature, store: createVertexStore(vertices) };
}

// ---------------------------------------------------------------------------
// A configurable末端地物 generator WITH holes / enclaves / nesting (受け入れ基準9).
//
// The spec's criterion 9 demands ランダム生成した末端地物(穴・飛び地・ネストを含む) — a
// single rectangle is NOT enough. This builder assembles, from random numeric
// parameters, an outer territory plus (optionally):
//   - a LEFT hole the vertical cut will cross,
//   - a territory ENCLAVE nested inside that left hole (FR-91 親一段上げ exercise),
//   - a RIGHT hole the cut leaves UNTOUCHED (FR-91 横切られないリング維持 exercise).
// Each axis-aligned box's vertices are minted fresh so the FR-24 alternation /
// 3-vertex / area-preservation invariants are checked over真の穴・飛び地・ネスト入力,
// not just a convex rectangle.
// ---------------------------------------------------------------------------

interface HoleyParams {
  /** Outer extent (the cut runs vertically inside [0,w]×[0,h]). */
  readonly w: number;
  readonly h: number;
  /** Include a left hole the cut will cross. */
  readonly leftHole: boolean;
  /** Nest a territory enclave inside the left hole (requires leftHole). */
  readonly enclave: boolean;
  /** Include a right hole the cut leaves untouched. */
  readonly rightHole: boolean;
}

function box(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): { coords: WorldCoordinate[]; ids: ReturnType<typeof freshVid>[] } {
  const coords = [
    createCoordinate(x0, y0),
    createCoordinate(x1, y0),
    createCoordinate(x1, y1),
    createCoordinate(x0, y1),
  ];
  return { coords, ids: coords.map(() => freshVid()) };
}

/**
 * Build a holey末端地物 from {@link HoleyParams}. The outer box is [0,w]×[0,h]; the
 * left hole sits around x≈[0.15w,0.45w] (so a vertical cut at the mid x crosses
 * it), the enclave nests inside it, and the right hole sits at x≈[0.6w,0.85w].
 */
function holeyLeaf(p: HoleyParams): { feature: LeafFeature; store: VertexStore; cutX: number } {
  const { w, h } = p;
  const vertices: Vertex[] = [];
  const rings: Ring[] = [];
  const push = (b: { coords: WorldCoordinate[]; ids: ReturnType<typeof freshVid>[] }) => {
    b.ids.forEach((id, i) => vertices.push(createVertex(id, b.coords[i]!)));
  };

  const outer = box(0, w, 0, h);
  push(outer);
  const tOuter = createTerritoryRing(freshRid(), outer.ids);
  rings.push(tOuter);

  // The vertical cut x: through the LEFT region so it crosses the left hole.
  const cutX = w * 0.3;

  if (p.leftHole) {
    const lh = box(w * 0.15, w * 0.45, h * 0.2, h * 0.8);
    push(lh);
    const rLeft = createHoleRing(freshRid(), lh.ids, tOuter.id);
    rings.push(rLeft);
    if (p.enclave) {
      const en = box(w * 0.22, w * 0.38, h * 0.35, h * 0.65);
      push(en);
      rings.push(createTerritoryRing(freshRid(), en.ids, rLeft.id));
    }
  }

  if (p.rightHole) {
    const rh = box(w * 0.6, w * 0.85, h * 0.3, h * 0.7);
    push(rh);
    rings.push(createHoleRing(freshRid(), rh.ids, tOuter.id));
  }

  const feature = createLeafFeature(asFeatureId('pf'), ATTRS, COLOR, createShape(rings));
  return { feature, store: createVertexStore(vertices), cutX };
}

/** Total positive area of a side's multipolygon (outer − holes) by the shoelace. */
function sideShoelaceArea(side: SplitSide): number {
  let total = 0;
  for (const poly of side.area) {
    poly.forEach((ring, i) => {
      let s = 0;
      const m = ring.length;
      for (let k = 0; k < m; k += 1) {
        const a = ring[k]!;
        const b = ring[(k + 1) % m]!;
        s += a.lon * b.lat - b.lon * a.lat;
      }
      const a = Math.abs(s) / 2;
      total += i === 0 ? a : -a;
    });
  }
  return total;
}

/** Filled area (outer − holes) of the WHOLE leaf, by the shoelace, for preservation. */
function leafFilledArea(p: HoleyParams): number {
  const outer = p.w * p.h;
  let holes = 0;
  if (p.leftHole) {
    const lhArea = p.w * 0.3 * (p.h * 0.6); // [0.15,0.45]w × [0.2,0.8]h
    holes += lhArea;
    if (p.enclave) {
      const enArea = p.w * 0.16 * (p.h * 0.3); // enclave is filled territory again
      holes -= enArea;
    }
  }
  if (p.rightHole) {
    holes += p.w * 0.25 * (p.h * 0.4); // [0.6,0.85]w × [0.3,0.7]h
  }
  return outer - holes;
}

describe('split invariants (fast-check; 受け入れ基準9)', () => {
  const dim = fc.double({ min: 20, max: 80, noNaN: true });

  it('a vertical cut across holes/enclaves/nesting always yields two valid sides', () => {
    fc.assert(
      fc.property(
        dim,
        dim,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (w, h, leftHole, enclave, rightHole) => {
          n += 1; // keep minted ids unique across runs.
          const params: HoleyParams = {
            w,
            h,
            leftHole,
            enclave: leftHole && enclave,
            rightHole,
          };
          const { feature, store, cutX } = holeyLeaf(params);
          const line = createOpenKnifeLine([
            createCoordinate(cutX, -5),
            createCoordinate(cutX, h + 5),
          ]);
          const res = checkSplittable(feature, store, line);
          // A vertical interior cut always bisects the outer territory → splittable.
          expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
          if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

          // (a) every outer ring of either side has ≥3 vertices.
          for (const side of [res.sideA, res.sideB]) {
            for (const poly of side.area) {
              expect(poly[0]!.length).toBeGreaterThanOrEqual(MIN_POLYGON_VERTICES);
            }
          }

          // (c) area preservation (量子化許容): the two sides' filled-area sum equals
          //     the whole leaf's filled area (outer − holes + enclaves) to a small
          //     relative tolerance. This exercises FR-91 ring re-org area conservation.
          const sum = sideShoelaceArea(res.sideA) + sideShoelaceArea(res.sideB);
          const whole = leafFilledArea(params);
          expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-3);

          // (b) the rebuilt shapes on BOTH sides preserve the FR-24 ring alternation.
          const proposal = assembleSplitProposal({
            target: feature,
            store: store.byId,
            result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
            choice: createInheritanceChoice(INHERITANCE_SIDE.A),
            nonInherited: { attributes: ATTRS, color: COLOR },
            ids: ids(),
          });
          expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
          expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('a closed cut inside a holey leaf splits into inside/outside with valid rings', () => {
    fc.assert(
      fc.property(dim, dim, fc.boolean(), (w, h, rightHole) => {
        n += 1;
        const params: HoleyParams = {
          w,
          h,
          leftHole: false,
          enclave: false,
          rightHole,
        };
        const { feature, store } = holeyLeaf(params);
        // A closed quad fully inside the LEFT half, away from the right hole.
        const closed = createClosedKnifeLine([
          createCoordinate(w * 0.1, h * 0.1),
          createCoordinate(w * 0.4, h * 0.1),
          createCoordinate(w * 0.4, h * 0.4),
          createCoordinate(w * 0.1, h * 0.4),
        ]);
        const res = checkSplittable(feature, store, closed);
        expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
        if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

        // (a) ≥3 vertices on every outer ring of either side.
        for (const side of [res.sideA, res.sideB]) {
          for (const poly of side.area) {
            expect(poly[0]!.length).toBeGreaterThanOrEqual(MIN_POLYGON_VERTICES);
          }
        }
        // (c) area preservation: inside + outside == whole filled area.
        const sum = sideShoelaceArea(res.sideA) + sideShoelaceArea(res.sideB);
        const whole = leafFilledArea(params);
        expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-3);

        // (b) rebuilt rings alternate (FR-24) on both sides.
        const proposal = assembleSplitProposal({
          target: feature,
          store: store.byId,
          result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
          choice: createInheritanceChoice(INHERITANCE_SIDE.B),
          nonInherited: { attributes: ATTRS, color: COLOR },
          ids: ids(),
        });
        expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
        expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('a rejected split (no pierce) leaves no partial state — check is pure (FR-94 / 受け入れ基準9d)', () => {
    fc.assert(
      fc.property(fc.double({ min: 5, max: 40, noNaN: true }), (w) => {
        const { feature, store } = rectLeaf(0, w, 0, w);
        const before = JSON.stringify(feature);
        // A line entirely below: no crossing → rejected.
        const line = createOpenKnifeLine([
          createCoordinate(-5, -5),
          createCoordinate(w + 5, -5),
        ]);
        const res = checkSplittable(feature, store, line);
        expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
        // The target is untouched (pure function; 部分適用なし).
        expect(JSON.stringify(feature)).toBe(before);
      }),
      { numRuns: 40 },
    );
  });
});
