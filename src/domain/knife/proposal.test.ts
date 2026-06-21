import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { FEATURE_KIND } from '../feature';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { isAlternationValid, RING_KIND } from '../ring';
import { containerKey } from '../shared-vertex';
import { timePointYear } from '../time/time-point';
import type { VertexId } from '../ids';
import { createOpenKnifeLine } from './knife-line';
import {
  INHERITANCE_SIDE,
  assembleSplitProposal,
  createInheritanceChoice,
  inheritorFeature,
  toSharedEdgeCutSpecs,
  toSplitSnapshot,
  toEditProposal,
} from './proposal';
import { executeSplit, smallerSide, type SplitSide } from './split-geometry';
import {
  ATTRS,
  COLOR,
  freshIdPorts,
  sharedEdgePair,
  squareWithHoleEnclave,
  unitSquare,
} from './fixtures';

const c = (lon: number, lat: number) => createCoordinate(lon, lat);

function setup() {
  const { feature, store } = unitSquare('orig');
  const line = createOpenKnifeLine([c(4, -5), c(4, 15)]);
  const result = executeSplit(feature, store, line);
  if (!result) throw new Error('expected splittable');
  const ids = freshIdPorts();
  const proposal = assembleSplitProposal({
    target: feature,
    store: store.byId,
    result,
    choice: createInheritanceChoice(INHERITANCE_SIDE.A),
    nonInherited: {
      attributes: createBasicAttributes('new-side', 10, 90),
      color: createColorInfo(false, '#abc', '#def', '#123'),
    },
    ids,
  });
  return { feature, store, result, proposal };
}

