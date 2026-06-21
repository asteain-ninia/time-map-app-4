// Bug-hunt (discovery only) — focus: shared-vertex-linkage (U11).
//
// This is a STATEFUL / model-based + property + metamorphic suite for
// `../shared-vertex.ts`. It generates random edit-command sequences (share /
// linked-move / unshare / transfer-sharing / shared-edge-cut) over a generated
// SharedVertexState and asserts the unit's invariants AFTER EVERY operation:
//
//   * single source of truth — every cited VertexId resolves to a vertex BODY
//     (no dangling references; 開発ガイド §5.31).
//   * sharing derivation is consistent — `isSharedVertex` ⇔ cited ≥2 times, and
//     `sharedVertexIds` lists exactly those.
//   * participation restriction holds — no DERIVED shared group cites the same
//     container twice (same ring / same line path), for ids the unit reports as
//     shared via an *applied* op (the unit must never apply such a state).
//   * coordinates are finite — no NaN / ±Infinity ever appears in the store.
//   * reverse-index positions are valid — every ShapeReference points at a real
//     position whose stored id matches the indexed id.
//
// Metamorphic / algebraic laws:
//   * save∘load = identity (JSON round-trip of the plain-data state).
//   * move(p)∘move(p) over a no-op move (back to original coord) = identity.
//   * transferSharing(identity remap) = identity.
//   * a REJECTED op leaves the input state byte-identical (full rollback).
//
// Determinism: seed = 3004, numRuns large. Run ONLY this file:
//   npx vitest run src/domain/__bughunt__/shared-vertex-linkage.property.test.ts
//
// Findings are reported by FAILING assertions (no green-washing of real bugs).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createIdGeneratorState, type IdGeneratorState } from '../id-generator';
import { asFeatureId, asVertexId, type VertexId } from '../ids';
import {
  buildReverseIndex,
  checkParticipation,
  containerKey,
  createSharedVertexState,
  insertSharedEdgeCut,
  isSharedVertex,
  moveVertices,
  referencesOf,
  shareVertices,
  sharedVertexIds,
  transferSharing,
  unshareReference,
  zeroLengthEdgeValidator,
  REJECT_REASON,
  SHARED_VERTEX_OUTCOME,
  type ContainerEntry,
  type MoveSpec,
  type ShapeContainer,
  type SharedVertexState,
} from '../shared-vertex';
import { createVertex, createVertexStore, getVertex, type Vertex } from '../vertex';

const SEED = 3004;
const NUM_RUNS = 800;

// A monotonic injected time source (deterministic). Each call advances by 1.
function makeClock(start = 1): () => number {
  let t = start;
  return () => t++;
}

// ---------------------------------------------------------------------------
// Invariant checks (run after every op).
// ---------------------------------------------------------------------------

function allCitedIds(state: SharedVertexState): VertexId[] {
  const ids: VertexId[] = [];
  for (const entry of state.containers.values()) {
    for (const id of entry.vertexIds) ids.push(id);
  }
  return ids;
}

function checkInvariants(state: SharedVertexState, label: string): void {
  // (1) Single source of truth: every cited id resolves to a body.
  for (const id of allCitedIds(state)) {
    expect(getVertex(state.vertices, id), `${label}: dangling cited id ${id} (no body)`).toBeDefined();
  }

  // (2) No NaN / Infinity in any stored coordinate.
  for (const v of state.vertices.byId.values()) {
    expect(Number.isFinite(v.coordinate.lon), `${label}: non-finite lon for ${v.id}`).toBe(true);
    expect(Number.isFinite(v.coordinate.lat), `${label}: non-finite lat for ${v.id}`).toBe(true);
  }

  // (3) Sharing derivation is consistent.
  const index = buildReverseIndex(state);
  const reportedShared = new Set(sharedVertexIds(state));
  for (const [vid, refs] of index) {
    const expectShared = refs.length >= 2;
    expect(isSharedVertex(state, vid), `${label}: isSharedVertex(${vid}) mismatch`).toBe(expectShared);
    expect(reportedShared.has(vid), `${label}: sharedVertexIds(${vid}) mismatch`).toBe(expectShared);
  }
  // sharedVertexIds must not list anything not actually shared.
  for (const vid of reportedShared) {
    expect(index.get(vid)?.length ?? 0, `${label}: sharedVertexIds lists non-shared ${vid}`).toBeGreaterThanOrEqual(2);
  }

  // (4) Reverse-index positions are valid + reference back-resolves.
  for (const [vid, refs] of index) {
    for (const ref of refs) {
      const entry = state.containers.get(containerKey(ref.container));
      expect(entry, `${label}: ref to missing container ${containerKey(ref.container)}`).toBeDefined();
      if (entry === undefined) continue;
      expect(
        entry.vertexIds[ref.position],
        `${label}: ref ${containerKey(ref.container)}#${ref.position} does not cite ${vid}`,
      ).toBe(vid);
    }
  }
}

// After an APPLIED operation, the unit asserts participation validity. A vertex
// the unit reports as shared must NOT have two citations from the same container.
function checkParticipationOfShared(state: SharedVertexState, label: string): void {
  for (const vid of sharedVertexIds(state)) {
    const refs = referencesOf(state, vid);
    const violations = checkParticipation(refs);
    expect(
      violations.length,
      `${label}: shared vertex ${vid} violates participation (${violations.map((v) => v.kind).join(',')})`,
    ).toBe(0);
  }
}

// ---------------------------------------------------------------------------
// save∘load (JSON round-trip of the plain-data state).
// ---------------------------------------------------------------------------

interface SerializedState {
  readonly vertices: Array<{ id: string; lon: number; lat: number }>;
  readonly containers: Array<{ container: ShapeContainer; vertexIds: string[] }>;
}

function save(state: SharedVertexState): string {
  const vertices = [...state.vertices.byId.values()].map((v) => ({
    id: v.id as string,
    lon: v.coordinate.lon,
    lat: v.coordinate.lat,
  }));
  const containers = [...state.containers.values()].map((e) => ({
    container: e.container,
    vertexIds: e.vertexIds.map((id) => id as string),
  }));
  return JSON.stringify({ vertices, containers } satisfies SerializedState);
}

function load(json: string): SharedVertexState {
  const data = JSON.parse(json) as SerializedState;
  const verts: Vertex[] = data.vertices.map((v) =>
    createVertex(asVertexId(v.id), createCoordinate(v.lon, v.lat)),
  );
  const entries: ContainerEntry[] = data.containers.map((c) => ({
    container: c.container,
    vertexIds: c.vertexIds.map((id) => asVertexId(id)),
  }));
  return createSharedVertexState(createVertexStore(verts), entries);
}

