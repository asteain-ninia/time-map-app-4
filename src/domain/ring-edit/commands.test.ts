// U25 — ring-edit commands (FR-22〜FR-25 / FR-88 / FR-89, 受け入れ基準 1〜5).

import { describe, expect, it } from 'vitest';
import { RING_KIND } from '../ring';
import { featureVertexIds } from '../editing/move';
import { RING_ADD_MODE } from './auto-mode';
import {
  RING_COMMAND_STATUS,
  RING_DELETE_OUTCOME,
  RING_REJECT,
  addEnclave,
  addHole,
  addRing,
  addRingVertex,
  deleteHoleRing,
  deleteRingVertex,
  deleteTerritoryRing,
  moveRingVertex,
  validateCandidate,
} from './commands';
import {
  addVertices,
  coord,
  idPorts,
  rid,
  squareLeaf,
  squareWithHoleLeaf,
  vid,
} from './fixtures';

describe('addHole (FR-22 穴作成 / FR-23 no new feature)', () => {
  it('adds a hole ring inside the enclosing territory and stays single-feature', () => {
    const { feature, vertices } = squareLeaf();
    const ids = idPorts('h');
    const verts = [coord(40, 40), coord(60, 40), coord(50, 60)];
    const res = addHole(feature, verts, vertices, ids);
    expect(res.status).toBe(RING_COMMAND_STATUS.Ok);
    if (res.status !== RING_COMMAND_STATUS.Ok) return;
    // The leaf gained exactly one hole ring; the feature id is unchanged (no new地物).
    expect(res.feature.id).toBe(feature.id);
    const holes = res.feature.shape.rings.filter((r) => r.kind === RING_KIND.Hole);
    expect(holes).toHaveLength(1);
    expect(holes[0]?.parentRingId).toBe(rid('T0'));
    expect(res.vertices).toHaveLength(3);
  });

  it('rejects < 3 vertices (FR-22 最低3点)', () => {
    const { feature, vertices } = squareLeaf();
    const res = addHole(feature, [coord(40, 40), coord(60, 40)], vertices, idPorts());
    expect(res.status).toBe(RING_COMMAND_STATUS.Rejected);
    if (res.status === RING_COMMAND_STATUS.Rejected) {
      expect(res.reason).toBe(RING_REJECT.TooFewVertices);
    }
  });

  it('rejects a hole whose first vertex is in no territory', () => {
    const { feature, vertices } = squareLeaf();
    const res = addHole(feature, [coord(200, 200), coord(210, 200), coord(205, 210)], vertices, idPorts());
    expect(res.status).toBe(RING_COMMAND_STATUS.Rejected);
    if (res.status === RING_COMMAND_STATUS.Rejected) {
      expect(res.reason).toBe(RING_REJECT.NoEnclosingTerritory);
    }
  });

  it('rejects a hole that escapes its parent (FR-25 包含検証, same U07 fn)', () => {
    const { feature, vertices: base } = squareLeaf();
    // Hole vertices reach outside T0 (x=140) → not contained → HierarchyInvalid.
    const verts = [coord(40, 40), coord(140, 40), coord(90, 60)];
    const res = addHole(feature, verts, base, idPorts());
    expect(res.status).toBe(RING_COMMAND_STATUS.Rejected);
    if (res.status === RING_COMMAND_STATUS.Rejected) {
      expect(res.reason).toBe(RING_REJECT.HierarchyInvalid);
      expect(res.validation?.valid).toBe(false);
    }
  });
});

