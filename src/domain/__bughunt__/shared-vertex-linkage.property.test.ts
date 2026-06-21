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