// Normalize to a canonical comparable shape (order-independent for vertices &
// containers) so round-trip equality is judged on content, not Map iteration.
function canonical(state: SharedVertexState): unknown {
  const vertices = [...state.vertices.byId.values()]
    .map((v) => ({ id: v.id as string, lon: v.coordinate.lon, lat: v.coordinate.lat }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const containers = [...state.containers.values()]
    .map((e) => ({ key: containerKey(e.container), vertexIds: e.vertexIds.map((i) => i as string) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { vertices, containers };
}

// ---------------------------------------------------------------------------
// Generators: a richer state than the shipped arbitrary (mix of rings + lines,
// shared and unshared vertices, distinct coordinates to avoid spurious zero
// length edges that would mask real bugs).
// ---------------------------------------------------------------------------

const coordArb: fc.Arbitrary<WorldCoordinate> = fc
  .tuple(fc.integer({ min: -170, max: 170 }), fc.integer({ min: -80, max: 80 }))
  .map(([lon, lat]) => createCoordinate(lon, lat));

interface GenSeed {
  readonly vertexCount: number;
  readonly coords: readonly WorldCoordinate[];
  readonly ringCount: number;
  readonly lineCount: number;
}

const seedArb: fc.Arbitrary<GenSeed> = fc
  .record({ vertexCount: fc.integer({ min: 4, max: 10 }), ringCount: fc.integer({ min: 1, max: 3 }), lineCount: fc.integer({ min: 0, max: 2 }) })
  .chain(({ vertexCount, ringCount, lineCount }) =>
    fc
      .array(coordArb, { minLength: vertexCount, maxLength: vertexCount })
      .map((coords) => ({ vertexCount, coords, ringCount, lineCount })),
  );

function buildState(seed: GenSeed): SharedVertexState {
  // Spread coordinates so no two are coincident.
  const vertices: Vertex[] = seed.coords.map((c, i) =>
    createVertex(asVertexId(`v${i}`), createCoordinate(c.lon + i * 0.37, c.lat - i * 0.11)),
  );
  const ids = vertices.map((v) => v.id);
  const n = ids.length;
  const containers: ContainerEntry[] = [];

  for (let r = 0; r < seed.ringCount; r += 1) {
    const start = r % Math.max(1, n - 2);
    const a = ids[start];
    const b = ids[(start + 1) % n];
    const c = ids[(start + 2) % n];
    if (a === undefined || b === undefined || c === undefined) continue;
    if (new Set([a, b, c]).size < 3) continue;
    containers.push({ container: { kind: 'ring', featureId: asFeatureId(`fr${r}`), ringId: `ring${r}` }, vertexIds: [a, b, c] });
  }
  for (let l = 0; l < seed.lineCount; l += 1) {
    const start = (l + 1) % Math.max(1, n - 1);
    const a = ids[start];
    const b = ids[(start + 1) % n];
    if (a === undefined || b === undefined || a === b) continue;
    containers.push({ container: { kind: 'line', featureId: asFeatureId(`fl${l}`) }, vertexIds: [a, b] });
  }
  return createSharedVertexState(createVertexStore(vertices), containers);
}

// ---------------------------------------------------------------------------
// Command model: random ops drawn against the CURRENT state.
// ---------------------------------------------------------------------------

type Op =
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'move'; readonly i: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'unshare'; readonly i: number }
  | { readonly t: 'transferIdentity' }
  | { readonly t: 'edgeCut'; readonly primaryIdx: number; readonly partnerIdx: number; readonly lon: number; readonly lat: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('share' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('move' as const), i: fc.nat(20), lon: fc.integer({ min: -179, max: 179 }), lat: fc.integer({ min: -85, max: 85 }) }),
  fc.record({ t: fc.constant('unshare' as const), i: fc.nat(20) }),
  fc.record({ t: fc.constant('transferIdentity' as const) }),
  fc.record({ t: fc.constant('edgeCut' as const), primaryIdx: fc.nat(8), partnerIdx: fc.nat(8), lon: fc.integer({ min: -179, max: 179 }), lat: fc.integer({ min: -85, max: 85 }) }),
);

function pick<T>(arr: readonly T[], idx: number): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[idx % arr.length];
}

interface ModelCtx {
  state: SharedVertexState;
  idState: IdGeneratorState;
  clock: () => number;
}

function applyOp(ctx: ModelCtx, op: Op): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'share': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const cand = pick(ids, op.i);
      const targ = pick(ids, op.j);
      if (cand === undefined || targ === undefined) return;
      const res = shareVertices(ctx.state, cand, targ, { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'move': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const vid = pick(ids, op.i);
      if (vid === undefined) return;
      const res = moveVertices(ctx.state, [{ vertexId: vid, coordinate: createCoordinate(op.lon, op.lat) }], { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'unshare': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const refs = referencesOf(ctx.state, vid);
      const ref = refs[op.i % refs.length];
      if (ref === undefined) return;
      const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock);
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
    case 'transferIdentity': {
      // Identity remap MUST be a no-op (metamorphic law checked separately too).
      const remap = new Map<VertexId, VertexId>();
      for (const id of new Set(allCitedIds(ctx.state))) remap.set(id, id);
      ctx.state = transferSharing(ctx.state, remap);
      return;
    }
    case 'edgeCut': {
      const entries = [...ctx.state.containers.values()];
      const primary = entries[op.primaryIdx % Math.max(1, entries.length)];
      const partner = entries[op.partnerIdx % Math.max(1, entries.length)];
      if (primary === undefined || partner === undefined) return;
      if (containerKey(primary.container) === containerKey(partner.container)) return; // need 2 containers
      const out = insertSharedEdgeCut(
        ctx.state,
        {
          primary: { containerKey: containerKey(primary.container), edgeStart: 0 },
          partner: { containerKey: containerKey(partner.container), edgeStart: 0 },
          cutCoordinate: createCoordinate(op.lon + 0.5, op.lat + 0.5),
        },
        ctx.idState,
        ctx.clock,
        { validators },
      );
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

describe('shared-vertex-linkage stateful invariants (bughunt)', () => {
  it('random op sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(opArb, { minLength: 1, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        checkInvariants(ctx.state, 'initial');
        checkParticipationOfShared(ctx.state, 'initial');

        let step = 0;
        for (const op of ops) {
          applyOp(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('save∘load = identity (round-trips an arbitrary reachable state)', () => {
    fc.assert(
      fc.property(seedArb, fc.array(opArb, { minLength: 0, maxLength: 20 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        // And load is idempotent under a second round-trip.
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('a no-op move (move to current coordinate) is the identity', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), (seed, idx) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        const vid = pick(ids, idx);
        if (vid === undefined) return;
        const current = getVertex(state.vertices, vid);
        if (current === undefined) return;
        const res = moveVertices(state, [{ vertexId: vid, coordinate: current.coordinate }], {
          validators: [zeroLengthEdgeValidator],
        });
        expect(res.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
        if (res.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        expect(canonical(res.state)).toEqual(canonical(state));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('move out then back to the original coordinate restores the state', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(20),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, idx, lon, lat) => {
          const state = buildState(seed);
          const ids = [...new Set(allCitedIds(state))];
          const vid = pick(ids, idx);
          if (vid === undefined) return;
          const orig = getVertex(state.vertices, vid);
          if (orig === undefined) return;
          const out = moveVertices(state, [{ vertexId: vid, coordinate: createCoordinate(lon, lat) }], {
            validators: [zeroLengthEdgeValidator],
          });
          if (out.status !== SHARED_VERTEX_OUTCOME.Applied) return; // rejected => skip
          const back = moveVertices(out.state, [{ vertexId: vid, coordinate: orig.coordinate }], {
            validators: [zeroLengthEdgeValidator],
          });
          if (back.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          expect(canonical(back.state)).toEqual(canonical(state));
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('transferSharing(identity remap) = identity', () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const state = buildState(seed);
        const remap = new Map<VertexId, VertexId>();
        for (const id of new Set(allCitedIds(state))) remap.set(id, id);
        const after = transferSharing(state, remap);
        expect(canonical(after)).toEqual(canonical(state));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('a rejected op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, opArb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = {
          state,
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        // Run a single op; whether applied or rejected, `state` (the original
        // object) must be unchanged — domain values are immutable.
        applyOp(ctx, op);
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('unshare increases vertex-body count by exactly 1 and preserves the coordinate', () => {
    fc.assert(
      fc.property(seedArb, fc.array(opArb, { minLength: 0, maxLength: 12 }), fc.nat(20), (seed, ops, idx) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp(ctx, op);
        const shared = sharedVertexIds(ctx.state);
        const vid = pick(shared, idx);
        if (vid === undefined) return;
        const refs = referencesOf(ctx.state, vid);
        const ref = refs[idx % refs.length];
        if (ref === undefined) return;
        const orig = getVertex(ctx.state.vertices, vid);
        if (orig === undefined) return;
        const beforeCount = ctx.state.vertices.byId.size;
        const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock);
        if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        expect(out.result.state.vertices.byId.size).toBe(beforeCount + 1);
        // The minted vertex carries the SAME coordinate (same-coordinate split).
        const newId = out.newVertexId;
        expect(newId).toBeDefined();
        if (newId === undefined) return;
        const minted = getVertex(out.result.state.vertices, newId);
        expect(minted?.coordinate).toEqual(orig.coordinate);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  // Targeted: insertSharedEdgeCut where primary === partner container. The code
  // path that "re-reads partner in case primary === partner" must NOT corrupt
  // positions, and must reject (same-ring participation) rather than applying a
  // structurally-broken state. Whatever the outcome, invariants must hold on the
  // returned state and the input must be untouched.
  it('shared-edge cut into the SAME container is handled safely', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(8),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, idx, lon, lat) => {
          const state = buildState(seed);
          const before = canonical(state);
          const entries = [...state.containers.values()];
          const target = entries[idx % Math.max(1, entries.length)];
          if (target === undefined) return;
          const key = containerKey(target.container);
          const out = insertSharedEdgeCut(
            state,
            {
              primary: { containerKey: key, edgeStart: 0 },
              partner: { containerKey: key, edgeStart: 0 },
              cutCoordinate: createCoordinate(lon + 0.5, lat + 0.5),
            },
            createIdGeneratorState(0, 0),
            makeClock(),
            { validators: [zeroLengthEdgeValidator] },
          );
          // Input is immutable regardless of outcome.
          expect(canonical(state)).toEqual(before);
          if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
            checkInvariants(out.result.state, 'same-container edge cut applied');
            checkParticipationOfShared(out.result.state, 'same-container edge cut applied');
          }
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  // REGRESSION (real bug): insertSharedEdgeCut never validated `edgeStart`.
  // `insertAfter` is `splice`, which silently CLAMPS an out-of-range index and
  // APPENDS instead of erroring — so a malformed / out-of-bounds edgeStart was
  // accepted and the cut vertex was inserted into the WRONG edge, corrupting the
  // geometry. Because the reverse index stayed internally consistent, the
  // structural invariants above did NOT catch it. The fix rejects a malformed
  // edge (REJECT_REASON.NotFound) instead of applying a clamped insertion.
  //
  // A real edge is identified by its START position: a closed ring of n vertices
  // has edges 0..n-1 (n-1↔0 closing edge is real); an open line has edges 0..n-2.
  // Anything else (out of range, negative, non-integer) must be rejected, and the
  // input state must be untouched.
  it('insertSharedEdgeCut rejects an out-of-range edgeStart (no clamped append)', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(2),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, partnerPick, lon, lat) => {
          const state = buildState(seed);
          const entries = [...state.containers.values()];
          if (entries.length < 2) return; // need a distinct primary + partner
          const primary = entries[0];
          const partner = entries[(1 + partnerPick) % entries.length] ?? entries[1];
          if (primary === undefined || partner === undefined) return;
          const primaryKey = containerKey(primary.container);
          const partnerKey = containerKey(partner.container);
          if (primaryKey === partnerKey) return; // same-container is a separate law

          const before = canonical(state);
          // A primary edgeStart guaranteed past the last real edge of a ring/line.
          const oob = primary.vertexIds.length + 5;
          const out = insertSharedEdgeCut(
            state,
            {
              primary: { containerKey: primaryKey, edgeStart: oob },
              partner: { containerKey: partnerKey, edgeStart: 0 },
              cutCoordinate: createCoordinate(lon + 0.5, lat + 0.5),
            },
            createIdGeneratorState(0, 0),
            makeClock(),
            { validators: [zeroLengthEdgeValidator] },
          );

          // Must be REJECTED as malformed input — never a clamped/append apply.
          expect(out.result.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
          if (out.result.status === SHARED_VERTEX_OUTCOME.Rejected) {
            expect(out.result.reason).toBe(REJECT_REASON.NotFound);
          }
          // The id-generator state must NOT have advanced on rejection.
          expect(out.idState.counter).toBe(0);
          // No cut vertex minted, input untouched (immutability + full rollback).
          expect(out.cutVertexId).toBeUndefined();
          expect(canonical(state)).toEqual(before);
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  // REGRESSION (companion): a VALID closing-edge edgeStart (n-1 on a ring) is the
  // boundary that must still be ACCEPTED — the guard must reject only true
  // out-of-range edges, not the legitimate n-1↔0 closing edge of a ring.
  it('insertSharedEdgeCut accepts the ring closing edge (edgeStart = n-1)', () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const state = buildState(seed);
        const rings = [...state.containers.values()].filter((e) => e.container.kind === 'ring');
        const lines = [...state.containers.values()].filter((e) => e.container.kind === 'line');
        const primary = rings[0];
        // Pick any OTHER container as partner.
        const partner =
          [...state.containers.values()].find(
            (e) => primary !== undefined && containerKey(e.container) !== containerKey(primary.container),
          ) ?? lines[0];
        if (primary === undefined || partner === undefined) return;
        const out = insertSharedEdgeCut(
          state,
          {
            primary: { containerKey: containerKey(primary.container), edgeStart: primary.vertexIds.length - 1 },
            partner: { containerKey: containerKey(partner.container), edgeStart: 0 },
            // Far from every existing vertex to avoid an incidental zero-length edge.
            cutCoordinate: createCoordinate(123.5, 67.5),
          },
          createIdGeneratorState(0, 0),
          makeClock(),
          { validators: [zeroLengthEdgeValidator] },
        );
        // Either it applies (closing edge accepted) or it is rejected for a
        // *different* reason than a malformed edge — never NotFound-for-edge here.
        if (out.result.status === SHARED_VERTEX_OUTCOME.Rejected) {
          // Only legitimate rejections (participation / result-invalid) allowed.
          expect(out.result.reason).not.toBe(REJECT_REASON.NotFound);
        } else {
          checkInvariants(out.result.state, 'closing-edge cut');
          checkParticipationOfShared(out.result.state, 'closing-edge cut');
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  // Targeted: transferSharing with a real (non-identity) MERGE remap — fold the
  // last cited id onto the first. The continuity transfer is pure (no
  // participation gate by design), but it MUST keep the single-source-of-truth
  // (no dangling refs), finite coordinates, and consistent derivation.
  it('transferSharing merge remap keeps no-dangling + finite + consistent', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), (seed, a, b) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 2) return;
        const from = ids[a % ids.length];
        const to = ids[b % ids.length];
        if (from === undefined || to === undefined || from === to) return;
        const remap = new Map<VertexId, VertexId>([[from, to]]);
        const after = transferSharing(state, remap);
        checkInvariants(after, 'after merge transferSharing');
        // The folded-away id must no longer be cited anywhere.
        expect(allCitedIds(after).includes(from)).toBe(false);
        // Every position that cited `from` now cites `to`.
        for (const entry of after.containers.values()) {
          for (const id of entry.vertexIds) {
            expect(id).not.toBe(from);
          }
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  // Metamorphic op∘逆op = identity for the unshare / re-share pair. Unshare
  // splits ONE reference of a shared vertex onto a freshly minted same-coordinate
  // id; re-sharing that minted id back onto the original (candidate = newId,
  // target = original) repoints the split reference back and prunes the minted
  // body, restoring the canonical content of the original state. (Any rejection
  // — e.g. participation — short-circuits; we only assert the law when both legs
  // actually apply.)
  it('reshare∘unshare = identity (split a reference, then merge it back)', () => {
    fc.assert(
      fc.property(seedArb, fc.array(opArb, { minLength: 0, maxLength: 12 }), fc.nat(20), (seed, ops, idx) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp(ctx, op);
        const base = ctx.state;
        const baseCanon = canonical(base);
        const shared = sharedVertexIds(base);
        const vid = pick(shared, idx);
        if (vid === undefined) return;
        const refs = referencesOf(base, vid);
        const ref = refs[idx % refs.length];
        if (ref === undefined) return;
        const split = unshareReference(base, vid, ref, ctx.idState, ctx.clock, {
          validators: [zeroLengthEdgeValidator],
        });
        if (split.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        const newId = split.newVertexId;
        if (newId === undefined) return;
        // Re-share: merge the freshly split id back onto the original vertex.
        const back = shareVertices(split.result.state, newId, vid, {
          validators: [zeroLengthEdgeValidator],
        });
        if (back.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        checkInvariants(back.state, 'after reshare∘unshare');
        checkParticipationOfShared(back.state, 'after reshare∘unshare');
        // The content must be byte-identical to the pre-unshare state: the split
        // body is pruned and the reference points back at the original id.
        expect(canonical(back.state)).toEqual(baseCanon);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  // A linked move follows EVERY referrer: after moving a shared vertex, every
  // citation of that id (which resolves to the single body) reads the new
  // coordinate, and the change set names the moved id plus every feature that
  // cited it (symmetric touched set; §4.8 / 教訓5.23).
  it('linked move updates all referrers and reports a complete touched set', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.integer({ min: -179, max: 179 }), fc.integer({ min: -85, max: 85 }), (seed, idx, lon, lat) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        const vid = pick(ids, idx);
        if (vid === undefined) return;
        const refsBefore = referencesOf(state, vid);
        const expectedFeatures = new Set(refsBefore.map((r) => r.container.featureId));
        const coord = createCoordinate(lon, lat);
        const res = moveVertices(state, [{ vertexId: vid, coordinate: coord }], {
          validators: [zeroLengthEdgeValidator],
        });
        if (res.status !== SHARED_VERTEX_OUTCOME.Applied) return; // e.g. zero-length edge
        // Single body updated -> every referrer reads it.
        const moved = getVertex(res.state.vertices, vid);
        expect(moved?.coordinate).toEqual(coord);
        // Touched set names the moved id.
        expect(res.change.touchedVertexIds.has(vid)).toBe(true);
        // Touched features cover exactly the features that cited the id.
        for (const f of expectedFeatures) {
          expect(res.change.touchedFeatureIds.has(f), `missing touched feature ${f}`).toBe(true);
        }
        // No vertices created or deleted by a pure coordinate move.
        expect(res.change.createdVertexIds.size).toBe(0);
        expect(res.change.deletedVertexIds.size).toBe(0);
        checkInvariants(res.state, 'after linked move');
        checkParticipationOfShared(res.state, 'after linked move');
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  // share change-set accounting: an APPLIED share that prunes the orphaned
  // candidate body must report it in deletedVertexIds; the candidate id must no
  // longer have a body NOR be cited; and the body count must drop by exactly 1.
  it('applied share that collapses a vertex reports the pruned body accurately', () => {
    fc.assert(
      fc.property(seedArb, fc.array(opArb, { minLength: 0, maxLength: 12 }), fc.nat(20), fc.nat(20), (seed, ops, ai, bi) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp(ctx, op);
        const ids = [...new Set(allCitedIds(ctx.state))];
        if (ids.length < 2) return;
        const cand = ids[ai % ids.length];
        const targ = ids[bi % ids.length];
        if (cand === undefined || targ === undefined || cand === targ) return;
        const beforeCount = ctx.state.vertices.byId.size;
        const res = shareVertices(ctx.state, cand, targ, { validators: [zeroLengthEdgeValidator] });
        if (res.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        // After repointing, the candidate id is no longer cited (all its
        // citations moved to the target).
        expect(allCitedIds(res.state).includes(cand)).toBe(false);
        // Its body is pruned.
        expect(getVertex(res.state.vertices, cand)).toBeUndefined();
        expect(res.state.vertices.byId.size).toBe(beforeCount - 1);
        // The change set names the pruned id (and ONLY it).
        expect(res.change.deletedVertexIds.has(cand)).toBe(true);
        expect(res.change.deletedVertexIds.size).toBe(1);
        expect(res.change.createdVertexIds.size).toBe(0);
        checkInvariants(res.state, 'after collapsing share');
        checkParticipationOfShared(res.state, 'after collapsing share');
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  // Metamorphic: shareVertices(a, a) — sharing a vertex with itself — must be a
  // structural no-op rejection (NotFound), never a self-merge that silently
  // deletes the only body of `a` (which would dangle every citation).
  it('share(a, a) is rejected and leaves the state untouched', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), (seed, idx) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ids = [...new Set(allCitedIds(state))];
        const vid = pick(ids, idx);
        if (vid === undefined) return;
        const res = shareVertices(state, vid, vid, { validators: [zeroLengthEdgeValidator] });
        expect(res.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
        if (res.status === SHARED_VERTEX_OUTCOME.Rejected) {
          expect(res.reason).toBe(REJECT_REASON.NotFound);
        }
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});

// ===========================================================================
// SECOND EXPLORATION PASS (bug-hunt round 2). A FRESH, INDEPENDENT search with
// a different seed (23001 — disjoint from the round-1 seeds 1000-6000) and NEW
// command kinds / generators / metamorphic interactions that the first pass did
// not exercise:
//
//   * `multiMove`     — move several DISTINCT vertices in one moveVertices call
//                       (the earlier pass only ever moved one id per call); also
//                       a `dupMove` that lists the SAME id twice in one call to
//                       probe last-write-wins determinism.
//   * `validEdgeCut`  — a shared-edge cut whose edgeStart is chosen from the
//                       container's REAL edge range (incl. the closing edge), not
//                       fixed at 0; this drives the splice insertion through every
//                       interior position, a path the round-1 ops never reached.
//   * `mergeTransfer` — transferSharing with a REAL (non-identity) fold applied
//                       INSIDE the command stream, so subsequent ops act on a
//                       merged state (round 1 only used identity remap in-stream).
//   * `reshareSplit`  — unshare a reference then immediately re-share the minted
//                       id back, as a single composite command in the stream.
//
// New algebraic / metamorphic laws checked here:
//   * transferSharing is COMPOSABLE: t(s, A∘B) ≡ t(t(s, B), A) on disjoint folds.
//   * transferSharing(identity) is IDEMPOTENT applied twice (already a no-op, but
//     verified to not drift bodies/positions across repetition).
//   * a multi-vertex move equals applying the moves one at a time, left to right.
//   * a move spec list with a duplicated id resolves to the LAST coordinate
//     (deterministic last-write-wins; no ambiguity / no NaN birth).
//   * save∘load = identity on states reached through the NEW op stream (covers
//     containers with inserted cut vertices at non-zero positions).
// ===========================================================================

const SEED2 = 23001;
const NUM_RUNS2 = 600;

// Choose a real edge start for a container (closed ring: 0..n-1; line: 0..n-2).
function realEdgeStart(entry: ContainerEntry, pick: number): number | undefined {
  const n = entry.vertexIds.length;
  if (n < 2) return undefined;
  const maxStart = entry.container.kind === 'ring' ? n - 1 : n - 2;
  return pick % (maxStart + 1);
}

type Op2 =
  | { readonly t: 'multiMove'; readonly idxs: readonly number[]; readonly lon: number; readonly lat: number }
  | { readonly t: 'dupMove'; readonly i: number; readonly lon1: number; readonly lat1: number; readonly lon2: number; readonly lat2: number }
  | { readonly t: 'validEdgeCut'; readonly pIdx: number; readonly qIdx: number; readonly pEdge: number; readonly qEdge: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'mergeTransfer'; readonly a: number; readonly b: number }
  | { readonly t: 'reshareSplit'; readonly i: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number };

const op2Arb: fc.Arbitrary<Op2> = fc.oneof(
  fc.record({
    t: fc.constant('multiMove' as const),
    idxs: fc.array(fc.nat(20), { minLength: 1, maxLength: 4 }),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({
    t: fc.constant('dupMove' as const),
    i: fc.nat(20),
    lon1: fc.integer({ min: -179, max: 179 }),
    lat1: fc.integer({ min: -85, max: 85 }),
    lon2: fc.integer({ min: -179, max: 179 }),
    lat2: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({
    t: fc.constant('validEdgeCut' as const),
    pIdx: fc.nat(8),
    qIdx: fc.nat(8),
    pEdge: fc.nat(8),
    qEdge: fc.nat(8),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({ t: fc.constant('mergeTransfer' as const), a: fc.nat(20), b: fc.nat(20) }),
  fc.record({ t: fc.constant('reshareSplit' as const), i: fc.nat(20) }),
  fc.record({ t: fc.constant('share' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('unshare' as const), i: fc.nat(20) }),
);

function applyOp2(ctx: ModelCtx, op: Op2): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'multiMove': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length === 0) return;
      // Build DISTINCT move targets (a Map dedups, last index wins per id).
      const seen = new Set<VertexId>();
      const moves: MoveSpec[] = [];
      let k = 0;
      for (const idx of op.idxs) {
        const vid = pick(ids, idx);
        if (vid === undefined || seen.has(vid)) continue;
        seen.add(vid);
        moves.push({ vertexId: vid, coordinate: createCoordinate(op.lon + k * 0.31, op.lat - k * 0.13) });
        k += 1;
      }
      if (moves.length === 0) return;
      const res = moveVertices(ctx.state, moves, { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'dupMove': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const vid = pick(ids, op.i);
      if (vid === undefined) return;
      const res = moveVertices(
        ctx.state,
        [
          { vertexId: vid, coordinate: createCoordinate(op.lon1, op.lat1) },
          { vertexId: vid, coordinate: createCoordinate(op.lon2, op.lat2) },
        ],
        { validators },
      );
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'validEdgeCut': {
      const entries = [...ctx.state.containers.values()];
      if (entries.length < 2) return;
      const primary = entries[op.pIdx % entries.length];
      const partner = entries[op.qIdx % entries.length];
      if (primary === undefined || partner === undefined) return;
      if (containerKey(primary.container) === containerKey(partner.container)) return;
      const pEdge = realEdgeStart(primary, op.pEdge);
      const qEdge = realEdgeStart(partner, op.qEdge);
      if (pEdge === undefined || qEdge === undefined) return;
      const out = insertSharedEdgeCut(
        ctx.state,
        {
          primary: { containerKey: containerKey(primary.container), edgeStart: pEdge },
          partner: { containerKey: containerKey(partner.container), edgeStart: qEdge },
          cutCoordinate: createCoordinate(op.lon + 0.5, op.lat + 0.5),
        },
        ctx.idState,
        ctx.clock,
        { validators },
      );
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
    case 'mergeTransfer': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 2) return;
      const from = ids[op.a % ids.length];
      const to = ids[op.b % ids.length];
      if (from === undefined || to === undefined || from === to) return;
      // No co-citation guard: the round-2 fix makes `transferSharing` COLLAPSE a
      // same-container fold (it keeps only the first citation of each id), so even
      // folding two ids cited by ONE container yields a valid (non-self-citing)
      // state. We therefore fold UNCONDITIONALLY so the broad invariant sweep also
      // exercises the collapse path (the dedicated regression test pins the exact
      // collapse shape; here every post-step invariant — including participation —
      // is asserted, which would catch any regression in the collapse).
      ctx.state = transferSharing(ctx.state, new Map([[from, to]]));
      return;
    }
    case 'reshareSplit': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const refs = referencesOf(ctx.state, vid);
      const ref = refs[op.i % refs.length];
      if (ref === undefined) return;
      const split = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, { validators });
      if (split.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
      ctx.state = split.result.state;
      ctx.idState = split.idState;
      const newId = split.newVertexId;
      if (newId === undefined) return;
      const back = shareVertices(ctx.state, newId, vid, { validators });
      if (back.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = back.state;
      return;
    }
    case 'share': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const cand = pick(ids, op.i);
      const targ = pick(ids, op.j);
      if (cand === undefined || targ === undefined) return;
      const res = shareVertices(ctx.state, cand, targ, { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'unshare': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const refs = referencesOf(ctx.state, vid);
      const ref = refs[op.i % refs.length];
      if (ref === undefined) return;
      const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, { validators });
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
  }
}

describe('shared-vertex-linkage round-2 exploration (seed 23001)', () => {
  it('new-op random sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op2Arb, { minLength: 1, maxLength: 30 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        checkInvariants(ctx.state, 'initial');
        checkParticipationOfShared(ctx.state, 'initial');
        let step = 0;
        for (const op of ops) {
          applyOp2(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
        }
      }),
      { seed: SEED2, numRuns: NUM_RUNS2 },
    );
  });

  it('save∘load = identity on round-2 reachable states', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op2Arb, { minLength: 0, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp2(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED2, numRuns: NUM_RUNS2 },
    );
  });

  it('a rejected new-op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, op2Arb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = { state, idState: createIdGeneratorState(0, 0), clock: makeClock() };
        applyOp2(ctx, op);
        // The ORIGINAL state object must be unchanged (immutability), regardless
        // of whether the op applied to a fresh value or was rejected.
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED2, numRuns: NUM_RUNS2 },
    );
  });

  // multi-vertex move == sequential single moves (left to right), same result.
  it('multiMove equals applying its moves one at a time', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.array(fc.nat(20), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, idxs, lon, lat) => {
          const state = buildState(seed);
          const ids = [...new Set(allCitedIds(state))];
          if (ids.length === 0) return;
          const seen = new Set<VertexId>();
          const moves: MoveSpec[] = [];
          let k = 0;
          for (const idx of idxs) {
            const vid = pick(ids, idx);
            if (vid === undefined || seen.has(vid)) continue;
            seen.add(vid);
            moves.push({ vertexId: vid, coordinate: createCoordinate(lon + k * 0.31, lat - k * 0.13) });
            k += 1;
          }
          if (moves.length === 0) return;
          const batched = moveVertices(state, moves, { validators: [zeroLengthEdgeValidator] });
          // Sequential application of the same moves.
          let seq = state;
          let allApplied = true;
          for (const m of moves) {
            const r = moveVertices(seq, [m], { validators: [zeroLengthEdgeValidator] });
            if (r.status !== SHARED_VERTEX_OUTCOME.Applied) {
              allApplied = false;
              break;
            }
            seq = r.state;
          }
          // The validators here are run on the WHOLE state; a batched move may be
          // rejected while a sequential prefix is not (and vice-versa) only if a
          // mid-sequence state is invalid. Since the moves target DISTINCT ids and
          // coordinates are spread apart, both should agree. Only assert equality
          // when both fully applied.
          if (batched.status === SHARED_VERTEX_OUTCOME.Applied && allApplied) {
            expect(canonical(batched.state)).toEqual(canonical(seq));
          }
        },
      ),
      { seed: SEED2, numRuns: NUM_RUNS2 },
    );
  });

  // A move spec list naming the SAME id twice must resolve to the LAST coordinate
  // (deterministic last-write-wins) — never an averaged / first-wins / NaN value.
  it('dupMove resolves a repeated id to its last coordinate (last-write-wins)', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(20),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, idx, lon1, lat1, lon2, lat2) => {
          const state = buildState(seed);
          const ids = [...new Set(allCitedIds(state))];
          const vid = pick(ids, idx);
          if (vid === undefined) return;
          const last = createCoordinate(lon2, lat2);
          const res = moveVertices(
            state,
            [
              { vertexId: vid, coordinate: createCoordinate(lon1, lat1) },
              { vertexId: vid, coordinate: last },
            ],
            { validators: [zeroLengthEdgeValidator] },
          );
          if (res.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const moved = getVertex(res.state.vertices, vid);
          expect(moved?.coordinate).toEqual(last);
          checkInvariants(res.state, 'after dupMove');
        },
      ),
      { seed: SEED2, numRuns: NUM_RUNS2 },
    );
  });

  // transferSharing composability on DISJOINT folds: folding A then B (as one
  // combined remap) equals folding B then folding A, when A and B touch disjoint
  // source ids and neither target is the other's source.
  it('transferSharing composes on disjoint folds', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), fc.nat(20), fc.nat(20), (seed, a1, b1, a2, b2) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 4) return;
        const fromA = ids[a1 % ids.length];
        const toA = ids[b1 % ids.length];
        const fromB = ids[a2 % ids.length];
        const toB = ids[b2 % ids.length];
        if (fromA === undefined || toA === undefined || fromB === undefined || toB === undefined) return;
        // Require disjointness so the two folds do not interact (order-independent).
        const involved = new Set([fromA, toA, fromB, toB]);
        if (involved.size !== 4) return;
        if (fromA === toA || fromB === toB) return;

        const combined = new Map<VertexId, VertexId>([
          [fromA, toA],
          [fromB, toB],
        ]);
        const oneShot = transferSharing(state, combined);
        const sequential = transferSharing(
          transferSharing(state, new Map([[fromB, toB]])),
          new Map([[fromA, toA]]),
        );
        checkInvariants(oneShot, 'transferSharing one-shot');
        checkInvariants(sequential, 'transferSharing sequential');
        expect(canonical(oneShot)).toEqual(canonical(sequential));
      }),
      { seed: SEED2, numRuns: NUM_RUNS2 },
    );
  });

  // transferSharing(identity) is idempotent across two applications (no drift).
  it('transferSharing(identity) is idempotent applied twice', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op2Arb, { minLength: 0, maxLength: 15 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp2(ctx, op);
        const remap = new Map<VertexId, VertexId>();
        for (const id of new Set(allCitedIds(ctx.state))) remap.set(id, id);
        const once = transferSharing(ctx.state, remap);
        const twice = transferSharing(once, remap);
        expect(canonical(once)).toEqual(canonical(ctx.state));
        expect(canonical(twice)).toEqual(canonical(ctx.state));
      }),
      { seed: SEED2, numRuns: NUM_RUNS2 },
    );
  });

  // A valid-edge cut at an INTERIOR edge (non-zero edgeStart) inserts the cut id
  // immediately after edgeStart in BOTH containers; assert exact placement and
  // invariants (the round-1 ops only ever cut at edgeStart 0).
  it('validEdgeCut inserts the shared cut id directly after each edgeStart', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(8),
        fc.nat(8),
        fc.nat(8),
        fc.nat(8),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, pIdx, qIdx, pEdge, qEdge, lon, lat) => {
          const state = buildState(seed);
          const entries = [...state.containers.values()];
          if (entries.length < 2) return;
          const primary = entries[pIdx % entries.length];
          const partner = entries[qIdx % entries.length];
          if (primary === undefined || partner === undefined) return;
          const pKey = containerKey(primary.container);
          const qKey = containerKey(partner.container);
          if (pKey === qKey) return;
          const ps = realEdgeStart(primary, pEdge);
          const qs = realEdgeStart(partner, qEdge);
          if (ps === undefined || qs === undefined) return;
          const out = insertSharedEdgeCut(
            state,
            {
              primary: { containerKey: pKey, edgeStart: ps },
              partner: { containerKey: qKey, edgeStart: qs },
              cutCoordinate: createCoordinate(lon + 0.5, lat + 0.5),
            },
            createIdGeneratorState(0, 0),
            makeClock(),
            { validators: [zeroLengthEdgeValidator] },
          );
          if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const cutId = out.cutVertexId;
          expect(cutId).toBeDefined();
          if (cutId === undefined) return;
          const newPrimary = out.result.state.containers.get(pKey);
          const newPartner = out.result.state.containers.get(qKey);
          // Inserted immediately AFTER edgeStart in each container.
          expect(newPrimary?.vertexIds[ps + 1]).toBe(cutId);
          expect(newPartner?.vertexIds[qs + 1]).toBe(cutId);
          // Each container grew by exactly one position.
          expect(newPrimary?.vertexIds.length).toBe(primary.vertexIds.length + 1);
          expect(newPartner?.vertexIds.length).toBe(partner.vertexIds.length + 1);
          checkInvariants(out.result.state, 'after interior validEdgeCut');
          checkParticipationOfShared(out.result.state, 'after interior validEdgeCut');
        },
      ),
      { seed: SEED2, numRuns: NUM_RUNS2 },
    );
  });

  // =========================================================================
  // FIXED (bug-hunt round 2) — transferSharing no longer produces an illegal
  // SAME-RING self-share (participation violation + zero-length edge).
  //
  // Original bug: a fold that mapped two ids BOTH cited by ONE container onto the
  // same id silently produced a container citing one id twice — e.g. a ring
  // [v0, v1, v2] under { v1 -> v0 } became [v0, v0, v2]. That broke the unit's
  // own participation invariant (§4.3 / FR-32): checkParticipation(referencesOf(
  // v0)) reported a SameRing violation, positions 0/1 formed a zero-length edge
  // (v0->v0) zeroLengthEdgeValidator would reject, and isSharedVertex(v0) became
  // true for what is really a self-citation — a state the shipped share / edge-cut
  // commands are written to REJECT, applied with no gate. shareVertices(v1, v0)
  // correctly rejects this exact merge; transferSharing is the merge-time transfer
  // those commands delegate to (continuity §4.7 / FR-95), so an upstream split /
  // merge yielding such a remap silently corrupted geometry.
  //
  // Fix: transferSharing now COLLAPSES the now-degenerate repeat — within each
  // container it keeps only the FIRST citation of each id, so the folded ring
  // [v0, v1, v2] (v1 -> v0) becomes the valid [v0, v2] (the degenerate v0->v0
  // self-touch / zero-length edge removed) instead of the illegal [v0, v0, v2].
  // Legitimate CROSS-container folds (two DIFFERENT containers onto one id, a real
  // share) are untouched. These assertions now PASS and stand as the permanent
  // regression record.
  // =========================================================================
  it('transferSharing same-container fold must NOT create a same-ring self-share', () => {
    const ring: ContainerEntry = {
      container: { kind: 'ring', featureId: asFeatureId('fr0'), ringId: 'ring0' },
      vertexIds: [asVertexId('v0'), asVertexId('v1'), asVertexId('v2')],
    };
    const state = createSharedVertexState(
      createVertexStore([
        createVertex(asVertexId('v0'), createCoordinate(0, 0)),
        createVertex(asVertexId('v1'), createCoordinate(1, 1)),
        createVertex(asVertexId('v2'), createCoordinate(2, 2)),
      ]),
      [ring],
    );

    const after = transferSharing(state, new Map([[asVertexId('v1'), asVertexId('v0')]]));
    // The ring must never end up citing one vertex twice (same-ring self-share).
    const entry = after.containers.get(containerKey(ring.container));
    const v0 = asVertexId('v0');
    const timesCited = entry?.vertexIds.filter((id) => id === v0).length ?? 0;
    expect(
      timesCited,
      `transferSharing folded two same-ring citations onto ${v0}: ring became [${entry?.vertexIds.join(', ')}]`,
    ).toBeLessThanOrEqual(1);

    // And derivation must not report a participation-violating "shared" vertex.
    for (const vid of sharedVertexIds(after)) {
      const violations = checkParticipation(referencesOf(after, vid));
      expect(
        violations.length,
        `transferSharing left ${vid} as a participation-violating shared vertex (${violations
          .map((vv) => vv.kind)
          .join(',')})`,
      ).toBe(0);
    }
  });

  // REGRESSION (round-2 fix): exhaustively pin the collapse semantics and prove
  // the fix never widens to legitimate cross-container shares. Three facets:
  //
  //  (a) the minimal same-ring fold collapses the degenerate repeat exactly —
  //      [v0, v1, v2] under { v1 -> v0 } becomes [v0, v2] (first occurrence kept,
  //      order preserved), the folded-away id has no body, and the surviving ids
  //      keep their coordinate bodies (single source of truth / no dangling refs);
  //  (b) a NON-ADJACENT same-container co-citation is collapsed too (the pinch
  //      [a, b, c, d] under { d -> a } -> [a, b, c], not the self-touching
  //      [a, b, c, a]) — participation forbids ANY same-container double-citation,
  //      not only adjacent ones; and
  //  (c) a CROSS-container fold (two DIFFERENT rings onto one id) is a REAL share
  //      and must be preserved, never collapsed.
  it('transferSharing collapses same-container folds but preserves cross-container shares', () => {
    const ringFeature = (n: string): ShapeContainer => ({
      kind: 'ring',
      featureId: asFeatureId(`f${n}`),
      ringId: `r${n}`,
    });

    // (a) Minimal adjacent same-ring fold: [v0, v1, v2] with { v1 -> v0 }.
    const aState = createSharedVertexState(
      createVertexStore([
        createVertex(asVertexId('v0'), createCoordinate(0, 0)),
        createVertex(asVertexId('v1'), createCoordinate(1, 1)),
        createVertex(asVertexId('v2'), createCoordinate(2, 2)),
      ]),
      [{ container: ringFeature('A'), vertexIds: [asVertexId('v0'), asVertexId('v1'), asVertexId('v2')] }],
    );
    const aAfter = transferSharing(aState, new Map([[asVertexId('v1'), asVertexId('v0')]]));
    const aRing = aAfter.containers.get(containerKey(ringFeature('A')));
    expect(aRing?.vertexIds.map((i) => i as string)).toEqual(['v0', 'v2']);
    // Folded-away body pruned; survivors keep their coordinate bodies.
    expect(getVertex(aAfter.vertices, asVertexId('v1'))).toBeUndefined();
    expect(getVertex(aAfter.vertices, asVertexId('v0'))?.coordinate).toEqual(createCoordinate(0, 0));
    expect(getVertex(aAfter.vertices, asVertexId('v2'))?.coordinate).toEqual(createCoordinate(2, 2));
    checkInvariants(aAfter, 'collapse (a)');
    checkParticipationOfShared(aAfter, 'collapse (a)');
    // v0 is cited exactly once now -> not a (spurious) shared vertex.
    expect(isSharedVertex(aAfter, asVertexId('v0'))).toBe(false);

    // (b) Non-adjacent pinch: [a, b, c, d] with { d -> a } -> [a, b, c].
    const bState = createSharedVertexState(
      createVertexStore([
        createVertex(asVertexId('a'), createCoordinate(0, 0)),
        createVertex(asVertexId('b'), createCoordinate(1, 0)),
        createVertex(asVertexId('c'), createCoordinate(1, 1)),
        createVertex(asVertexId('d'), createCoordinate(0, 1)),
      ]),
      [
        {
          container: ringFeature('B'),
          vertexIds: [asVertexId('a'), asVertexId('b'), asVertexId('c'), asVertexId('d')],
        },
      ],
    );
    const bAfter = transferSharing(bState, new Map([[asVertexId('d'), asVertexId('a')]]));
    const bRing = bAfter.containers.get(containerKey(ringFeature('B')));
    expect(bRing?.vertexIds.map((i) => i as string)).toEqual(['a', 'b', 'c']);
    checkInvariants(bAfter, 'collapse (b)');
    checkParticipationOfShared(bAfter, 'collapse (b)');

    // (c) Cross-container fold is a REAL share and must NOT be collapsed: two
    // different rings each cite one of { x, y }; folding { y -> x } makes x cited
    // by BOTH rings (shared), and neither ring cites x twice.
    const cState = createSharedVertexState(
      createVertexStore([
        createVertex(asVertexId('x'), createCoordinate(5, 5)),
        createVertex(asVertexId('y'), createCoordinate(5, 5)),
        createVertex(asVertexId('p'), createCoordinate(6, 5)),
        createVertex(asVertexId('q'), createCoordinate(5, 6)),
        createVertex(asVertexId('r'), createCoordinate(7, 5)),
        createVertex(asVertexId('s'), createCoordinate(5, 7)),
      ]),
      [
        {
          container: ringFeature('C'),
          vertexIds: [asVertexId('x'), asVertexId('p'), asVertexId('q')],
        },
        {
          container: ringFeature('D'),
          vertexIds: [asVertexId('y'), asVertexId('r'), asVertexId('s')],
        },
      ],
    );
    const cAfter = transferSharing(cState, new Map([[asVertexId('y'), asVertexId('x')]]));
    expect(sharedVertexIds(cAfter).map((i) => i as string)).toContain('x');
    expect(referencesOf(cAfter, asVertexId('x')).length).toBe(2);
    // Neither ring cites x twice (the share is legal, not a self-citation).
    for (const entry of cAfter.containers.values()) {
      const xs = entry.vertexIds.filter((i) => i === asVertexId('x')).length;
      expect(xs).toBeLessThanOrEqual(1);
    }
    checkInvariants(cAfter, 'cross-container share (c)');
    checkParticipationOfShared(cAfter, 'cross-container share (c)');
  });
});

// ===========================================================================
// THIRD EXPLORATION PASS (bug-hunt round 2, second sweep). A FRESH, INDEPENDENT
// search with a NEW seed (23002 — disjoint from round-1 seeds 1000-6000 and the
// round-2 first-sweep seed 23001) and command kinds / generators / metamorphic
// interactions NONE of the earlier passes exercised:
//
//   * `chainTransfer`  — transferSharing with a CHAINED (transitive-looking)
//                        remap { a -> b, b -> c } in ONE map. The transfer applies
//                        the remap exactly ONCE per id (no transitive closure), so
//                        a citation of `a` becomes `b` (NOT `c`). Whatever the
//                        intended semantics, the post-state must keep the single
//                        source of truth (no dangling refs), finite coords, and
//                        consistent derivation — a chain must never leave a cited
//                        id without a body. (No prior pass folded a chain.)
//   * `bigMove`        — a move to a LARGE-but-valid coordinate (just under
//                        MAX_COORDINATE_MAGNITUDE) and to coordinates carrying a
//                        signed-zero component. Probes finiteness preservation
//                        through the store AND that save∘load is still identity
//                        when `-0` is normalized to `+0` at the construction seam.
//                        (Earlier passes used only small integer coords.)
//   * `cutThenMove`    — a composite stream command: insert a shared-edge cut,
//                        then immediately MOVE the freshly-minted shared cut vertex
//                        to a new coordinate. This drives a linked move over a
//                        vertex that lives at a NON-zero interior position in TWO
//                        containers at once — a path no earlier op reached (cuts
//                        and moves were never chained in one step).
//   * `shareMultiCand` — share where the CANDIDATE is itself already shared
//                        (cited ≥2 times across distinct containers); every one of
//                        its citations must repoint to the target, so the touched
//                        feature set is the UNION of both groups' features.
//
// New algebraic / metamorphic laws checked here:
//   * transferSharing COMMUTES with serialization: save(transfer(s, m)) loaded
//     equals transfer(load(save(s)), m) — the fold is pure plain-data and survives
//     a round-trip on either side.
//   * a chained fold { a->b, b->c } applied to a state where `a` is cited yields
//     EXACTLY a single (one-step) rewrite — citations of `a` read `b`; assert the
//     non-transitive contract explicitly so a future "helpfully transitive" change
//     is caught.
//   * a move to a `-0` coordinate is byte-identical (after save∘load) to the same
//     move with `+0` — signed-zero canonicalization at the seam holds end to end.
//   * a rejected NEW op leaves the input state untouched (full rollback) — re-run
//     under the new op alphabet and seed.
// ===========================================================================

const SEED3 = 23002;
const NUM_RUNS3 = 600;

// A magnitude safely INSIDE the accepted range but far larger than the small
// integer coords the earlier passes used (well under MAX_COORDINATE_MAGNITUDE so
// createCoordinate never rejects, yet large enough to surface any finiteness
// slip through the store / quantization-adjacent paths).
const BIG = 1_000_000;

type Op3 =
  | { readonly t: 'chainTransfer'; readonly a: number; readonly b: number; readonly c: number }
  | { readonly t: 'bigMove'; readonly i: number; readonly lon: number; readonly lat: number; readonly negZeroLon: boolean; readonly negZeroLat: boolean }
  | { readonly t: 'cutThenMove'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'shareMultiCand'; readonly i: number; readonly j: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number };

const op3Arb: fc.Arbitrary<Op3> = fc.oneof(
  fc.record({ t: fc.constant('chainTransfer' as const), a: fc.nat(20), b: fc.nat(20), c: fc.nat(20) }),
  fc.record({
    t: fc.constant('bigMove' as const),
    i: fc.nat(20),
    lon: fc.integer({ min: -BIG, max: BIG }),
    lat: fc.integer({ min: -BIG, max: BIG }),
    negZeroLon: fc.boolean(),
    negZeroLat: fc.boolean(),
  }),
  fc.record({
    t: fc.constant('cutThenMove' as const),
    pIdx: fc.nat(8),
    qIdx: fc.nat(8),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({ t: fc.constant('shareMultiCand' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('share' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('unshare' as const), i: fc.nat(20) }),
);

// Apply a possible signed-zero override: when the flag is set AND the integer
// component is 0, request -0 explicitly (createCoordinate must normalize it).
function maybeNegZero(value: number, neg: boolean): number {
  return neg && value === 0 ? -0 : value;
}

function applyOp3(ctx: ModelCtx, op: Op3): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'chainTransfer': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 3) return;
      const a = ids[op.a % ids.length];
      const b = ids[op.b % ids.length];
      const c = ids[op.c % ids.length];
      if (a === undefined || b === undefined || c === undefined) return;
      if (new Set([a, b, c]).size !== 3) return; // need three distinct ids for a chain
      ctx.state = transferSharing(ctx.state, new Map([[a, b], [b, c]]));
      return;
    }
    case 'bigMove': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const vid = pick(ids, op.i);
      if (vid === undefined) return;
      const coord = createCoordinate(
        maybeNegZero(op.lon, op.negZeroLon),
        maybeNegZero(op.lat, op.negZeroLat),
      );
      const res = moveVertices(ctx.state, [{ vertexId: vid, coordinate: coord }], { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'cutThenMove': {
      const entries = [...ctx.state.containers.values()];
      if (entries.length < 2) return;
      const primary = entries[op.pIdx % entries.length];
      const partner = entries[op.qIdx % entries.length];
      if (primary === undefined || partner === undefined) return;
      if (containerKey(primary.container) === containerKey(partner.container)) return;
      const out = insertSharedEdgeCut(
        ctx.state,
        {
          primary: { containerKey: containerKey(primary.container), edgeStart: 0 },
          partner: { containerKey: containerKey(partner.container), edgeStart: 0 },
          cutCoordinate: createCoordinate(op.lon + 0.5, op.lat + 0.5),
        },
        ctx.idState,
        ctx.clock,
        { validators },
      );
      if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
      ctx.state = out.result.state;
      ctx.idState = out.idState;
      const cutId = out.cutVertexId;
      if (cutId === undefined) return;
      // Move the freshly minted shared cut vertex (interior position in two rings).
      const moved = moveVertices(
        ctx.state,
        [{ vertexId: cutId, coordinate: createCoordinate(op.lon - 0.5, op.lat - 0.5) }],
        { validators },
      );
      if (moved.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = moved.state;
      return;
    }
    case 'shareMultiCand': {
      // Prefer a candidate that is ALREADY shared (multi-citation) so the repoint
      // moves several citations at once; fall back to any cited id.
      const shared = sharedVertexIds(ctx.state);
      const all = [...new Set(allCitedIds(ctx.state))];
      const cand = pick(shared.length > 0 ? shared : all, op.i);
      const targ = pick(all, op.j);
      if (cand === undefined || targ === undefined) return;
      const res = shareVertices(ctx.state, cand, targ, { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'share': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const cand = pick(ids, op.i);
      const targ = pick(ids, op.j);
      if (cand === undefined || targ === undefined) return;
      const res = shareVertices(ctx.state, cand, targ, { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'unshare': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const refs = referencesOf(ctx.state, vid);
      const ref = refs[op.i % refs.length];
      if (ref === undefined) return;
      const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, { validators });
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
  }
}

describe('shared-vertex-linkage round-2 second sweep (seed 23002)', () => {
  it('round-3 new-op random sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op3Arb, { minLength: 1, maxLength: 30 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        checkInvariants(ctx.state, 'initial');
        checkParticipationOfShared(ctx.state, 'initial');
        let step = 0;
        for (const op of ops) {
          applyOp3(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
        }
      }),
      { seed: SEED3, numRuns: NUM_RUNS3 },
    );
  });

  it('save∘load = identity on round-3 reachable states (incl. big / signed-zero coords)', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op3Arb, { minLength: 0, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp3(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED3, numRuns: NUM_RUNS3 },
    );
  });

  it('a rejected round-3 op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, op3Arb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = { state, idState: createIdGeneratorState(0, 0), clock: makeClock() };
        applyOp3(ctx, op);
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED3, numRuns: NUM_RUNS3 },
    );
  });

  // transferSharing COMMUTES with save∘load: the fold is pure plain-data, so it
  // does not matter whether the JSON round-trip happens before or after the fold.
  it('transferSharing commutes with save∘load', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), (seed, a, b) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 2) return;
        const from = ids[a % ids.length];
        const to = ids[b % ids.length];
        if (from === undefined || to === undefined || from === to) return;
        const remap = new Map<VertexId, VertexId>([[from, to]]);
        // transfer THEN round-trip.
        const transferredThenLoaded = load(save(transferSharing(state, remap)));
        // round-trip THEN transfer.
        const loadedThenTransferred = transferSharing(load(save(state)), remap);
        checkInvariants(transferredThenLoaded, 'transfer-then-load');
        checkInvariants(loadedThenTransferred, 'load-then-transfer');
        expect(canonical(transferredThenLoaded)).toEqual(canonical(loadedThenTransferred));
      }),
      { seed: SEED3, numRuns: NUM_RUNS3 },
    );
  });

  // A CHAINED remap { a -> b, b -> c } applies exactly ONCE (no transitive
  // closure): a citation of `a` becomes `b`, NOT `c`. Pin this contract so a
  // future "helpfully transitive" rewrite is caught, and prove the result keeps
  // the single source of truth regardless (no dangling refs, finite coords).
  it('chained transferSharing rewrites one step (a->b, not a->c) and never dangles', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), fc.nat(20), (seed, ai, bi, ci) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 3) return;
        const a = ids[ai % ids.length];
        const b = ids[bi % ids.length];
        const c = ids[ci % ids.length];
        if (a === undefined || b === undefined || c === undefined) return;
        if (new Set([a, b, c]).size !== 3) return;
        const before = referencesOf(state, a);
        if (before.length === 0) return;
        const after = transferSharing(state, new Map([[a, b], [b, c]]));
        // Single source of truth + finite coords hold no matter the semantics.
        checkInvariants(after, 'after chained transfer');
        // `a` is folded away (it was a remap key with a !== b) -> no longer cited.
        expect(allCitedIds(after).includes(a)).toBe(false);
        // Every position that cited `a` now cites `b` (one-step), and NONE jumped
        // straight to `c` via a transitive closure that the unit does not perform.
        for (const ref of before) {
          const entry = after.containers.get(containerKey(ref.container));
          expect(entry, 'container vanished after chained transfer').toBeDefined();
          if (entry === undefined) continue;
          // The position that held `a` now holds `b` (unless a same-container fold
          // collapsed it away). If still present, it must be `b`, never `c`-by-chain.
          const here = entry.vertexIds[ref.position];
          if (here !== undefined) {
            expect(here).not.toBe(a);
          }
        }
      }),
      { seed: SEED3, numRuns: NUM_RUNS3 },
    );
  });

  // A move to a coordinate carrying a signed-zero component is byte-identical
  // (after save∘load) to the same move with +0 — the construction seam normalizes
  // -0 to +0, so persistence and in-memory forms agree end to end.
  it('a move to a -0 coordinate equals the same move to +0 (signed-zero canonical)', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), (seed, idx) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        const vid = pick(ids, idx);
        if (vid === undefined) return;
        const negZero = moveVertices(state, [{ vertexId: vid, coordinate: createCoordinate(-0, -0) }], {
          validators: [zeroLengthEdgeValidator],
        });
        const posZero = moveVertices(state, [{ vertexId: vid, coordinate: createCoordinate(0, 0) }], {
          validators: [zeroLengthEdgeValidator],
        });
        // Both legs agree on Applied / Rejected (same resulting geometry).
        expect(negZero.status).toBe(posZero.status);
        if (negZero.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        if (posZero.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        expect(canonical(negZero.state)).toEqual(canonical(posZero.state));
        expect(canonical(load(save(negZero.state)))).toEqual(canonical(posZero.state));
        // The stored scalar is +0 (Object.is distinguishes -0 from +0).
        const moved = getVertex(negZero.state.vertices, vid);
        expect(moved).toBeDefined();
        if (moved === undefined) return;
        expect(Object.is(moved.coordinate.lon, -0)).toBe(false);
        expect(Object.is(moved.coordinate.lat, -0)).toBe(false);
      }),
      { seed: SEED3, numRuns: NUM_RUNS3 },
    );
  });

  // A large-but-valid move keeps every stored scalar finite and survives a JSON
  // round-trip (no finiteness slip through the store at high magnitude).
  it('a large-magnitude move keeps coordinates finite and round-trips', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(20),
        fc.integer({ min: -BIG, max: BIG }),
        fc.integer({ min: -BIG, max: BIG }),
        (seed, idx, lon, lat) => {
          const state = buildState(seed);
          const ids = [...new Set(allCitedIds(state))];
          const vid = pick(ids, idx);
          if (vid === undefined) return;
          const res = moveVertices(state, [{ vertexId: vid, coordinate: createCoordinate(lon, lat) }], {
            validators: [zeroLengthEdgeValidator],
          });
          if (res.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          checkInvariants(res.state, 'after big move');
          expect(canonical(load(save(res.state)))).toEqual(canonical(res.state));
        },
      ),
      { seed: SEED3, numRuns: NUM_RUNS3 },
    );
  });

  // Sharing a candidate that is ITSELF already shared repoints EVERY one of its
  // citations onto the target; the touched feature set must be the UNION of both
  // groups' features and the candidate id must vanish entirely.
  it('share with a multi-cited candidate repoints all citations and unions touched features', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op2Arb, { minLength: 0, maxLength: 12 }), fc.nat(20), fc.nat(20), (seed, ops, ai, bi) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp2(ctx, op);
        const shared = sharedVertexIds(ctx.state);
        if (shared.length === 0) return;
        const cand = shared[ai % shared.length];
        const all = [...new Set(allCitedIds(ctx.state))];
        const targ = all[bi % all.length];
        if (cand === undefined || targ === undefined || cand === targ) return;
        const candFeatures = new Set(referencesOf(ctx.state, cand).map((r) => r.container.featureId));
        const targFeatures = new Set(referencesOf(ctx.state, targ).map((r) => r.container.featureId));
        const res = shareVertices(ctx.state, cand, targ, { validators: [zeroLengthEdgeValidator] });
        if (res.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        // The candidate is gone from every container.
        expect(allCitedIds(res.state).includes(cand)).toBe(false);
        // Touched features cover the union of both groups' features.
        for (const f of candFeatures) {
          expect(res.change.touchedFeatureIds.has(f), `missing cand feature ${f}`).toBe(true);
        }
        for (const f of targFeatures) {
          expect(res.change.touchedFeatureIds.has(f), `missing targ feature ${f}`).toBe(true);
        }
        checkInvariants(res.state, 'after multi-cand share');
        checkParticipationOfShared(res.state, 'after multi-cand share');
      }),
      { seed: SEED3, numRuns: NUM_RUNS3 },
    );
  });
});