describe('addEnclave (FR-22 飛び地作成 — mirror of addHole)', () => {
  it('adds a separate top-level territory ring; feature count unchanged', () => {
    const { feature, vertices } = squareLeaf();
    const ids = idPorts('e');
    const verts = [coord(200, 0), coord(300, 0), coord(250, 100)];
    const res = addEnclave(feature, verts, ids, vertices);
    expect(res.status).toBe(RING_COMMAND_STATUS.Ok);
    if (res.status !== RING_COMMAND_STATUS.Ok) return;
    const territories = res.feature.shape.rings.filter((r) => r.kind === RING_KIND.Territory);
    expect(territories).toHaveLength(2);
    // the enclave is top-level (no parent).
    expect(territories.every((t) => t.kind === RING_KIND.Territory)).toBe(true);
    expect(res.feature.id).toBe(feature.id);
  });

  it('rejects an enclave overlapping the existing outer territory (FR-25 非重複)', () => {
    const { feature, vertices } = squareLeaf();
    // Overlaps T0 (shares the (0,0)-(100,100) area).
    const verts = [coord(50, 50), coord(150, 50), coord(100, 150)];
    const res = addEnclave(feature, verts, idPorts(), vertices);
    expect(res.status).toBe(RING_COMMAND_STATUS.Rejected);
    if (res.status === RING_COMMAND_STATUS.Rejected) {
      expect(res.reason).toBe(RING_REJECT.HierarchyInvalid);
    }
  });

  it('addRing dispatches by auto-classified mode (both branches reachable)', () => {
    const { feature, vertices } = squareLeaf();
    const holeRes = addRing(feature, RING_ADD_MODE.Hole, [coord(40, 40), coord(60, 40), coord(50, 60)], vertices, idPorts('h'));
    expect(holeRes.status).toBe(RING_COMMAND_STATUS.Ok);
    const encRes = addRing(feature, RING_ADD_MODE.Enclave, [coord(200, 0), coord(300, 0), coord(250, 100)], vertices, idPorts('e'));
    expect(encRes.status).toBe(RING_COMMAND_STATUS.Ok);
  });
});

describe('edit — move / add / delete vertex on hole/enclave rings (FR-25 / FR-88 / FR-89)', () => {
  it('moveRingVertex accepts a legal move and rejects one breaking containment', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    // Legal: nudge a hole vertex while staying inside T0.
    const ok = moveRingVertex(feature, vid('h0'), coord(42, 42), vertices);
    expect(ok.status).toBe(RING_COMMAND_STATUS.Ok);
    // Illegal: push a hole vertex outside the parent territory.
    const bad = moveRingVertex(feature, vid('h0'), coord(-50, 40), vertices);
    expect(bad.status).toBe(RING_COMMAND_STATUS.Rejected);
    if (bad.status === RING_COMMAND_STATUS.Rejected) {
      expect(bad.reason).toBe(RING_REJECT.HierarchyInvalid);
    }
  });

  it('addRingVertex inserts a generated vertex on a hole edge (FR-87)', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    const ids = idPorts('add');
    const res = addRingVertex(feature, rid('H0'), vid('h0'), vid('h1'), coord(50, 38), vertices, ids);
    expect(res.status).toBe(RING_COMMAND_STATUS.Ok);
    if (res.status !== RING_COMMAND_STATUS.Ok) return;
    const h0 = res.feature.shape.rings.find((r) => r.id === rid('H0'));
    expect(h0?.vertexIds).toHaveLength(5); // 4 + 1 new
    expect(res.vertices).toHaveLength(1);
  });

  it('deleteRingVertex below 3 removes the ring via U07 reorg (FR-88 リング単位)', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    // H0 has 4 vertices; delete two → drops below 3 → ring removed.
    const after1 = deleteRingVertex(feature, rid('H0'), vid('h0'), vertices);
    expect(after1.kind).toBe(RING_DELETE_OUTCOME.FeatureSurvives);
    if (after1.kind !== RING_DELETE_OUTCOME.FeatureSurvives) return;
    const after2 = deleteRingVertex(after1.feature, rid('H0'), vid('h1'), vertices);
    expect(after2.kind).toBe(RING_DELETE_OUTCOME.FeatureSurvives);
    if (after2.kind !== RING_DELETE_OUTCOME.FeatureSurvives) return;
    expect(after2.removedRingIds).toContain(rid('H0'));
    expect(after2.feature.shape.rings.some((r) => r.id === rid('H0'))).toBe(false);
    // The leaf still has its territory.
    expect(after2.feature.shape.rings.some((r) => r.kind === RING_KIND.Territory)).toBe(true);
  });
});

