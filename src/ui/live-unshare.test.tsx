// FR-33 共有解除 launcher tests — the LIVE owner-qualified unshare over a committed
// DomainProject.
//
// Owner-qualified: unsharing OWNER A detaches A's own reference — A gets a fresh
// same-coordinate copy `v'`, every OTHER citer keeps `v`, so A is fully separated from
// ALL neighbours in one op (even a 3-owner vertex). The owner's selection remaps onto
// `v'`. Drives the domain single-source (unshareReference) + the REAL U44
// applyEditProposal write-back + the REAL U22 reresolveAfterStructureChange.

import { beforeEach, describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createCoordinate } from '../domain/coordinate';
import { createLeafFeature, type LeafFeature } from '../domain/feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from '../domain/ids';
import { createShape, createTerritoryRing } from '../domain/ring';
import { createVertex, createVertexStore, getVertex } from '../domain/vertex';
import { isCompositeCommand, type Command } from '../domain/command/index';
import { createIdGeneratorState } from '../domain/id-generator';
import { applyEditProposal } from '../domain/editing/apply-proposal';
import { EMPTY_SELECTION, replaceVertices, reresolveAfterStructureChange } from '../domain/selection/index';
import { getCalendar } from '../domain/time/calendar';
import { timePointYear } from '../domain/time/time-point';
import type { DomainProject } from '../domain/persistence/index';
import { singleAnchorHistory, DEFAULT_SETTINGS, DEFAULT_BASEMAP } from '../domain/persistence/fixtures';

import { buildUnsharePlan, runUnshare, type UnsharePorts } from './live-unshare';
import { clearLiveLookupCache, featuresAt, verticesAt } from './live-lookup';

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#111111', '#222222', '#333333', 'default', 1, 1);
const TIME = timePointYear(0);
const A = asFeatureId('A');
const B = asFeatureId('B');
const VS = asVertexId('vs');

function leaf(id: string, ringId: string, ids: readonly VertexId[]): LeafFeature {
  return createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId(ringId), ids)]),
  );
}