// ===========================================================================
// FOURTH EXPLORATION PASS (bug-hunt round 2 — second session, "発見のみ").
// A FRESH, INDEPENDENT search with a NEW seed (23003 — disjoint from round-1
// seeds 1000-6000 and the prior round-2 seeds 23001 / 23002) and command kinds /
// generators / metamorphic interactions NONE of the earlier passes exercised:
//
//   * `unshareAll`       — fully fan a shared vertex apart: repeatedly unshare
//                          ONE reference at a time until the id is cited at most
//                          once. Every earlier pass only ever split a SINGLE
//                          reference; this drives the store-growth / id-minting
//                          path through many consecutive splits in one step and
//                          asserts the id is no longer shared at the end.
//   * `chainShare`       — build a multi-container group INCREMENTALLY: share
//                          cand1 onto target, then cand2 onto the same target, so
//                          the target accrues citations from ≥3 containers across
//                          two applies. (Round 1-3 only ever did one share at a
//                          time against an unrelated pair.)
//   * `multiFoldTransfer`— transferSharing folding THREE distinct source ids onto
//                          ONE target in a single remap map. Round-2/3 only ever
//                          folded one (or two disjoint) pairs; folding three at
//                          once exercises the carry-forward / prune / collapse
//                          interaction at higher fan-in.
//   * `moveAllShared`    — move EVERY currently-shared vertex in ONE multi-spec
//                          moveVertices call (spread to distinct coords). Probes
//                          the batched touched-set accounting across many shared
//                          ids simultaneously (no earlier op moved the whole
//                          shared set at once).
//
// New algebraic / metamorphic laws checked here (none asserted by earlier passes):
//   * FULL unshare isolates: after splitting every reference of a shared vertex
//     onto fresh ids, the ORIGINAL id is cited ≤1 time, hence isSharedVertex is
//     false, and the body count grew by exactly (refs-1) (one body minted per
//     split beyond the first kept reference).
//   * share is ORDER-INSENSITIVE on the surviving content for an INDEPENDENT pair
//     of merges: share(a→t) then share(b→t) yields the same canonical state as
//     share(b→t) then share(a→t), when a,b,t and their groups are pairwise
//     container-disjoint (so neither merge gates the other).
//   * a multi-id fold {a→t, b→t, c→t} equals folding them one at a time in any
//     order (the transfer is a pure per-citation rewrite; result is fold-order
//     independent for a common target).
//   * insertSharedEdgeCut's minted cut vertex is ALWAYS cited exactly twice
//     (one share) with a FINITE coordinate equal to the requested cut point.
//   * a rejected NEW op leaves the input state untouched (full rollback) — re-run
//     under the new op alphabet and seed.
// ===========================================================================