describe('FR-89 — hole/enclave vertices are NOT excluded from the edit基盤', () => {
  it('featureVertexIds includes every hole and enclave vertex (受け入れ基準 5 漏らさない)', () => {
    const { feature } = squareWithHoleLeaf();
    const ids = featureVertexIds(feature);
    // outer + hole vertices both present → the U24 move/snap/slide基盤 sees them all.
    for (const v of ['a', 'b', 'c', 'd', 'h0', 'h1', 'h2', 'h3']) {
      expect(ids).toContain(vid(v));
    }
  });

  it('an added enclave ring contributes its vertices to the same set', () => {
    const { feature, vertices } = squareLeaf();
    const res = addEnclave(feature, [coord(200, 0), coord(300, 0), coord(250, 100)], idPorts('e'), vertices);
    expect(res.status).toBe(RING_COMMAND_STATUS.Ok);
    if (res.status !== RING_COMMAND_STATUS.Ok) return;
    const ids = featureVertexIds(res.feature);
    // 4 outer + 3 enclave = 7 distinct vertices.
    expect(ids).toHaveLength(7);
  });
});

describe('validateCandidate — shared real-time / pre-commit gate (教訓 5.26)', () => {
  it('the SAME validation backs the live overlay and the command rejection', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    // Build the same illegal candidate the live overlay would test: hole vertex outside parent.
    const moved = addVertices(vertices, ['h0', -50, 40]);
    const live = validateCandidate(feature.shape, moved);
    expect(live.valid).toBe(false);
    // The command path produces the identical rejection value.
    const cmd = moveRingVertex(feature, vid('h0'), coord(-50, 40), vertices);
    expect(cmd.status).toBe(RING_COMMAND_STATUS.Rejected);
    if (cmd.status === RING_COMMAND_STATUS.Rejected) {
      expect(cmd.validation).toEqual(live);
    }
  });
});

describe('delete — hole ring vs territory ring (FR-24 mirror pair)', () => {
  it('deleteHoleRing removes the hole and the face survives', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    const res = deleteHoleRing(feature, rid('H0'), vertices);
    expect(res.kind).toBe(RING_DELETE_OUTCOME.FeatureSurvives);
    if (res.kind !== RING_DELETE_OUTCOME.FeatureSurvives) return;
    expect(res.feature.shape.rings.some((r) => r.id === rid('H0'))).toBe(false);
    expect(res.feature.shape.rings).toHaveLength(1);
  });

  it('deleteTerritoryRing on the LAST territory deletes the whole leaf', () => {
    const { feature, vertices } = squareLeaf();
    const res = deleteTerritoryRing(feature, rid('T0'), vertices);
    expect(res.kind).toBe(RING_DELETE_OUTCOME.FeatureDeleted);
  });

  it('deleteTerritoryRing on an enclave keeps the face (other territory remains)', () => {
    const { feature, vertices: base } = squareLeaf();
    const ids = idPorts('e');
    const withEnclave = addEnclave(feature, [coord(200, 0), coord(300, 0), coord(250, 100)], ids, base);
    expect(withEnclave.status).toBe(RING_COMMAND_STATUS.Ok);
    if (withEnclave.status !== RING_COMMAND_STATUS.Ok) return;
    const enclaveRing = withEnclave.feature.shape.rings.find((r) => r.id !== rid('T0'));
    expect(enclaveRing).toBeDefined();
    if (enclaveRing === undefined) return;
    // delete the enclave ring → original territory remains → face survives.
    const storeWith = addVertices(base, ...withEnclave.vertices.map(
      (v) => [v.id as unknown as string, v.coordinate.lon, v.coordinate.lat] as const,
    ));
    const res = deleteTerritoryRing(withEnclave.feature, enclaveRing.id, storeWith);
    expect(res.kind).toBe(RING_DELETE_OUTCOME.FeatureSurvives);
    if (res.kind !== RING_DELETE_OUTCOME.FeatureSurvives) return;
    expect(res.feature.shape.rings.some((r) => r.id === rid('T0'))).toBe(true);
  });

  it('rejects deleting a ring of the wrong kind / not present', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    // T0 is a territory, not a hole.
    const wrong = deleteHoleRing(feature, rid('T0'), vertices);
    expect(wrong.kind).toBe(RING_DELETE_OUTCOME.Rejected);
    const missing = deleteTerritoryRing(feature, rid('NOPE'), vertices);
    expect(missing.kind).toBe(RING_DELETE_OUTCOME.Rejected);
  });
});
