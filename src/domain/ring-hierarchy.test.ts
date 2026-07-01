import { describe, expect, it } from 'vitest';

import { createCoordinate } from './coordinate';
import { asRingId, asVertexId, type VertexId } from './ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  isAlternationValid,
} from './ring';
import {
  childrenOf,
  deleteRingAndReorganize,
  RING_VIOLATION,
  ringDepth,
  topLevelRings,
  validateAlternation,
  validateGeometry,
  validateRingHierarchy,
} from './ring-hierarchy';
import { createVertex, createVertexStore, type Vertex } from './vertex';

// --- fixture factories (教訓5.39: build real values via the factories) --------

const rid = (s: string) => asRingId(s);

/** Build a vertex store from a name -> [lon, lat] map. */
function storeFrom(coords: Record<string, readonly [number, number]>) {
  const vertices: Vertex[] = Object.entries(coords).map(([name, [lon, lat]]) =>
    createVertex(asVertexId(name), createCoordinate(lon, lat)),
  );
  return createVertexStore(vertices);
}

/** Vertex IDs for a square ring named with a prefix; returns the 4 corner ids. */
function squareVertexIds(prefix: string): VertexId[] {
  return ['0', '1', '2', '3'].map((s) => asVertexId(`${prefix}${s}`));
}

/** Coords for an axis-aligned square [x,y] size s, keyed by `${prefix}0..3`. */
function squareCoords(
  prefix: string,
  x: number,
  y: number,
  s: number,
): Record<string, readonly [number, number]> {
  return {
    [`${prefix}0`]: [x, y],
    [`${prefix}1`]: [x + s, y],
    [`${prefix}2`]: [x + s, y + s],
    [`${prefix}3`]: [x, y + s],
  };
}

// ---------------------------------------------------------------------------
// 1. Alternation invariant (FR-24) — criterion 1
// ---------------------------------------------------------------------------

describe('validateAlternation (FR-24)', () => {
  it('succeeds for a territory -> hole -> territory chain', () => {
    const t = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const enclave = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('h1'));
    const shape = createShape([t, h, enclave]);
    const res = validateAlternation(shape);
    expect(res.valid).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(isAlternationValid(shape)).toBe(true);
  });

  it('fails and identifies the ring when a hole is at top level', () => {
    // A parentless hole is type-impossible via createHoleRing, so we build one
    // whose parent is missing from the shape to model "outermost is a hole".
    const orphanHole = createHoleRing(rid('h1'), squareVertexIds('h'), rid('absent'));
    const res = validateAlternation(createShape([orphanHole]));
    expect(res.valid).toBe(false);
    // Dangling parent is reported (parent not present), identifying the ring.
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.DanglingParent);
    expect(res.violations[0]?.ringId).toBe('h1');
  });

  it('fails when a hole points at another hole (role not reversed)', () => {
    const t = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const h2 = createHoleRing(rid('h2'), squareVertexIds('g'), rid('h1'));
    const res = validateAlternation(createShape([t, h1, h2]));
    expect(res.valid).toBe(false);
    const v = res.violations.find((x) => x.ringId === 'h2');
    expect(v?.kind).toBe(RING_VIOLATION.HoleParentNotTerritory);
    expect(v?.relatedRingId).toBe('h1');
  });

  it('fails when a nested territory points at a territory (territory -> territory)', () => {
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const t2 = createTerritoryRing(rid('t2'), squareVertexIds('u'), rid('t1'));
    const res = validateAlternation(createShape([t1, t2]));
    expect(res.valid).toBe(false);
    const v = res.violations.find((x) => x.ringId === 't2');
    expect(v?.kind).toBe(RING_VIOLATION.TerritoryParentNotHole);
  });

  it('verifies every outermost (parentless) ring is a territory', () => {
    const a = createTerritoryRing(rid('a'), squareVertexIds('a'));
    const b = createTerritoryRing(rid('b'), squareVertexIds('b'));
    const res = validateAlternation(createShape([a, b]));
    expect(res.valid).toBe(true);
    expect(topLevelRings(createShape([a, b]))).toHaveLength(2);
  });

  it('empty shape is valid (教訓5.18: empty is a true value)', () => {
    expect(validateAlternation(createShape()).valid).toBe(true);
    expect(topLevelRings(createShape())).toHaveLength(0);
  });
});