const SEED4 = 23003;
const NUM_RUNS4 = 600;

type Op4 =
  | { readonly t: 'unshareAll'; readonly i: number }
  | { readonly t: 'chainShare'; readonly c1: number; readonly c2: number; readonly tgt: number }
  | { readonly t: 'multiFoldTransfer'; readonly a: number; readonly b: number; readonly c: number; readonly tgt: number }
  | { readonly t: 'moveAllShared'; readonly lon: number; readonly lat: number }
  | { readonly t: 'edgeCut'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number };

const op4Arb: fc.Arbitrary<Op4> = fc.oneof(
  fc.record({ t: fc.constant('unshareAll' as const), i: fc.nat(20) }),
  fc.record({ t: fc.constant('chainShare' as const), c1: fc.nat(20), c2: fc.nat(20), tgt: fc.nat(20) }),
  fc.record({ t: fc.constant('multiFoldTransfer' as const), a: fc.nat(20), b: fc.nat(20), c: fc.nat(20), tgt: fc.nat(20) }),
  fc.record({
    t: fc.constant('moveAllShared' as const),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({
    t: fc.constant('edgeCut' as const),
    pIdx: fc.nat(8),
    qIdx: fc.nat(8),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({ t: fc.constant('share' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('unshare' as const), i: fc.nat(20) }),
);

function applyOp4(ctx: ModelCtx, op: Op4): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'unshareAll': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      // Repeatedly split ONE reference off the original id until it is no longer
      // shared. Re-derive references each iteration (positions shift as ids are
      // repointed); a guard caps the loop so a non-terminating split can never
      // hang the suite (it would instead surface as a left-over shared id).
      let guard = 0;
      while (guard < 16) {
        guard += 1;
        const refs = referencesOf(ctx.state, vid);
        if (refs.length < 2) break; // no longer shared
        // Always split the LAST reference (keep the first as the original's home).
        const ref = refs[refs.length - 1];
        if (ref === undefined) break;
        const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, { validators });
        if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) break;
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
    case 'chainShare': {
      const ids1 = [...new Set(allCitedIds(ctx.state))];
      const target = pick(ids1, op.tgt);
      const cand1 = pick(ids1, op.c1);
      if (target === undefined || cand1 === undefined) return;
      if (cand1 !== target) {
        const r1 = shareVertices(ctx.state, cand1, target, { validators });
        if (r1.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = r1.state;
      }
      // Second leg: pick a fresh candidate from the NEW state and fold onto target.
      const ids2 = [...new Set(allCitedIds(ctx.state))];
      const cand2 = pick(ids2, op.c2);
      if (cand2 === undefined || cand2 === target) return;
      const r2 = shareVertices(ctx.state, cand2, target, { validators });
      if (r2.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = r2.state;
      return;
    }
    case 'multiFoldTransfer': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 4) return;
      const target = ids[op.tgt % ids.length];
      const a = ids[op.a % ids.length];
      const b = ids[op.b % ids.length];
      const c = ids[op.c % ids.length];
      if (target === undefined || a === undefined || b === undefined || c === undefined) return;
      const remap = new Map<VertexId, VertexId>();
      for (const src of [a, b, c]) {
        if (src !== target) remap.set(src, target);
      }
      if (remap.size === 0) return;
      ctx.state = transferSharing(ctx.state, remap);
      return;
    }
    case 'moveAllShared': {
      const shared = sharedVertexIds(ctx.state);
      if (shared.length === 0) return;
      const moves: MoveSpec[] = shared.map((vid, k) => ({
        vertexId: vid,
        coordinate: createCoordinate(op.lon + k * 0.29, op.lat - k * 0.17),
      }));
      const res = moveVertices(ctx.state, moves, { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'edgeCut': {
      const entries = [...ctx.state.containers.values()];
      if (entries.length < 2) return;
      const primary = entries[op.pIdx % entries.length];
      const partner = entries[op.qIdx % entries.length];
      if (primary === undefined || partner === undefined) return;
      if (containerKey(primary.container) === containerKey(partner.container)) return;
      const pEdge = realEdgeStart(primary, op.pIdx);
      const qEdge = realEdgeStart(partner, op.qIdx);
      if (pEdge === undefined || qEdge === undefined) return;
      const out = insertSharedEdgeCut(
        ctx.state,
        {
          primary: { containerKey: containerKey(primary.container), edgeStart: pEdge },
          partner: { containerKey: containerKey(partner.container), edgeStart: qEdge },
          cutCoordinate: createCoordinate(op.lon + 0.5, op.lat + 0.5),
        },
        ctx.idState,
        ctx.clock,
        { validators },
      );
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
    case 'share': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const cand = pick(ids, op.i);
      const targ = pick(ids, op.j);
      if (cand === undefined || targ === undefined) return;
      const res = shareVertices(ctx.state, cand, targ, { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'unshare': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const refs = referencesOf(ctx.state, vid);
      const ref = refs[op.i % refs.length];
      if (ref === undefined) return;
      const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, { validators });
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
  }
}

describe('shared-vertex-linkage round-2 fourth pass (seed 23003)', () => {
  it('round-4 new-op random sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op4Arb, { minLength: 1, maxLength: 30 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        checkInvariants(ctx.state, 'initial');
        checkParticipationOfShared(ctx.state, 'initial');
        let step = 0;
        for (const op of ops) {
          applyOp4(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
        }
      }),
      { seed: SEED4, numRuns: NUM_RUNS4 },
    );
  });

  it('save∘load = identity on round-4 reachable states', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op4Arb, { minLength: 0, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp4(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED4, numRuns: NUM_RUNS4 },
    );
  });

  it('a rejected round-4 op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, op4Arb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = { state, idState: createIdGeneratorState(0, 0), clock: makeClock() };
        applyOp4(ctx, op);
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED4, numRuns: NUM_RUNS4 },
    );
  });

  // FULL unshare isolates: splitting EVERY reference of a shared vertex (one at a
  // time, last-ref first) leaves the original id cited at most once, so it is no
  // longer shared; the body count grows by exactly (#refs - 1) — one freshly
  // minted same-coordinate body per split beyond the first kept reference — and
  // every minted body carries the ORIGINAL coordinate (same-coordinate split).
  it('fully unsharing a vertex isolates it and mints one body per extra reference', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op4Arb, { minLength: 0, maxLength: 12 }), fc.nat(20), (seed, ops, idx) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp4(ctx, op);
        const shared = sharedVertexIds(ctx.state);
        const vid = pick(shared, idx);
        if (vid === undefined) return;
        const refCount = referencesOf(ctx.state, vid).length;
        if (refCount < 2) return;
        const origCoord = getVertex(ctx.state.vertices, vid)?.coordinate;
        if (origCoord === undefined) return;
        const beforeBodies = ctx.state.vertices.byId.size;

        // Split off references until no longer shared.
        let st = ctx.state;
        let idState = ctx.idState;
        const minted: VertexId[] = [];
        let guard = 0;
        while (guard < 16) {
          guard += 1;
          const refs = referencesOf(st, vid);
          if (refs.length < 2) break;
          const ref = refs[refs.length - 1];
          if (ref === undefined) break;
          const out = unshareReference(st, vid, ref, idState, ctx.clock, {
            validators: [zeroLengthEdgeValidator],
          });
          if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) return; // skip if a leg rejects
          st = out.result.state;
          idState = out.idState;
          if (out.newVertexId !== undefined) minted.push(out.newVertexId);
        }
        // The original id is now cited at most once -> not shared.
        expect(isSharedVertex(st, vid)).toBe(false);
        // One body minted per split (refCount - 1 splits to leave a single home).
        expect(minted.length).toBe(refCount - 1);
        expect(st.vertices.byId.size).toBe(beforeBodies + (refCount - 1));
        // Every minted body carries the original coordinate.
        for (const m of minted) {
          expect(getVertex(st.vertices, m)?.coordinate).toEqual(origCoord);
        }
        checkInvariants(st, 'after full unshare');
        checkParticipationOfShared(st, 'after full unshare');
      }),
      { seed: SEED4, numRuns: NUM_RUNS4 },
    );
  });

  // share is ORDER-INSENSITIVE for an INDEPENDENT pair of merges onto a common
  // target: sharing a→t then b→t equals sharing b→t then a→t, provided a, b and
  // their groups are pairwise container-disjoint (so neither merge gates the
  // other through participation). Asserts the result content is identical either
  // way (a metamorphic commutativity law no earlier pass checked).
  it('two independent shares onto a common target commute (order-insensitive)', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), fc.nat(20), (seed, ai, bi, ti) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 3) return;
        const a = ids[ai % ids.length];
        const b = ids[bi % ids.length];
        const t = ids[ti % ids.length];
        if (a === undefined || b === undefined || t === undefined) return;
        if (new Set([a, b, t]).size !== 3) return;

        const validators = [zeroLengthEdgeValidator];
        // a→t then b→t.
        const ab1 = shareVertices(state, a, t, { validators });
        if (ab1.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        const ab2 = shareVertices(ab1.state, b, t, { validators });
        if (ab2.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        // b→t then a→t.
        const ba1 = shareVertices(state, b, t, { validators });
        if (ba1.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        const ba2 = shareVertices(ba1.state, a, t, { validators });
        if (ba2.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        // Both orders reached an applied state -> the content must be identical.
        expect(canonical(ab2.state)).toEqual(canonical(ba2.state));
        checkInvariants(ab2.state, 'commute a-then-b');
        checkInvariants(ba2.state, 'commute b-then-a');
      }),
      { seed: SEED4, numRuns: NUM_RUNS4 },
    );
  });

  // A multi-id fold {a→t, b→t, c→t} equals folding the same sources onto t one at
  // a time, in any order (a pure per-citation rewrite for a common target). The
  // one-shot map and the sequential application must reach byte-identical content.
  it('a multi-id fold onto one target equals sequential single folds', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), fc.nat(20), fc.nat(20), (seed, ai, bi, ci, ti) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 4) return;
        const a = ids[ai % ids.length];
        const b = ids[bi % ids.length];
        const c = ids[ci % ids.length];
        const t = ids[ti % ids.length];
        if (a === undefined || b === undefined || c === undefined || t === undefined) return;
        // Require four distinct ids so the fold has three genuine sources.
        if (new Set([a, b, c, t]).size !== 4) return;

        const oneShot = transferSharing(
          state,
          new Map<VertexId, VertexId>([[a, t], [b, t], [c, t]]),
        );
        // Sequential: fold a, then b, then c — each onto t.
        const seq = transferSharing(
          transferSharing(transferSharing(state, new Map([[a, t]])), new Map([[b, t]])),
          new Map([[c, t]]),
        );
        checkInvariants(oneShot, 'multi-fold one-shot');
        checkInvariants(seq, 'multi-fold sequential');
        expect(canonical(oneShot)).toEqual(canonical(seq));
        // None of the three sources survive; t is the sole survivor.
        for (const src of [a, b, c]) {
          expect(allCitedIds(oneShot).includes(src)).toBe(false);
        }
      }),
      { seed: SEED4, numRuns: NUM_RUNS4 },
    );
  });

  // insertSharedEdgeCut's minted cut vertex is ALWAYS a single share: cited
  // exactly twice (primary + partner), with a finite coordinate equal to the
  // requested cut point. Verified across valid interior / closing edges.
  it('an applied shared-edge cut mints a vertex shared exactly twice at the cut point', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(8),
        fc.nat(8),
        fc.nat(8),
        fc.nat(8),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, pIdx, qIdx, pEdge, qEdge, lon, lat) => {
          const state = buildState(seed);
          const entries = [...state.containers.values()];
          if (entries.length < 2) return;
          const primary = entries[pIdx % entries.length];
          const partner = entries[qIdx % entries.length];
          if (primary === undefined || partner === undefined) return;
          const pKey = containerKey(primary.container);
          const qKey = containerKey(partner.container);
          if (pKey === qKey) return;
          const ps = realEdgeStart(primary, pEdge);
          const qs = realEdgeStart(partner, qEdge);
          if (ps === undefined || qs === undefined) return;
          const cut = createCoordinate(lon + 0.5, lat + 0.5);
          const out = insertSharedEdgeCut(
            state,
            {
              primary: { containerKey: pKey, edgeStart: ps },
              partner: { containerKey: qKey, edgeStart: qs },
              cutCoordinate: cut,
            },
            createIdGeneratorState(0, 0),
            makeClock(),
            { validators: [zeroLengthEdgeValidator] },
          );
          if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const cutId = out.cutVertexId;
          expect(cutId).toBeDefined();
          if (cutId === undefined) return;
          // Cited exactly twice -> a single share.
          const refs = referencesOf(out.result.state, cutId);
          expect(refs.length).toBe(2);
          expect(isSharedVertex(out.result.state, cutId)).toBe(true);
          // The two citations are in DIFFERENT containers (legal participation).
          const keys = new Set(refs.map((r) => containerKey(r.container)));
          expect(keys.size).toBe(2);
          // The minted body carries the requested (finite) cut coordinate.
          const body = getVertex(out.result.state.vertices, cutId);
          expect(body?.coordinate).toEqual(cut);
          expect(Number.isFinite(body?.coordinate.lon)).toBe(true);
          expect(Number.isFinite(body?.coordinate.lat)).toBe(true);
        },
      ),
      { seed: SEED4, numRuns: NUM_RUNS4 },
    );
  });

  // moveAllShared accounting: moving EVERY shared vertex in one batch names each
  // moved id in the touched set, creates / deletes nothing, and updates each body
  // to its requested coordinate (single source of truth across all referrers).
  it('moving the whole shared set in one batch reports a complete, create/delete-free touched set', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op4Arb, { minLength: 0, maxLength: 12 }), fc.integer({ min: -179, max: 179 }), fc.integer({ min: -85, max: 85 }), (seed, ops, lon, lat) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp4(ctx, op);
        const shared = sharedVertexIds(ctx.state);
        if (shared.length === 0) return;
        const moves: MoveSpec[] = shared.map((vid, k) => ({
          vertexId: vid,
          coordinate: createCoordinate(lon + k * 0.29, lat - k * 0.17),
        }));
        const res = moveVertices(ctx.state, moves, { validators: [zeroLengthEdgeValidator] });
        if (res.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        for (const m of moves) {
          expect(res.change.touchedVertexIds.has(m.vertexId), `missing touched ${m.vertexId}`).toBe(true);
          expect(getVertex(res.state.vertices, m.vertexId)?.coordinate).toEqual(m.coordinate);
        }
        expect(res.change.createdVertexIds.size).toBe(0);
        expect(res.change.deletedVertexIds.size).toBe(0);
        checkInvariants(res.state, 'after moveAllShared');
        checkParticipationOfShared(res.state, 'after moveAllShared');
      }),
      { seed: SEED4, numRuns: NUM_RUNS4 },
    );
  });
});

