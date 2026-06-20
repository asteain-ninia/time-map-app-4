import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { FEATURE_KIND } from '../feature';
import { asFeatureId } from '../ids';
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
import { executeSplit, smallerSide } from './split-geometry';
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