describe('ringDepth (derived, not stored)', () => {
  it('is 0 for top-level, +1 per level inward', () => {
    const t = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const e = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('h1'));
    const shape = createShape([t, h, e]);
    expect(ringDepth(shape, rid('t1'))).toBe(0);
    expect(ringDepth(shape, rid('h1'))).toBe(1);
    expect(ringDepth(shape, rid('t2'))).toBe(2);
  });

  it('returns undefined for a dangling parent chain', () => {
    const e = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('missing'));
    expect(ringDepth(createShape([e]), rid('t2'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Geometric validation (FR-25) — criterion 2
// ---------------------------------------------------------------------------

describe('validateGeometry (FR-25): hole containment & non-crossing', () => {
  it('succeeds when the hole is fully inside the parent and does not cross it', () => {
    const store = storeFrom({
      ...squareCoords('t', 0, 0, 100),
      ...squareCoords('h', 20, 20, 20),
    });
    const t = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const res = validateGeometry(createShape([t, h]), store);
    expect(res.valid).toBe(true);
  });

  it('fails when the hole pokes outside the parent (not contained)', () => {
    const store = storeFrom({
      ...squareCoords('t', 0, 0, 100),
      ...squareCoords('h', 90, 90, 40), // extends past the 100x100 parent
    });
    const t = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const res = validateGeometry(createShape([t, h]), store);
    expect(res.valid).toBe(false);
    const v = res.violations.find((x) => x.ringId === 'h1');
    expect([RING_VIOLATION.HoleNotContained, RING_VIOLATION.HoleCrossesParent]).toContain(
      v?.kind,
    );
    expect(v?.relatedRingId).toBe('t1');
  });
});

describe('validateGeometry (FR-25): sibling non-overlap', () => {
  it('succeeds when two sibling holes are separate', () => {
    const store = storeFrom({
      ...squareCoords('t', 0, 0, 100),
      ...squareCoords('h', 10, 10, 20),
      ...squareCoords('g', 60, 60, 20),
    });
    const t = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const h2 = createHoleRing(rid('h2'), squareVertexIds('g'), rid('t1'));
    expect(validateGeometry(createShape([t, h1, h2]), store).valid).toBe(true);
  });

  it('fails when two sibling holes overlap', () => {
    const store = storeFrom({
      ...squareCoords('t', 0, 0, 100),
      ...squareCoords('h', 10, 10, 30),
      ...squareCoords('g', 20, 20, 30), // overlaps h
    });
    const t = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const h2 = createHoleRing(rid('h2'), squareVertexIds('g'), rid('t1'));
    const res = validateGeometry(createShape([t, h1, h2]), store);
    expect(res.valid).toBe(false);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.SiblingsOverlap);
  });
});

describe('validateGeometry (FR-25 / FR-21): enclave non-overlap', () => {
  it('succeeds when two top-level territories are separate', () => {
    const store = storeFrom({
      ...squareCoords('a', 0, 0, 30),
      ...squareCoords('b', 50, 50, 30),
    });
    const a = createTerritoryRing(rid('a'), squareVertexIds('a'));
    const b = createTerritoryRing(rid('b'), squareVertexIds('b'));
    expect(validateGeometry(createShape([a, b]), store).valid).toBe(true);
  });

  it('fails when two top-level territories overlap, reporting EnclavesOverlap', () => {
    const store = storeFrom({
      ...squareCoords('a', 0, 0, 40),
      ...squareCoords('b', 20, 20, 40),
    });
    const a = createTerritoryRing(rid('a'), squareVertexIds('a'));
    const b = createTerritoryRing(rid('b'), squareVertexIds('b'));
    const res = validateGeometry(createShape([a, b]), store);
    expect(res.valid).toBe(false);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.EnclavesOverlap);
  });

  it('boundary contact (touching, not overlapping) is NOT an overlap', () => {
    // Two squares sharing exactly one edge (x=30) — boundary touch only.
    const store = storeFrom({
      ...squareCoords('a', 0, 0, 30),
      ...squareCoords('b', 30, 0, 30),
    });
    const a = createTerritoryRing(rid('a'), squareVertexIds('a'));
    const b = createTerritoryRing(rid('b'), squareVertexIds('b'));
    expect(validateGeometry(createShape([a, b]), store).valid).toBe(true);
  });

  it('fails when two top-level territories are identical (coincident), reporting EnclavesOverlap', () => {
    // Two enclaves with the SAME square boundary. Every edge pair is Collinear and
    // every vertex lies on the other's boundary, so the proper-crossing and
    // strictly-Inside probes miss the overlap; the boundary-coincident-same-side
    // check must catch this duplicate (第5次バグハント: false-negative fix).
    const store = storeFrom({
      ...squareCoords('a', 0, 0, 40),
      ...squareCoords('b', 0, 0, 40), // identical square, different vertex ids
    });
    const a = createTerritoryRing(rid('a'), squareVertexIds('a'));
    const b = createTerritoryRing(rid('b'), squareVertexIds('b'));
    const res = validateGeometry(createShape([a, b]), store);
    expect(res.valid).toBe(false);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.EnclavesOverlap);
  });

  it('fails when two sibling holes are identical (coincident), reporting SiblingsOverlap', () => {
    // A territory with two holes sharing the SAME boundary — the same coincident-
    // duplicate case at the sibling (non-top-level) level.
    const store = storeFrom({
      ...squareCoords('t', 0, 0, 100),
      ...squareCoords('h', 20, 20, 40),
      ...squareCoords('k', 20, 20, 40), // identical to h
    });
    const t = createTerritoryRing(rid('t'), squareVertexIds('t'));
    const h = createHoleRing(rid('h'), squareVertexIds('h'), rid('t'));
    const k = createHoleRing(rid('k'), squareVertexIds('k'), rid('t'));
    const res = validateGeometry(createShape([t, h, k]), store);
    expect(res.valid).toBe(false);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.SiblingsOverlap);
  });
});

describe('validateGeometry (FR-25 / R3): seam-crossing rings (U05 unwrap)', () => {
  // Rings that straddle the ±180° seam are stored as representative longitudes
  // in [-180, 180), so a contiguous span like 170°..190° is stored as 170 and
  // -170 — looking ~340° apart unless seam unwrap (U05) is applied first. U07's
  // resolveRing delegates that unwrap before quantization (tech policy R3); these
  // tests fail if that wiring is removed (they were the integration defect).

  it('judges a hole contained in a seam-crossing parent as contained', () => {
    // Parent territory spans lon 170..190 (crosses the seam); hole spans 175..185,
    // fully inside it. Stored representative: 190 -> -170, 185 -> -175.
    const store = storeFrom({
      t0: [170, 0],
      t1: [-170, 0], // 190°
      t2: [-170, 20],
      t3: [170, 20],
      h0: [175, 5],
      h1: [-175, 5], // 185°
      h2: [-175, 15],
      h3: [175, 15],
    });
    const territory = createTerritoryRing(rid('t1'), [
      asVertexId('t0'),
      asVertexId('t1'),
      asVertexId('t2'),
      asVertexId('t3'),
    ]);
    const hole = createHoleRing(
      rid('h1'),
      [asVertexId('h0'), asVertexId('h1'), asVertexId('h2'), asVertexId('h3')],
      rid('t1'),
    );
    expect(validateGeometry(createShape([territory, hole]), store).valid).toBe(true);
  });

  it('judges a seam-crossing enclave and a normal enclave as non-overlapping', () => {
    // A is a top-level territory that crosses the seam (spans 175..185, stored
    // 175 and -175); B is a normal one far west (100..120). They are disjoint.
    // Without unwrap, A's representative coords (175, -175) span ~350° and could
    // be misjudged as enveloping B.
    const store = storeFrom({
      a0: [175, 0],
      a1: [-175, 0], // 185
      a2: [-175, 10],
      a3: [175, 10],
      ...squareCoords('b', 100, 0, 20),
    });
    const a = createTerritoryRing(rid('a'), [
      asVertexId('a0'),
      asVertexId('a1'),
      asVertexId('a2'),
      asVertexId('a3'),
    ]);
    const b = createTerritoryRing(rid('b'), squareVertexIds('b'));
    expect(validateGeometry(createShape([a, b]), store).valid).toBe(true);
  });
});

describe('validateGeometry (FR-25 / R3): seam-crossing pairs with MISMATCHED anchors', () => {
  // Regression for the latent per-ring-unwrap bug: resolveRing unwraps each ring
  // to its OWN first vertex, so two seam-crossing rings whose vertex lists START
  // on opposite seam sides previously landed ~360° apart and were misjudged.
  // The pair must be aligned into a shared world turn before comparison (alignRingTo).

  it('contains a seam-crossing hole whose vertex list starts on the OPPOSITE seam side', () => {
    // Parent spans lon 170..190 (crosses seam), listed starting at the +170 side.
    // Hole spans 175..185 (fully inside), but listed starting at the -185 (i.e.
    // -175 representative) side — the opposite seam side from the parent's first
    // vertex. Geometry is identical to the passing seam test; only the ORDER
    // differs, which used to flip the result to a spurious HoleNotContained.
    const store = storeFrom({
      t0: [170, 0],
      t1: [-170, 0], // 190°
      t2: [-170, 20],
      t3: [170, 20],
      // hole listed starting on the -175 (185°) side:
      h0: [-175, 5], // 185°
      h1: [-175, 15],
      h2: [175, 15],
      h3: [175, 5],
    });
    const territory = createTerritoryRing(rid('t1'), [
      asVertexId('t0'),
      asVertexId('t1'),
      asVertexId('t2'),
      asVertexId('t3'),
    ]);
    const hole = createHoleRing(
      rid('h1'),
      [asVertexId('h0'), asVertexId('h1'), asVertexId('h2'), asVertexId('h3')],
      rid('t1'),
    );
    const res = validateGeometry(createShape([territory, hole]), store);
    expect(res.valid).toBe(true);
  });

  it('judges seam-crossing enclaves with mismatched anchors as overlapping when they truly overlap', () => {
    // Two top-level territories that BOTH cross the seam and genuinely overlap.
    // A starts on the +170 side, B starts on the -175 side. Aligned, A spans
    // 170..190 and B spans 175..195 — they overlap. With per-ring unwrap they
    // would have been ~360° apart and falsely judged disjoint.
    const store = storeFrom({
      a0: [170, 0],
      a1: [-170, 0], // 190
      a2: [-170, 10],
      a3: [170, 10],
      // B starts on the -175 (185°) side; spans 175..195 (-165), overlapping A.
      b0: [-175, 2], // 185
      b1: [-165, 2], // 195
      b2: [-165, 8],
      b3: [-175, 8],
    });
    const a = createTerritoryRing(rid('a'), [
      asVertexId('a0'),
      asVertexId('a1'),
      asVertexId('a2'),
      asVertexId('a3'),
    ]);
    const b = createTerritoryRing(rid('b'), [
      asVertexId('b0'),
      asVertexId('b1'),
      asVertexId('b2'),
      asVertexId('b3'),
    ]);
    const res = validateGeometry(createShape([a, b]), store);
    expect(res.valid).toBe(false);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.EnclavesOverlap);
  });

  it('judges seam-crossing siblings with mismatched anchors as non-overlapping when disjoint', () => {
    // Parent territory spans 160..200 (crosses seam). Two sibling holes inside it,
    // both seam-crossing, disjoint from each other, listed starting on opposite
    // seam sides. Per-ring unwrap would have placed them ~360° apart.
    const store = storeFrom({
      p0: [160, -20],
      p1: [-160, -20], // 200
      p2: [-160, 20],
      p3: [160, 20],
      // hole 1 spans 165..175, starts on +165 side, near-east
      g0: [165, -5],
      g1: [175, -5],
      g2: [175, 5],
      g3: [165, 5],
      // hole 2 spans 185..195, starts on the -175 (185°) side
      k0: [-175, -5], // 185
      k1: [-165, -5], // 195
      k2: [-165, 5],
      k3: [-175, 5],
    });
    const parent = createTerritoryRing(rid('p'), [
      asVertexId('p0'),
      asVertexId('p1'),
      asVertexId('p2'),
      asVertexId('p3'),
    ]);
    const g = createHoleRing(
      rid('g'),
      [asVertexId('g0'), asVertexId('g1'), asVertexId('g2'), asVertexId('g3')],
      rid('p'),
    );
    const k = createHoleRing(
      rid('k'),
      [asVertexId('k0'), asVertexId('k1'), asVertexId('k2'), asVertexId('k3')],
      rid('p'),
    );
    const res = validateGeometry(createShape([parent, g, k]), store);
    expect(res.valid).toBe(true);
  });
});