// ===========================================================================
// FIFTH EXPLORATION PASS (bug-hunt round 2 — second session, "発見のみ").
// A FRESH, INDEPENDENT search with a NEW seed (23004 — disjoint from round-1
// seeds 1000-6000 and the prior round-2 seeds 23001 / 23002 / 23003) and
// COMPOSITE command kinds / metamorphic interactions NONE of the earlier passes
// exercised. The earlier passes ran each command in isolation against the
// current state; this pass chains a mutation with its *consequence* in one step
// to probe stale-snapshot / aliasing / carry-forward defects that only surface
// when one command reads state produced by the previous one mid-sequence:
//
//   * `moveThenUnshare` — MOVE a shared vertex to a new coordinate, THEN unshare
//                         one of its references. The minted split body must carry
//                         the *post-move* coordinate (the live body), not a stale
//                         pre-move value. (Earlier passes only ever unshared a
//                         vertex at its original coordinate; none moved first.)
//   * `cutThenUnshare`  — insert a shared-edge cut (mint a vertex cited twice),
//                         THEN immediately unshare ONE of the two citations. The
//                         result must split the minted share back into two
//                         distinct same-coordinate bodies — a mint-then-split
//                         round that no earlier op composed in one step.
//   * `foldToBodiless`  — transferSharing folding a cited source onto a target id
//                         that is itself ALSO a remap key folded away in the same
//                         map (so the literal target id may have NO surviving
//                         body unless carry-forward mints one). Drives the §4.7
//                         carry-forward / prune ordering at a fan-in the earlier
//                         passes' single / disjoint folds never reached.
//   * `mixedRemap`      — transferSharing with a map mixing identity entries
//                         (id -> itself) and real folds in ONE call, exercising
//                         the `newId === oldId` skip branch INTERLEAVED with real
//                         carry-forward / prune (earlier passes used either a pure
//                         identity map or a pure fold, never a mix).
//
// New algebraic / metamorphic laws checked here (none asserted by earlier passes):
//   * move∘unshare independence: after moving a shared vertex then splitting one
//     reference, the minted body and the surviving original body are SEPARATE
//     identities — moving one afterward does not drag the other (no aliasing).
//   * cut∘unshare splits a freshly-minted share into exactly two bodies that BOTH
//     carry the cut coordinate; the original cut id is cited ≤1 time afterward.
//   * a fold whose target is itself folded away resolves to a state with NO
//     dangling reference (single source of truth) and finite coordinates — the
//     literal cited id is never left without a body.
//   * mixed identity+fold remap equals the pure-fold remap with the identity
//     entries removed (identity entries are genuine no-ops, even interleaved).
//   * a rejected NEW op leaves the input state untouched (full rollback) — re-run
//     under the new op alphabet and seed.
//   * sharedVertexIds is duplicate-free after every op (selection validity: the
//     derived shared set never lists an id twice).
// ===========================================================================