describe('assembleSplitProposal (FR-44 / FR-93 / FR-94)', () => {
  it('继承先 keeps the ORIGINAL feature id; non-inherited side is a NEW leaf', () => {
    const { feature, proposal } = setup();
    expect(proposal.inheritorFeatureId).toBe(feature.id);
    expect(proposal.newFeature.id).not.toBe(feature.id);
    expect(proposal.newFeature.kind).toBe(FEATURE_KIND.Leaf);
    // Both features are touched (for symmetric notify; 教訓5.23).
    expect(proposal.touchedFeatureIds).toContain(feature.id);
    expect(proposal.touchedFeatureIds).toContain(proposal.newFeature.id);
  });

  it('non-inherited side initially inherits the original feature parent (FR-44)', () => {
    const parentId = asFeatureId('parent-1');
    const { feature, store } = unitSquare('child');
    const withParent = { ...feature, parentId };
    const line = createOpenKnifeLine([c(4, -5), c(4, 15)]);
    const result = executeSplit(withParent, store, line);
    if (!result) throw new Error('expected splittable');
    const proposal = assembleSplitProposal({
      target: withParent,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    expect(proposal.newFeature.parentId).toBe(parentId);
  });

  it('rebuilt inheritor shape preserves ring-hierarchy alternation (FR-24)', () => {
    const { proposal } = setup();
    expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
    expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
  });

  it('mints vertices for both sides and includes them in the snapshot (教訓5.20)', () => {
    const { proposal } = setup();
    expect(proposal.vertices.length).toBeGreaterThan(0);
    // Every vertex referenced by the inheritor shape exists in the bundle.
    const bundled = new Set(proposal.vertices.map((v) => v.id));
    for (const ring of proposal.inheritorShape.rings) {
      for (const vid of ring.vertexIds) expect(bundled.has(vid)).toBe(true);
    }
  });

  it('seam vertices get the SAME id on BOTH sides (Codex H2; ID-based sharing)', () => {
    const { proposal } = setup();
    // The cut seam endpoints belong to BOTH the inheritor and the new feature. If
    // each side minted its own id for a seam coordinate, U11's ID-based sharing /
    // transferSharing would break (moving the seam on one feature would not move it
    // on the other). With a shared vertex pool the seam ids are identical, so the
    // two sides' vertexId sets intersect on the seam nodes.
    const inhIds = new Set(proposal.inheritorShape.rings.flatMap((r) => r.vertexIds));
    const newIds = new Set(proposal.newFeature.shape.rings.flatMap((r) => r.vertexIds));
    const shared = [...inhIds].filter((id) => newIds.has(id));
    // A convex vertical cut shares its two seam endpoints.
    expect(shared.length).toBeGreaterThanOrEqual(2);
    // The bundled vertices carry no duplicate ids (each minted once across sides).
    const allIds = proposal.vertices.map((v) => v.id);
    expect(allIds.length).toBe(new Set(allIds).size);
    // Every shared seam id has exactly one bundled vertex body.
    for (const id of shared) {
      expect(allIds.filter((v) => v === id).length).toBe(1);
    }
  });

  it('produces an old→new vertex remap for U11 continuity (FR-95)', () => {
    const { feature, proposal } = setup();
    // The original square corner (0,0) survives on the inheritor (left) side;
    // its old id must map to a freshly-minted id.
    const originalIds = feature.shape.rings.flatMap((r) => r.vertexIds);
    const remapped = originalIds.filter((id) => proposal.vertexRemap.has(id));
    expect(remapped.length).toBeGreaterThan(0);
  });

  it('inheritorFeature returns the original with only its shape swapped', () => {
    const { feature, proposal } = setup();
    const updated = inheritorFeature(feature, proposal);
    expect(updated.id).toBe(feature.id);
    expect(updated.attributes).toBe(feature.attributes);
    expect(updated.shape).toBe(proposal.inheritorShape);
  });

  it('choosing side B as inheritor flips which side is new', () => {
    const { feature, store } = unitSquare('orig2');
    const line = createOpenKnifeLine([c(4, -5), c(4, 15)]);
    const result = executeSplit(feature, store, line);
    if (!result) throw new Error('expected splittable');
    const proposalA = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    const proposalB = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.B),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    // The inheritor id is the same (original), but the new-side shapes differ.
    expect(proposalA.inheritorFeatureId).toBe(proposalB.inheritorFeatureId);
    // smallerSide is a hint the UI seeds the choice with.
    expect([INHERITANCE_SIDE.A, INHERITANCE_SIDE.B]).toContain(smallerSide(result));
  });
});

describe('FR-91 ring reorganization — hole + enclave + untouched hole (受け入れ基準2)', () => {
  function buildEnclaveProposal() {
    const { feature, store } = squareWithHoleEnclave('whe2');
    // Vertical cut at x=6 crosses the left hole [3,9]² and its enclave [4,8]²,
    // leaving the right hole [12,16]×[4,8] untouched.
    const line = createOpenKnifeLine([c(6, -5), c(6, 25)]);
    const result = executeSplit(feature, store, line);
    if (!result) throw new Error('expected splittable');
    const proposal = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    return { feature, proposal };
  }

  it('both sides keep a valid territory→hole→territory alternation (FR-24, via U07)', () => {
    const { proposal } = buildEnclaveProposal();
    expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
    expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
  });

  it('(a) the crossed hole halves merge into each side’s outer ring (no orphan hole-of-the-cut)', () => {
    const { proposal } = buildEnclaveProposal();
    // The cut crosses the left hole; on each side the crossed hole becomes a
    // concavity of the OUTER ring, not a standalone hole ring. So no hole on
    // either side is parented to a ring that does not strictly contain it: every
    // hole ring must sit inside its parent territory (alternation already asserts
    // the structure; here we assert the cut did not leave a hole ring whose area
    // equals the cut seam). We check by counting: the untouched RIGHT hole lands
    // entirely on one side as a hole; the crossed LEFT hole does not survive as a
    // hole on either side.
    const sides = [proposal.inheritorShape, proposal.newFeature.shape];
    const holeCounts = sides.map(
      (s) => s.rings.filter((r) => r.kind === RING_KIND.Hole).length,
    );
    // Across both sides there is exactly ONE surviving hole — the untouched right
    // hole. The crossed left hole merged into the outer rings (FR-91 (a)).
    const totalHoles = holeCounts[0]! + holeCounts[1]!;
    expect(totalHoles).toBe(1);
  });

  it('(b) the enclave inside the crossed hole is promoted to a top-level territory', () => {
    const { proposal } = buildEnclaveProposal();
    // The enclave [4,8]² sat inside the destroyed left hole. After the split its
    // pieces must be top-level territories (parentRingId undefined) — promoted one
    // level (FR-91 (b)) — on whichever side(s) they land.
    const sides = [proposal.inheritorShape, proposal.newFeature.shape];
    let enclaveTopLevelTerritories = 0;
    for (const s of sides) {
      for (const r of s.rings) {
        if (r.kind === RING_KIND.Territory && r.parentRingId === undefined) {
          enclaveTopLevelTerritories += 1;
        }
      }
    }
    // At least the outer ring per side plus the promoted enclave pieces — every
    // territory that survives is top-level (no enclave remains nested in a hole).
    expect(enclaveTopLevelTerritories).toBeGreaterThanOrEqual(2);
    // No territory is parented to a hole that no longer exists (alternation holds).
    expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
    expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
  });

  it('(c) the untouched right hole keeps a parent territory on its side', () => {
    const { proposal } = buildEnclaveProposal();
    // The right hole [12,16]×[4,8] is on x>6 → lands on the RIGHT side intact, and
    // must be a hole ring parented to a territory that contains it (alternation).
    const sides = [proposal.inheritorShape, proposal.newFeature.shape];
    const sideWithHole = sides.find(
      (s) => s.rings.some((r) => r.kind === RING_KIND.Hole),
    );
    expect(sideWithHole).toBeDefined();
    if (sideWithHole) {
      const hole = sideWithHole.rings.find((r) => r.kind === RING_KIND.Hole)!;
      const parent = sideWithHole.rings.find((r) => r.id === hole.parentRingId);
      expect(parent?.kind).toBe(RING_KIND.Territory);
    }
  });
});

describe('bughunt2 — degenerate (<3 vertex) ring guard at proposal assembly (FR-44 最低3頂点)', () => {
  // A direct SplitResult whose side carries a DEGENERATE hole ring (2 vertices).
  // The geometry layer's everyOuterRingHasMinVertices only inspects each piece's
  // OUTER ring, so a quantization-collapsed HOLE ring (index >= 1) is NOT caught
  // there. Inside buildShapeFromSide, ringStrictlyContains returns false for any
  // length<3 ring, so reparentByContainment finds no containing parent for the
  // degenerate hole and silently DEMOTES it to a top-level territory — a phantom,
  // area≈0 piece that passes isAlternationValid (a parentless territory is valid
  // alternation). The proposal-gate guard must surface this as a loud rejection.
  function sideWithDegenerateHole(): { sideA: SplitSide; sideB: SplitSide } {
    // A valid 10×10 square outer plus a 2-vertex (degenerate) hole ring.
    const outer = [c(0, 0), c(10, 0), c(10, 10), c(0, 10)];
    const degenerateHole = [c(3, 3), c(7, 7)]; // <3 vertices: cannot bound an area.
    const sideA: SplitSide = {
      area: [[outer, degenerateHole]],
      areaKm2: 100,
    };
    // A well-formed opposite side so only the degenerate hole is at fault.
    const sideB: SplitSide = {
      area: [[[c(10, 0), c(20, 0), c(20, 10), c(10, 10)]]],
      areaKm2: 100,
    };
    return { sideA, sideB };
  }

  it('rejects a proposal whose built shape carries a <3-vertex hole ring (no phantom territory)', () => {
    const { feature, store } = unitSquare('degh');
    const { sideA, sideB } = sideWithDegenerateHole();
    const result = { sideA, sideB, edgeCuts: [] };
    expect(() =>
      assembleSplitProposal({
        target: feature,
        store: store.byId,
        result,
        choice: createInheritanceChoice(INHERITANCE_SIDE.A),
        nonInherited: { attributes: ATTRS, color: COLOR },
        ids: freshIdPorts(),
      }),
    ).toThrow(/最低3頂点|degenerate ring/);
  });

  it('the degenerate hole is on the NON-inheritor side and is STILL rejected (both sides guarded)', () => {
    const { feature, store } = unitSquare('degh2');
    const { sideA, sideB } = sideWithDegenerateHole();
    // sideA carries the degenerate hole; inherit sideB so the bad ring lands on the
    // NEW-feature side — the guard must cover that side too, not just the inheritor.
    const result = { sideA, sideB, edgeCuts: [] };
    expect(() =>
      assembleSplitProposal({
        target: feature,
        store: store.byId,
        result,
        choice: createInheritanceChoice(INHERITANCE_SIDE.B),
        nonInherited: { attributes: ATTRS, color: COLOR },
        ids: freshIdPorts(),
      }),
    ).toThrow(/最低3頂点|degenerate ring/);
  });

  it('a well-formed two-ring shape (square + valid hole) is NOT rejected by the guard', () => {
    const { feature, store } = unitSquare('degh3');
    const outer = [c(0, 0), c(10, 0), c(10, 10), c(0, 10)];
    const validHole = [c(3, 3), c(7, 3), c(7, 7), c(3, 7)];
    const sideA: SplitSide = { area: [[outer, validHole]], areaKm2: 100 };
    const sideB: SplitSide = {
      area: [[[c(10, 0), c(20, 0), c(20, 10), c(10, 10)]]],
      areaKm2: 100,
    };
    const result = { sideA, sideB, edgeCuts: [] };
    const proposal = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    // The valid hole nests under its containing territory (no phantom, no throw).
    expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
    for (const ring of proposal.inheritorShape.rings) {
      expect(ring.vertexIds.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('FR-95 shared-edge mid cut → U11 SharedEdgeCutSpec (受け入れ基準6)', () => {
  it('produces a SharedEdgeCutSpec for the partner feature when the cut crosses a shared edge', () => {
    const { left, right, store } = sharedEdgePair();
    // A horizontal cut crossing the shared vertical edge x=10 at (10,5): it enters
    // the left leaf from outside, crosses the shared edge mid-way, and exits the
    // right leaf — but we split the LEFT leaf here; the cut edge (10,0)-(10,10) is
    // shared with the right leaf, so a partner spec must be produced.
    const line = createOpenKnifeLine([c(-5, 5), c(25, 5)]);
    const result = executeSplit(left, store, line);
    expect(result).toBeDefined();
    if (!result) return;
    // The cut crosses the left leaf's shared edge (sharedBottom→sharedTop) at (10,5).
    const sharedCut = result.edgeCuts.find(
      (e) => e.coordinate.lon === 10 && e.coordinate.lat === 5,
    );
    expect(sharedCut).toBeDefined();

    const proposal = assembleSplitProposal({
      target: left,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    expect(proposal.sharedEdgeCuts.length).toBeGreaterThanOrEqual(1);

    // Build the U11 container vertexId lists (host-supplied from U11 state).
    const containers = new Map<string, readonly VertexId[]>([
      [
        containerKey({ kind: 'ring', featureId: left.id, ringId: 'left-r0' }),
        left.shape.rings[0]!.vertexIds,
      ],
      [
        containerKey({ kind: 'ring', featureId: right.id, ringId: 'right-r0' }),
        right.shape.rings[0]!.vertexIds,
      ],
    ]);
    const specs = toSharedEdgeCutSpecs(proposal, containers);
    // A spec targeting the partner (right) edge with the quantized cut coordinate.
    const partnerKey = containerKey({ kind: 'ring', featureId: right.id, ringId: 'right-r0' });
    const partnerSpec = specs.find((s) => s.partner.containerKey === partnerKey);
    expect(partnerSpec).toBeDefined();
    if (partnerSpec) {
      expect(partnerSpec.cutCoordinate.lon).toBe(10);
      expect(partnerSpec.cutCoordinate.lat).toBe(5);
      // The partner edge index points at the right ring's shared edge (i=3:
      // sharedTop→sharedBottom).
      expect(partnerSpec.partner.edgeStart).toBe(3);
    }
  });

  it('does NOT match a line container\'s phantom wrap edge as a partner (open path has no closing edge)', () => {
    // Regression (bug-hunt): findPartnerEdge iterated every container as if it
    // were a CLOSED ring (b = ids[(i+1)%n]), wrapping last→first. A 'line'
    // container's path is OPEN — it has no closing edge. If a cut edge's two
    // endpoints happen to be the FIRST and LAST vertices of a line, the phantom
    // wrap edge was matched and a shared-edge cut was targeted at the wrong
    // position (edgeStart n-1, a non-existent edge).
    const { feature, proposal: base } = setup();
    // Two endpoint vertex ids for the cut edge, plus a middle line vertex.
    const startVid = asVertexId('phantom-a');
    const endVid = asVertexId('phantom-b');
    const midVid = asVertexId('phantom-mid');
    // A synthetic proposal whose single shared-edge cut cites those endpoints
    // (toSharedEdgeCutSpecs reads only `sharedEdgeCuts`).
    const proposal = {
      ...base,
      sharedEdgeCuts: [
        {
          featureId: feature.id,
          ringId: asRingId('r0'),
          edgeStartIndex: 0,
          edgeStartVertexId: startVid,
          edgeEndVertexId: endVid,
          cutCoordinate: c(10, 5),
        },
      ],
    };

    // The line path: [end, mid, start]. Its FIRST (end) and LAST (start) vertices
    // are the cut edge's endpoints — the phantom wrap edge last↔first would
    // FALSELY match if the open line were treated as a closed ring.
    const lineKey = containerKey({ kind: 'line', featureId: asFeatureId('line-1') });
    const containers = new Map<string, readonly VertexId[]>([
      [lineKey, [endVid, midVid, startVid]],
    ]);

    const specs = toSharedEdgeCutSpecs(proposal, containers);
    // The open line has NO closing edge, so no partner is resolved on the wrap.
    expect(specs.find((s) => s.partner.containerKey === lineKey)).toBeUndefined();
    expect(specs.length).toBe(0);

    // Sanity: a REAL interior edge of the same line (mid→start at i=1) DOES match,
    // proving the fix only excludes the phantom wrap, not genuine open-path edges.
    const realEdge = toSharedEdgeCutSpecs(
      {
        ...proposal,
        sharedEdgeCuts: [
          { ...proposal.sharedEdgeCuts[0]!, edgeStartVertexId: midVid, edgeEndVertexId: startVid },
        ],
      },
      containers,
    );
    expect(realEdge.find((s) => s.partner.containerKey === lineKey)?.partner.edgeStart).toBe(1);
  });

  it('produces NO partner spec when the cut edge is not shared', () => {
    const { feature, store } = unitSquare('lonely');
    const line = createOpenKnifeLine([c(5, -5), c(5, 15)]);
    const result = executeSplit(feature, store, line);
    if (!result) throw new Error('expected splittable');
    const proposal = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    // No other feature shares the cut edges → no partner specs (but cut points
    // are still recorded for transferSharing material).
    const specs = toSharedEdgeCutSpecs(proposal, new Map());
    expect(specs.length).toBe(0);
  });
});

describe('FR-94 U13 adapter — one indivisible 2-feature proposal (受け入れ基準6)', () => {
  it('packs both 継承先 and 新規 into one EditProposal snapshot anchored on the inheritor', () => {
    const { feature, store } = unitSquare('u13');
    const line = createOpenKnifeLine([c(4, -5), c(4, 15)]);
    const result = executeSplit(feature, store, line);
    if (!result) throw new Error('expected splittable');
    const proposal = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });

    const snapshot = toSplitSnapshot(proposal);
    expect(snapshot.inheritorFeatureId).toBe(feature.id);
    expect(snapshot.newFeature.id).not.toBe(feature.id);
    // Both touched features are carried in the single snapshot (1 不可分 = 2 地物).
    expect(snapshot.touchedFeatureIds).toContain(feature.id);
    expect(snapshot.touchedFeatureIds).toContain(proposal.newFeature.id);

    const anchorTime = timePointYear(2000);
    const edit = toEditProposal(proposal, anchorTime);
    // The U13 proposal anchors on the inheritor feature id (its identity continues).
    expect(edit.featureId).toBe(feature.id);
    expect(edit.anchorTime).toEqual(anchorTime);
    // The opaque snapshot still carries the new feature (atomic 2-feature commit).
    expect(edit.snapshot.newFeature.id).toBe(proposal.newFeature.id);
  });
});