describe('validateRingHierarchy (combined, single high-frequency call)', () => {
  it('returns both structural and geometric violations together', () => {
    const store = storeFrom({
      ...squareCoords('a', 0, 0, 40),
      ...squareCoords('b', 20, 20, 40), // overlapping enclaves
    });
    const a = createTerritoryRing(rid('a'), squareVertexIds('a'));
    const b = createTerritoryRing(rid('b'), squareVertexIds('b'));
    // Add a structurally-broken ring (dangling parent) too.
    const broken = createHoleRing(rid('h'), squareVertexIds('a'), rid('missing'));
    const res = validateRingHierarchy(createShape([a, b, broken]), store);
    expect(res.valid).toBe(false);
    const kinds = res.violations.map((v) => v.kind);
    expect(kinds).toContain(RING_VIOLATION.EnclavesOverlap);
    expect(kinds).toContain(RING_VIOLATION.DanglingParent);
  });
});

// ---------------------------------------------------------------------------
// 3. Deletion reorganization (FR-24) — criterion 3 & 5
// ---------------------------------------------------------------------------

describe('deleteRingAndReorganize: hole deletion', () => {
  it('absorbs the hole’s enclave children into the parent (no enclave overlap)', () => {
    // t1(0..100) -> h1(20..60) -> t2(enclave, 30..40). Deleting h1 fills the hole,
    // so the enclave t2 lies wholly inside t1's solid and must be absorbed (dropped)
    // rather than promoted to a top-level territory (which would overlap t1).
    const store = storeFrom({
      ...squareCoords('t', 0, 0, 100),
      ...squareCoords('h', 20, 20, 40),
      ...squareCoords('e', 30, 30, 10),
    });
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const t2 = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('h1'));
    const before = createShape([t1, h1, t2]);
    // Sanity: the input shape is geometrically clean before deletion.
    expect(validateGeometry(before, store).valid).toBe(true);

    const after = deleteRingAndReorganize(before, rid('h1'));
    expect(after.rings.find((r) => r.id === 'h1')).toBeUndefined();
    // The enclave island is absorbed into the parent territory's solid.
    expect(after.rings.find((r) => r.id === 't2')).toBeUndefined();
    // Only the parent territory remains; structurally AND geometrically valid.
    expect(isAlternationValid(after)).toBe(true);
    expect(validateGeometry(after, store).valid).toBe(true);
  });

  it('lifts an absorbed enclave’s holes up to the hole’s parent territory', () => {
    // t1(0..100) -> h1(20..70) -> t2(enclave, 30..60) -> h2(hole in enclave, 40..50).
    // Deleting h1 absorbs t2; h2 (which sat inside t2 ⊂ h1 ⊂ t1) becomes a hole
    // punched directly in t1 — territory→hole alternation AND containment kept.
    const store = storeFrom({
      ...squareCoords('t', 0, 0, 100),
      ...squareCoords('h', 20, 20, 50),
      ...squareCoords('e', 30, 30, 30),
      ...squareCoords('g', 40, 40, 10),
    });
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const t2 = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('h1'));
    const h2 = createHoleRing(rid('h2'), squareVertexIds('g'), rid('t2'));
    const before = createShape([t1, h1, t2, h2]);
    expect(validateGeometry(before, store).valid).toBe(true);

    const after = deleteRingAndReorganize(before, rid('h1'));
    expect(after.rings.find((r) => r.id === 'h1')).toBeUndefined();
    expect(after.rings.find((r) => r.id === 't2')).toBeUndefined();
    const liftedHole = after.rings.find((r) => r.id === 'h2');
    expect(liftedHole?.kind).toBe('hole');
    expect(liftedHole?.kind === 'hole' && liftedHole.parentRingId).toBe('t1');
    expect(isAlternationValid(after)).toBe(true);
    // FR-25 geometry holds for the reorganized shape (the very defect U07 fixed).
    expect(validateGeometry(after, store).valid).toBe(true);
  });

  it('result is deterministic and alternation-valid (single-operation test)', () => {
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const t2 = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('h1'));
    const before = createShape([t1, h1, t2]);
    const a = deleteRingAndReorganize(before, rid('h1'));
    const b = deleteRingAndReorganize(before, rid('h1'));
    expect(a).toEqual(b); // deterministic
    // input untouched (immutability)
    expect(before.rings).toHaveLength(3);
    expect(before.rings.find((r) => r.id === 'h1')).toBeDefined();
  });

  it('leaves no dangling parent reference after hole deletion (教訓5.21)', () => {
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const t2 = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('h1'));
    const h2 = createHoleRing(rid('h2'), squareVertexIds('g'), rid('t2'));
    const after = deleteRingAndReorganize(createShape([t1, h1, t2, h2]), rid('h1'));
    const ids = new Set(after.rings.map((r) => r.id));
    for (const r of after.rings) {
      if (r.kind === 'territory' && r.parentRingId !== undefined) {
        expect(ids.has(r.parentRingId)).toBe(true);
      }
      if (r.kind === 'hole') {
        expect(ids.has(r.parentRingId)).toBe(true);
      }
    }
  });
});