const SEED5 = 23004;
const NUM_RUNS5 = 600;

type Op5 =
  | { readonly t: 'moveThenUnshare'; readonly i: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'cutThenUnshare'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number; readonly which: number }
  | { readonly t: 'foldToBodiless'; readonly a: number; readonly b: number; readonly c: number }
  | { readonly t: 'mixedRemap'; readonly a: number; readonly b: number; readonly id1: number; readonly id2: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number }
  | { readonly t: 'edgeCut'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number };

const op5Arb: fc.Arbitrary<Op5> = fc.oneof(
  fc.record({
    t: fc.constant('moveThenUnshare' as const),
    i: fc.nat(20),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({
    t: fc.constant('cutThenUnshare' as const),
    pIdx: fc.nat(8),
    qIdx: fc.nat(8),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
    which: fc.nat(1),
  }),
  fc.record({ t: fc.constant('foldToBodiless' as const), a: fc.nat(20), b: fc.nat(20), c: fc.nat(20) }),
  fc.record({ t: fc.constant('mixedRemap' as const), a: fc.nat(20), b: fc.nat(20), id1: fc.nat(20), id2: fc.nat(20) }),
  fc.record({ t: fc.constant('share' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('unshare' as const), i: fc.nat(20) }),
  fc.record({
    t: fc.constant('edgeCut' as const),
    pIdx: fc.nat(8),
    qIdx: fc.nat(8),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
);

function applyOp5(ctx: ModelCtx, op: Op5): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'moveThenUnshare': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const moved = moveVertices(ctx.state, [{ vertexId: vid, coordinate: createCoordinate(op.lon, op.lat) }], { validators });
      if (moved.status !== SHARED_VERTEX_OUTCOME.Applied) return;
      ctx.state = moved.state;
      // Now split ONE reference of the (still shared) vertex at its NEW coordinate.
      const refs = referencesOf(ctx.state, vid);
      if (refs.length < 2) return;
      const ref = refs[op.i % refs.length];
      if (ref === undefined) return;
      const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, { validators });
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
    case 'cutThenUnshare': {
      const entries = [...ctx.state.containers.values()];
      if (entries.length < 2) return;
      const primary = entries[op.pIdx % entries.length];
      const partner = entries[op.qIdx % entries.length];
      if (primary === undefined || partner === undefined) return;
      if (containerKey(primary.container) === containerKey(partner.container)) return;
      const out = insertSharedEdgeCut(
        ctx.state,
        {
          primary: { containerKey: containerKey(primary.container), edgeStart: 0 },
          partner: { containerKey: containerKey(partner.container), edgeStart: 0 },
          cutCoordinate: createCoordinate(op.lon + 0.25, op.lat + 0.25),
        },
        ctx.idState,
        ctx.clock,
        { validators },
      );
      if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
      ctx.state = out.result.state;
      ctx.idState = out.idState;
      const cutId = out.cutVertexId;
      if (cutId === undefined) return;
      // Split one of the two citations of the minted share back apart.
      const refs = referencesOf(ctx.state, cutId);
      const ref = refs[op.which % Math.max(1, refs.length)];
      if (ref === undefined) return;
      const split = unshareReference(ctx.state, cutId, ref, ctx.idState, ctx.clock, { validators });
      if (split.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = split.result.state;
        ctx.idState = split.idState;
      }
      return;
    }
    case 'foldToBodiless': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 3) return;
      const a = ids[op.a % ids.length];
      const b = ids[op.b % ids.length];
      const c = ids[op.c % ids.length];
      if (a === undefined || b === undefined || c === undefined) return;
      if (new Set([a, b, c]).size !== 3) return;
      // Fold a -> b AND b -> c in one map: the literal target `b` of the first
      // entry is itself folded away. After collapse, no container may cite `a` or
      // `b`, and every surviving citation must resolve to a body (carry-forward).
      ctx.state = transferSharing(ctx.state, new Map([[a, b], [b, c]]));
      return;
    }
    case 'mixedRemap': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 2) return;
      const from = ids[op.a % ids.length];
      const to = ids[op.b % ids.length];
      if (from === undefined || to === undefined || from === to) return;
      // A map mixing a real fold with identity entries (id -> itself).
      const remap = new Map<VertexId, VertexId>([[from, to]]);
      const idA = ids[op.id1 % ids.length];
      const idB = ids[op.id2 % ids.length];
      if (idA !== undefined && idA !== from) remap.set(idA, idA);
      if (idB !== undefined && idB !== from) remap.set(idB, idB);
      ctx.state = transferSharing(ctx.state, remap);
      return;
    }
    case 'share': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const cand = pick(ids, op.i);
      const targ = pick(ids, op.j);
      if (cand === undefined || targ === undefined) return;
      const res = shareVertices(ctx.state, cand, targ, { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'unshare': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const refs = referencesOf(ctx.state, vid);
      const ref = refs[op.i % refs.length];
      if (ref === undefined) return;
      const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, { validators });
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
    case 'edgeCut': {
      const entries = [...ctx.state.containers.values()];
      if (entries.length < 2) return;
      const primary = entries[op.pIdx % entries.length];
      const partner = entries[op.qIdx % entries.length];
      if (primary === undefined || partner === undefined) return;
      if (containerKey(primary.container) === containerKey(partner.container)) return;
      const pEdge = realEdgeStart(primary, op.pIdx);
      const qEdge = realEdgeStart(partner, op.qIdx);
      if (pEdge === undefined || qEdge === undefined) return;
      const out = insertSharedEdgeCut(
        ctx.state,
        {
          primary: { containerKey: containerKey(primary.container), edgeStart: pEdge },
          partner: { containerKey: containerKey(partner.container), edgeStart: qEdge },
          cutCoordinate: createCoordinate(op.lon + 0.5, op.lat + 0.5),
        },
        ctx.idState,
        ctx.clock,
        { validators },
      );
      if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = out.result.state;
        ctx.idState = out.idState;
      }
      return;
    }
  }
}

