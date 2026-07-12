// FR-33 共有解除 launcher tests — the LIVE unshare over a committed DomainProject.
//
// Drives the domain single-source (unshareReference) through the pure plan builder,
// then commits via the REAL U44 applyEditProposal write-back so the whole path is
// exercised: detach one reference per shared vertex, materialise the reshaped
// neighbour as a FeatureSnapshot, record ONE undo unit, and re-resolve selection.

import { beforeEach, describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createCoordinate } from '../domain/coordinate';
import { createLeafFeature, type LeafFeature } from '../domain/feature';
import { asFeatureId, asRingId, asVertexId, type VertexId } from '../domain/ids';
import { createShape, createTerritoryRing } from '../domain/ring';
import { createVertex, createVertexStore, getVertex } from '../domain/vertex';
import { isCompositeCommand } from '../domain/command/index';
import { createIdGeneratorState } from '../domain/id-generator';
import { applyEditProposal } from '../domain/editing/apply-proposal';
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

/** Two leaves A and B sharing vertex `vs` (A's ring pos 2, B's ring pos 0). */
function sharedVertexProject(): DomainProject {
  const vs = createVertex(VS, createCoordinate(10, 0));
  const a0 = createVertex(asVertexId('a0'), createCoordinate(0, 0));
  const a1 = createVertex(asVertexId('a1'), createCoordinate(20, 0));
  const a2 = createVertex(asVertexId('a2'), createCoordinate(0, 10));
  const b0 = createVertex(asVertexId('b0'), createCoordinate(30, 0));
  const b1 = createVertex(asVertexId('b1'), createCoordinate(30, 10));

  const leafA = createLeafFeature(
    A,
    createBasicAttributes('A', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('A-r'), [a0.id, a1.id, vs.id, a2.id])]),
  );
  const leafB = createLeafFeature(
    B,
    createBasicAttributes('B', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('B-r'), [vs.id, b0.id, b1.id])]),
  );
  return {
    histories: [
      singleAnchorHistory('A', [leafA], createVertexStore([vs, a0, a1, a2])),
      singleAnchorHistory('B', [leafB], createVertexStore([vs, b0, b1])),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function leafRingIds(root: DomainProject, id: ReturnType<typeof asFeatureId>): readonly VertexId[] {
  const f = featuresAt(root, TIME).find((x) => x.id === id) as LeafFeature | undefined;
  return f?.shape.rings[0]?.vertexIds ?? [];
}

function ctx(root: DomainProject) {
  let t = 1000;
  return { getRoot: () => root, getTime: () => TIME, idState: createIdGeneratorState(), now: () => (t += 1) };
}

beforeEach(() => clearLiveLookupCache());

describe('buildUnsharePlan — detach one reference per shared vertex', () => {
  it('single owner: detaches the NON-owner reference, owner keeps the original vertex', () => {
    const root = sharedVertexProject();
    const plan = buildUnsharePlan(ctx(root), { vertexIds: new Set([VS]), ownerFeatureId: A });
    expect(plan).not.toBeNull();
    if (plan === null) return;

    // Touched = the neighbour B (not the owner A). vs survives; ONE new vertex minted.
    expect(plan.touchedFeatureIds).toEqual([B]);
    expect(plan.survivedVertexIds).toEqual([VS]);
    expect(plan.createdVertexIds).toHaveLength(1);
    const newId = plan.createdVertexIds[0]!;
    expect(newId).not.toBe(VS);

    // B's snapshot ring cites the NEW id where vs was (position 0); the body is carried.
    const snap = plan.snapshots[0]!;
    expect(snap.featureId).toBe(B);
    const bFeature = snap.snapshot.feature as LeafFeature;
    expect(bFeature.shape.rings[0]!.vertexIds[0]).toBe(newId);
    expect(bFeature.shape.rings[0]!.vertexIds).not.toContain(VS);
    expect(snap.snapshot.vertices.map((v) => v.id)).toEqual([newId]);
  });

  it('multi/unknown owner (null): detaches the first reference, still succeeds', () => {
    const root = sharedVertexProject();
    const plan = buildUnsharePlan(ctx(root), { vertexIds: new Set([VS]), ownerFeatureId: null });
    expect(plan).not.toBeNull();
    // First reference is A's ring, so A becomes the touched (reshaped) feature.
    expect(plan?.touchedFeatureIds).toEqual([A]);
  });

  it('no shared vertex in the request → null (no-op, no幽霊)', () => {
    const root = sharedVertexProject();
    const plan = buildUnsharePlan(ctx(root), {
      vertexIds: new Set([asVertexId('a0')]),
      ownerFeatureId: A,
    });
    expect(plan).toBeNull();
  });
});

describe('runUnshare — ONE undo unit, real applyEditProposal write-back', () => {
  function ports(root: DomainProject): {
    ports: UnsharePorts;
    recorded: { command: import('../domain/command/index').Command<DomainProject>; preference: unknown }[];
  } {
    const recorded: { command: import('../domain/command/index').Command<DomainProject>; preference: unknown }[] = [];
    let t = 5000;
    const p: UnsharePorts = {
      getRoot: () => root,
      getTime: () => TIME,
      getIdState: () => createIdGeneratorState(),
      now: () => (t += 1),
      applyProposal: (r, proposal) => applyEditProposal(r, proposal, CAL),
      recordCommit: (command, preference) => recorded.push({ command, preference }),
    };
    return { ports: p, recorded };
  }

  it('single owner: unshare applies, records a composite undo unit, keeps selection', () => {
    const root = sharedVertexProject();
    const { ports: p, recorded } = ports(root);
    const result = runUnshare({ vertexIds: new Set([VS]), ownerFeatureId: A }, p);

    expect(result).not.toBeNull();
    expect(recorded).toHaveLength(1);
    const { command, preference } = recorded[0]!;
    expect(isCompositeCommand(command)).toBe(true);

    // Execute → the neighbour B now cites the new id; the owner A still cites vs.
    const forward = command.execute(root);
    clearLiveLookupCache();
    const newId = [...(result?.created ?? [])][0]! as VertexId;
    expect(leafRingIds(forward.state, B)).not.toContain(VS);
    expect(leafRingIds(forward.state, B)[0]).toBe(newId);
    expect(leafRingIds(forward.state, A)).toContain(VS);
    // Both bodies exist after unshare (same coordinate, distinct ids).
    expect(getVertex(verticesAt(forward.state, TIME), VS)).toBeDefined();
    expect(getVertex(verticesAt(forward.state, TIME), newId)).toBeDefined();

    // CommandResult: owner + original vertex survive; new id created; nothing deleted.
    expect(forward.result.survived.has(A)).toBe(true);
    expect(forward.result.survived.has(VS)).toBe(true);
    expect(forward.result.created.has(newId)).toBe(true);
    expect(forward.result.deleted.size).toBe(0);

    // Re-resolution preference keeps {owner A → original vs} selected (受け入れ基準 12).
    expect(preference).toEqual({ vertexSelection: { ownerFeatureId: A, vertexIds: new Set([VS]) } });

    // Undo restores the shared reference and drops the minted vertex.
    const back = command.undo(forward.state);
    clearLiveLookupCache();
    expect(leafRingIds(back.state, B)).toContain(VS);
    expect(getVertex(verticesAt(back.state, TIME), newId)).toBeUndefined();
    expect(back.result.deleted.has(newId)).toBe(true);
  });

  it('multi/unknown owner (null): commits, empty re-resolution preference', () => {
    const root = sharedVertexProject();
    const { ports: p, recorded } = ports(root);
    const result = runUnshare({ vertexIds: new Set([VS]), ownerFeatureId: null }, p);
    expect(result).not.toBeNull();
    expect(recorded[0]!.preference).toEqual({});
  });

  it('no shared vertex → no command recorded (no幽霊 undo)', () => {
    const root = sharedVertexProject();
    const { ports: p, recorded } = ports(root);
    const result = runUnshare({ vertexIds: new Set([asVertexId('a0')]), ownerFeatureId: A }, p);
    expect(result).toBeNull();
    expect(recorded).toHaveLength(0);
  });
});