/** Two leaves A and B sharing vertex `vs` (A's ring pos 2, B's ring pos 0). */
function sharedVertexProject(): DomainProject {
  const vs = createVertex(VS, createCoordinate(10, 0));
  const a0 = createVertex(asVertexId('a0'), createCoordinate(0, 0));
  const a1 = createVertex(asVertexId('a1'), createCoordinate(20, 0));
  const a2 = createVertex(asVertexId('a2'), createCoordinate(0, 10));
  const b0 = createVertex(asVertexId('b0'), createCoordinate(30, 0));
  const b1 = createVertex(asVertexId('b1'), createCoordinate(30, 10));
  return {
    histories: [
      singleAnchorHistory('A', [leaf('A', 'A-r', [a0.id, a1.id, vs.id, a2.id])], createVertexStore([vs, a0, a1, a2])),
      singleAnchorHistory('B', [leaf('B', 'B-r', [vs.id, b0.id, b1.id])], createVertexStore([vs, b0, b1])),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** Three leaves A/B/C all citing `vs` (a 3-owner shared vertex). */
function threeOwnerProject(): DomainProject {
  const vs = createVertex(VS, createCoordinate(10, 0));
  const a0 = createVertex(asVertexId('a0'), createCoordinate(0, 0));
  const a1 = createVertex(asVertexId('a1'), createCoordinate(0, 10));
  const b0 = createVertex(asVertexId('b0'), createCoordinate(20, 0));
  const b1 = createVertex(asVertexId('b1'), createCoordinate(20, 10));
  const c0 = createVertex(asVertexId('c0'), createCoordinate(30, 0));
  const c1 = createVertex(asVertexId('c1'), createCoordinate(30, 10));
  return {
    histories: [
      singleAnchorHistory('A', [leaf('A', 'A-r', [a0.id, a1.id, vs.id])], createVertexStore([vs, a0, a1])),
      singleAnchorHistory('B', [leaf('B', 'B-r', [vs.id, b0.id, b1.id])], createVertexStore([vs, b0, b1])),
      singleAnchorHistory('C', [leaf('C', 'C-r', [vs.id, c0.id, c1.id])], createVertexStore([vs, c0, c1])),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function leafRingIds(root: DomainProject, id: FeatureId): readonly VertexId[] {
  const f = featuresAt(root, TIME).find((x) => x.id === id) as LeafFeature | undefined;
  return f?.shape.rings[0]?.vertexIds ?? [];
}

function ctx(root: DomainProject, opts: { now?: () => number; reserved?: ReadonlySet<string> } = {}) {
  let t = 1000;
  return {
    getRoot: () => root,
    getTime: () => TIME,
    idState: createIdGeneratorState(),
    now: opts.now ?? (() => (t += 1)),
    reservedVertexIds: opts.reserved ?? new Set<string>(),
  };
}

beforeEach(() => clearLiveLookupCache());

describe('buildUnsharePlan — owner-qualified: detach the OWNER reference', () => {
  it('single owner: owner gets the new copy, the neighbour keeps the original', () => {
    const root = sharedVertexProject();
    const plan = buildUnsharePlan(ctx(root), { vertexIds: new Set([VS]), ownerFeatureId: A });
    expect(plan).not.toBeNull();
    if (plan === null) return;

    // The OWNER A is the touched feature; ONE new vertex minted for A.
    expect(plan.touchedFeatureIds).toEqual([A]);
    expect(plan.createdVertexIds).toHaveLength(1);
    const newId = plan.createdVertexIds[0]!;
    expect(newId).not.toBe(VS);

    // A's snapshot ring cites the NEW id where vs was (position 2); the body is carried.
    const aFeature = plan.snapshots[0]!.snapshot.feature as LeafFeature;
    expect(aFeature.shape.rings[0]!.vertexIds[2]).toBe(newId);
    expect(aFeature.shape.rings[0]!.vertexIds).not.toContain(VS);
    expect(plan.snapshots[0]!.snapshot.vertices.map((v) => v.id)).toEqual([newId]);
  });

  it('owner unknown (null) → null (owner-null dangling guard, no-op)', () => {
    const root = sharedVertexProject();
    expect(buildUnsharePlan(ctx(root), { vertexIds: new Set([VS]), ownerFeatureId: null })).toBeNull();
  });

  it('no shared vertex in the request → null (no-op, no幽霊)', () => {
    const root = sharedVertexProject();
    expect(
      buildUnsharePlan(ctx(root), { vertexIds: new Set([asVertexId('a0')]), ownerFeatureId: A }),
    ).toBeNull();
  });

  it('project-wide reservation: a minted id colliding with a reserved id is skipped (教訓 5.37)', () => {
    const root = sharedVertexProject();
    // With a fresh generator + now()=0 the first candidate is 'v-0-0'; reserve it.
    const plan = buildUnsharePlan(ctx(root, { now: () => 0, reserved: new Set(['v-0-0']) }), {
      vertexIds: new Set([VS]),
      ownerFeatureId: A,
    });
    expect(plan?.createdVertexIds[0]).not.toBe('v-0-0');
  });
});

describe('runUnshare — ONE undo unit, real applyEditProposal, remap to v', () => {
  function ports(root: DomainProject): {
    ports: UnsharePorts;
    recorded: { command: Command<DomainProject>; preference: unknown }[];
  } {
    const recorded: { command: Command<DomainProject>; preference: unknown }[] = [];
    let t = 5000;
    const p: UnsharePorts = {
      getRoot: () => root,
      getTime: () => TIME,
      getIdState: () => createIdGeneratorState(),
      now: () => (t += 1),
      getReservedVertexIds: () => new Set<string>(),
      applyProposal: (r, proposal) => applyEditProposal(r, proposal, CAL),
      recordCommit: (command, preference) => recorded.push({ command, preference }),
    };
    return { ports: p, recorded };
  }

  it('single owner: owner cites the new id, neighbour keeps vs, one composite undo unit', () => {
    const root = sharedVertexProject();
    const { ports: p, recorded } = ports(root);
    const result = runUnshare({ vertexIds: new Set([VS]), ownerFeatureId: A }, p);

    expect(result).not.toBeNull();
    expect(recorded).toHaveLength(1);
    const { command, preference } = recorded[0]!;
    expect(isCompositeCommand(command)).toBe(true);

    const forward = command.execute(root);
    clearLiveLookupCache();
    const newId = [...(result?.created ?? [])][0]! as VertexId;
    // The OWNER A now cites the new id; the neighbour B keeps vs.
    expect(leafRingIds(forward.state, A)).toContain(newId);
    expect(leafRingIds(forward.state, A)).not.toContain(VS);
    expect(leafRingIds(forward.state, B)).toContain(VS);
    expect(getVertex(verticesAt(forward.state, TIME), VS)).toBeDefined();
    expect(getVertex(verticesAt(forward.state, TIME), newId)).toBeDefined();

    // CommandResult: owner survives; new id created; nothing deleted.
    expect(forward.result.survived.has(A)).toBe(true);
    expect(forward.result.created.has(newId)).toBe(true);
    expect(forward.result.deleted.size).toBe(0);

    // Re-resolution REMAPS the owner's vertex selection onto the new id (受け入れ基準 12).
    expect(preference).toEqual({ vertexSelection: { ownerFeatureId: A, vertexIds: new Set([newId]) } });

    // Undo restores the shared reference and drops the minted vertex.
    const back = command.undo(forward.state);
    clearLiveLookupCache();
    expect(leafRingIds(back.state, A)).toContain(VS);
    expect(getVertex(verticesAt(back.state, TIME), newId)).toBeUndefined();
    expect(back.result.deleted.has(newId)).toBe(true);
  });

  it('owner unknown (null) → no command recorded (no幽霊 undo)', () => {
    const root = sharedVertexProject();
    const { ports: p, recorded } = ports(root);
    expect(runUnshare({ vertexIds: new Set([VS]), ownerFeatureId: null }, p)).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it('3-owner: unshare A fully separates A (B & C keep vs); real reresolve remaps to v', () => {
    const root = threeOwnerProject();
    const C = asFeatureId('C');
    const { ports: p, recorded } = ports(root);
    const result = runUnshare({ vertexIds: new Set([VS]), ownerFeatureId: A }, p)!;
    const newId = [...result.created][0]! as VertexId;

    const forward = recorded[0]!.command.execute(root);
    clearLiveLookupCache();
    // A separated; B AND C still cite vs (in ONE op).
    expect(leafRingIds(forward.state, A)).toContain(newId);
    expect(leafRingIds(forward.state, A)).not.toContain(VS);
    expect(leafRingIds(forward.state, B)).toContain(VS);
    expect(leafRingIds(forward.state, C)).toContain(VS);

    // The REAL U22 re-resolution remaps the owner's selection {A → vs} onto {A → v'}
    // (no dangling: A no longer cites vs, so keeping vs would be stale).
    const before = replaceVertices(EMPTY_SELECTION, A, new Set([VS]));
    const after = reresolveAfterStructureChange(before, forward.result, recorded[0]!.preference as never);
    expect(after.vertexOwner).toBe(A);
    expect(after.vertexIds).toEqual(new Set([newId]));
  });
});