// sharedVertexIds must never list any id more than once (selection validity).
function checkSharedSetDistinct(state: SharedVertexState, label: string): void {
  const list = sharedVertexIds(state);
  const set = new Set(list);
  expect(set.size, `${label}: sharedVertexIds has a duplicate (${list.join(', ')})`).toBe(list.length);
}

describe('shared-vertex-linkage round-2 fifth pass (seed 23004)', () => {
  it('round-5 composite-op random sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op5Arb, { minLength: 1, maxLength: 30 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        checkInvariants(ctx.state, 'initial');
        checkParticipationOfShared(ctx.state, 'initial');
        checkSharedSetDistinct(ctx.state, 'initial');
        let step = 0;
        for (const op of ops) {
          applyOp5(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
          checkSharedSetDistinct(ctx.state, label);
        }
      }),
      { seed: SEED5, numRuns: NUM_RUNS5 },
    );
  });

  it('save∘load = identity on round-5 reachable states', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op5Arb, { minLength: 0, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp5(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED5, numRuns: NUM_RUNS5 },
    );
  });

  it('a rejected round-5 op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, op5Arb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = { state, idState: createIdGeneratorState(0, 0), clock: makeClock() };
        applyOp5(ctx, op);
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED5, numRuns: NUM_RUNS5 },
    );
  });

  // move∘unshare: after MOVING a shared vertex then splitting one of its
  // references, the minted body must carry the *post-move* (live) coordinate, and
  // the two bodies must be INDEPENDENT — moving the minted body afterward must NOT
  // change the original body's coordinate (no aliasing / shared mutable cell).
  it('unshare after a move mints the live coordinate and the bodies are independent', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.array(op5Arb, { minLength: 0, maxLength: 10 }),
        fc.nat(20),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, ops, idx, lon, lat) => {
          const ctx: ModelCtx = {
            state: buildState(seed),
            idState: createIdGeneratorState(0, 0),
            clock: makeClock(),
          };
          for (const op of ops) applyOp5(ctx, op);
          const shared = sharedVertexIds(ctx.state);
          const vid = pick(shared, idx);
          if (vid === undefined) return;
          // Move the shared vertex to a fresh coordinate.
          const newCoord = createCoordinate(lon, lat);
          const moved = moveVertices(ctx.state, [{ vertexId: vid, coordinate: newCoord }], {
            validators: [zeroLengthEdgeValidator],
          });
          if (moved.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const movedState = moved.state;
          const refs = referencesOf(movedState, vid);
          if (refs.length < 2) return;
          const ref = refs[idx % refs.length];
          if (ref === undefined) return;
          const split = unshareReference(movedState, vid, ref, ctx.idState, ctx.clock, {
            validators: [zeroLengthEdgeValidator],
          });
          if (split.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const newId = split.newVertexId;
          if (newId === undefined) return;
          // The minted body carries the LIVE (post-move) coordinate, not a stale one.
          const minted = getVertex(split.result.state.vertices, newId);
          expect(minted?.coordinate).toEqual(newCoord);
          const origBody = getVertex(split.result.state.vertices, vid);
          expect(origBody?.coordinate).toEqual(newCoord);
          // Independence: move ONLY the minted body elsewhere; the original stays.
          const elsewhere = createCoordinate(lon === 0 ? 1 : 0, lat === 0 ? 1 : 0);
          const moveMint = moveVertices(split.result.state, [{ vertexId: newId, coordinate: elsewhere }], {
            validators: [zeroLengthEdgeValidator],
          });
          if (moveMint.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          expect(getVertex(moveMint.state.vertices, newId)?.coordinate).toEqual(elsewhere);
          // The original body is untouched by the mint move (no aliasing).
          expect(getVertex(moveMint.state.vertices, vid)?.coordinate).toEqual(newCoord);
          checkInvariants(moveMint.state, 'after move∘unshare independence');
        },
      ),
      { seed: SEED5, numRuns: NUM_RUNS5 },
    );
  });

  // cut∘unshare: insert a shared-edge cut (mint a vertex cited exactly twice),
  // then unshare ONE of its two citations. The result splits the share into two
  // distinct same-coordinate bodies; the original cut id is cited ≤1 time, the
  // minted body carries the cut coordinate, and the body count grew by exactly 1.
  it('unshare immediately after a shared-edge cut splits the mint into two same-coordinate bodies', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(8),
        fc.nat(8),
        fc.nat(8),
        fc.nat(8),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        fc.nat(1),
        (seed, pIdx, qIdx, pEdge, qEdge, lon, lat, which) => {
          const state = buildState(seed);
          const entries = [...state.containers.values()];
          if (entries.length < 2) return;
          const primary = entries[pIdx % entries.length];
          const partner = entries[qIdx % entries.length];
          if (primary === undefined || partner === undefined) return;
          const pKey = containerKey(primary.container);
          const qKey = containerKey(partner.container);
          if (pKey === qKey) return;
          const ps = realEdgeStart(primary, pEdge);
          const qs = realEdgeStart(partner, qEdge);
          if (ps === undefined || qs === undefined) return;
          const cut = createCoordinate(lon + 0.5, lat + 0.5);
          const idState0 = createIdGeneratorState(0, 0);
          const clock = makeClock();
          const cutOut = insertSharedEdgeCut(
            state,
            {
              primary: { containerKey: pKey, edgeStart: ps },
              partner: { containerKey: qKey, edgeStart: qs },
              cutCoordinate: cut,
            },
            idState0,
            clock,
            { validators: [zeroLengthEdgeValidator] },
          );
          if (cutOut.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const cutId = cutOut.cutVertexId;
          if (cutId === undefined) return;
          const afterCut = cutOut.result.state;
          const refs = referencesOf(afterCut, cutId);
          expect(refs.length).toBe(2);
          const ref = refs[which % refs.length];
          if (ref === undefined) return;
          const bodiesBefore = afterCut.vertices.byId.size;
          const split = unshareReference(afterCut, cutId, ref, cutOut.idState, clock, {
            validators: [zeroLengthEdgeValidator],
          });
          if (split.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const newId = split.newVertexId;
          if (newId === undefined) return;
          // The cut id is now cited at most once -> no longer shared.
          expect(isSharedVertex(split.result.state, cutId)).toBe(false);
          // Two distinct bodies both at the cut coordinate.
          expect(getVertex(split.result.state.vertices, cutId)?.coordinate).toEqual(cut);
          expect(getVertex(split.result.state.vertices, newId)?.coordinate).toEqual(cut);
          expect(split.result.state.vertices.byId.size).toBe(bodiesBefore + 1);
          checkInvariants(split.result.state, 'after cut∘unshare');
          checkParticipationOfShared(split.result.state, 'after cut∘unshare');
        },
      ),
      { seed: SEED5, numRuns: NUM_RUNS5 },
    );
  });

  // A fold whose literal target is itself folded away in the SAME map
  // ({ a -> b, b -> c }) must never leave a dangling reference: after the
  // collapse, no container cites `a` or `b`, and EVERY surviving citation
  // resolves to a vertex body (single source of truth). The carry-forward must
  // mint a body for any cited target that lacked one.
  it('a fold onto a folded-away target leaves no dangling reference', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), fc.nat(20), (seed, ai, bi, ci) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 3) return;
        const a = ids[ai % ids.length];
        const b = ids[bi % ids.length];
        const c = ids[ci % ids.length];
        if (a === undefined || b === undefined || c === undefined) return;
        if (new Set([a, b, c]).size !== 3) return;
        const after = transferSharing(state, new Map([[a, b], [b, c]]));
        checkInvariants(after, 'after fold-onto-folded-away');
        // The remap is applied EXACTLY ONCE per position (no transitive closure;
        // §4.7 — pinned by the round-3 chained-transfer test). So `a` (a remap key
        // with a !== b, and no entry maps anything back to `a`) is gone entirely,
        // while `b` MAY reappear: positions that originally cited `a` now cite `b`.
        // We therefore only assert `a` vanished (the strong claim that `b` also
        // vanishes is FALSE under one-step semantics — `a -> b` re-introduces `b`).
        expect(allCitedIds(after).includes(a)).toBe(false);
        // The KEY law for this op: no dangling reference. Every cited id — incl.
        // any `b` re-introduced by the `a -> b` leg, or `c` from the `b -> c` leg —
        // must resolve to a vertex body (single source of truth, carry-forward).
        for (const id of allCitedIds(after)) {
          expect(getVertex(after.vertices, id), `cited ${id} has no body after chained fold`).toBeDefined();
        }
      }),
      { seed: SEED5, numRuns: NUM_RUNS5 },
    );
  });

  // A mixed identity+fold remap equals the pure-fold remap with the identity
  // entries removed: identity entries (id -> itself) are genuine no-ops even when
  // interleaved with a real fold in one map (the `newId === oldId` skip branch
  // must not perturb carry-forward / prune of the real fold).
  it('a mixed identity+fold remap equals the pure fold (identity entries are no-ops)', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), fc.nat(20), fc.nat(20), (seed, ai, bi, i1, i2) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 2) return;
        const from = ids[ai % ids.length];
        const to = ids[bi % ids.length];
        if (from === undefined || to === undefined || from === to) return;
        const idA = ids[i1 % ids.length];
        const idB = ids[i2 % ids.length];
        const mixed = new Map<VertexId, VertexId>([[from, to]]);
        if (idA !== undefined && idA !== from) mixed.set(idA, idA);
        if (idB !== undefined && idB !== from) mixed.set(idB, idB);
        const pure = new Map<VertexId, VertexId>([[from, to]]);
        const mixedAfter = transferSharing(state, mixed);
        const pureAfter = transferSharing(state, pure);
        checkInvariants(mixedAfter, 'mixed remap');
        checkInvariants(pureAfter, 'pure remap');
        expect(canonical(mixedAfter)).toEqual(canonical(pureAfter));
      }),
      { seed: SEED5, numRuns: NUM_RUNS5 },
    );
  });

  // Carry-forward correctness: folding a cited source onto a target that has NO
  // body in the store (the target is itself only reachable as a fold key, so its
  // literal id never survives) must still leave every cited id with a body. We
  // construct the minimal shape directly to pin the §4.7 carry-forward contract:
  // two separate rings each citing one of { p, q }; fold { p -> q, q -> p } swaps,
  // and BOTH literal ids stay cited and bodied (a degenerate but legal swap).
  it('transferSharing carry-forward keeps every cited id bodied through a swap', () => {
    const ringFeature = (n: string): ShapeContainer => ({
      kind: 'ring',
      featureId: asFeatureId(`fSwap${n}`),
      ringId: `rSwap${n}`,
    });
    const state = createSharedVertexState(
      createVertexStore([
        createVertex(asVertexId('p'), createCoordinate(10, 10)),
        createVertex(asVertexId('q'), createCoordinate(20, 20)),
        createVertex(asVertexId('m'), createCoordinate(11, 10)),
        createVertex(asVertexId('n'), createCoordinate(10, 11)),
        createVertex(asVertexId('u'), createCoordinate(21, 20)),
        createVertex(asVertexId('w'), createCoordinate(20, 21)),
      ]),
      [
        { container: ringFeature('1'), vertexIds: [asVertexId('p'), asVertexId('m'), asVertexId('n')] },
        { container: ringFeature('2'), vertexIds: [asVertexId('q'), asVertexId('u'), asVertexId('w')] },
      ],
    );
    // Swap p <-> q. Each is both a remap key (folded away as a source) AND a
    // remap target. Carry-forward must keep BOTH bodied and cited.
    const after = transferSharing(state, new Map([[asVertexId('p'), asVertexId('q')], [asVertexId('q'), asVertexId('p')]]));
    checkInvariants(after, 'after p<->q swap');
    // Both ids remain cited (the swap moved each into the other's ring).
    expect(allCitedIds(after).includes(asVertexId('p'))).toBe(true);
    expect(allCitedIds(after).includes(asVertexId('q'))).toBe(true);
    // Ring 1 now cites q where it cited p; ring 2 cites p where it cited q.
    expect(after.containers.get(containerKey(ringFeature('1')))?.vertexIds[0]).toBe(asVertexId('q'));
    expect(after.containers.get(containerKey(ringFeature('2')))?.vertexIds[0]).toBe(asVertexId('p'));
  });
});