describe('deleteRingAndReorganize: territory deletion', () => {
  it('promotes inner holes’ enclaves up by one level (territory deletion)', () => {
    // t1 -> h1 -> t2(enclave) -> h2 -> t3. Delete t1.
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const t2 = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('h1'));
    const h2 = createHoleRing(rid('h2'), squareVertexIds('g'), rid('t2'));
    const t3 = createTerritoryRing(rid('t3'), squareVertexIds('f'), rid('h2'));
    const before = createShape([t1, h1, t2, h2, t3]);

    const after = deleteRingAndReorganize(before, rid('t1'));
    // t1 removed, h1 (directly under t1) removed, t2 lifted to top-level.
    expect(after.rings.find((r) => r.id === 't1')).toBeUndefined();
    expect(after.rings.find((r) => r.id === 'h1')).toBeUndefined();
    expect(after.rings.find((r) => r.id === 't2')?.kind).toBe('territory');
    // h2 and t3 below t2 are preserved with their relationship.
    expect(after.rings.find((r) => r.id === 'h2')).toBeDefined();
    expect(after.rings.find((r) => r.id === 't3')).toBeDefined();
    expect(isAlternationValid(after)).toBe(true);
  });

  it('deleting a nested territory keeps grand-children under the grandparent hole', () => {
    // top t0 -> h0 -> t1(target) -> h1 -> t2. Delete t1.
    const t0 = createTerritoryRing(rid('t0'), squareVertexIds('z'));
    const h0 = createHoleRing(rid('h0'), squareVertexIds('y'), rid('t0'));
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'), rid('h0'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const t2 = createTerritoryRing(rid('t2'), squareVertexIds('e'), rid('h1'));
    const before = createShape([t0, h0, t1, h1, t2]);

    const after = deleteRingAndReorganize(before, rid('t1'));
    expect(after.rings.find((r) => r.id === 't1')).toBeUndefined();
    expect(after.rings.find((r) => r.id === 'h1')).toBeUndefined();
    // t2 lifted to h0 (the grandparent hole) — territory-under-hole, valid.
    const t2After = after.rings.find((r) => r.id === 't2');
    expect(t2After?.kind).toBe('territory');
    expect(isAlternationValid(after)).toBe(true);
  });

  it('deleting an unknown ring returns the shape unchanged', () => {
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const before = createShape([t1]);
    expect(deleteRingAndReorganize(before, rid('nope'))).toBe(before);
  });
});

describe('childrenOf', () => {
  it('returns the direct children of a ring in shape order', () => {
    const t1 = createTerritoryRing(rid('t1'), squareVertexIds('t'));
    const h1 = createHoleRing(rid('h1'), squareVertexIds('h'), rid('t1'));
    const h2 = createHoleRing(rid('h2'), squareVertexIds('g'), rid('t1'));
    const shape = createShape([t1, h1, h2]);
    expect(childrenOf(shape, rid('t1')).map((r) => r.id)).toEqual(['h1', 'h2']);
    expect(childrenOf(shape, rid('h1'))).toHaveLength(0);
  });
});
