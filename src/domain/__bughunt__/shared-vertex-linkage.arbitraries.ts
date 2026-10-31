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
//
// 検査の本体は shared-vertex-linkage.property.test.ts と shared-vertex-linkage-N.property.test.ts に割ってある。
// vitest はファイル単位でしか並列に分配しないので、1 本に詰めると全件の待ち時間がその 1 本で決まる。
// ここには各ファイルが共有する生成器・補助だけを置く。

import fc from 'fast-check';
import { expect } from 'vitest';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { type IdGeneratorState } from '../id-generator';
import { asFeatureId, asVertexId, type VertexId } from '../ids';
import { buildReverseIndex, checkParticipation, containerKey, createSharedVertexState, insertSharedEdgeCut, isSharedVertex, moveVertices, referencesOf, shareVertices, sharedVertexIds, transferSharing, unshareReference, zeroLengthEdgeValidator, SHARED_VERTEX_OUTCOME, type ContainerEntry, type MoveSpec, type ShapeContainer, type SharedVertexState } from '../shared-vertex';
import { createVertex, createVertexStore, getVertex, type Vertex } from '../vertex';

export const SEED = 3004;
export const NUM_RUNS = 800;

// A monotonic injected time source (deterministic). Each call advances by 1.
export function makeClock(start = 1): () => number {
  let t = start;
  return () => t++;
}

// ---------------------------------------------------------------------------
// Invariant checks (run after every op).
// ---------------------------------------------------------------------------

export function allCitedIds(state: SharedVertexState): VertexId[] {
  const ids: VertexId[] = [];
  for (const entry of state.containers.values()) {
    for (const id of entry.vertexIds) ids.push(id);
  }
  return ids;
}

export function checkInvariants(state: SharedVertexState, label: string): void {
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
export function checkParticipationOfShared(state: SharedVertexState, label: string): void {
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

export interface SerializedState {
  readonly vertices: Array<{ id: string; lon: number; lat: number }>;
  readonly containers: Array<{ container: ShapeContainer; vertexIds: string[] }>;
}

export function save(state: SharedVertexState): string {
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

export function load(json: string): SharedVertexState {
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
export function canonical(state: SharedVertexState): unknown {
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

export const coordArb: fc.Arbitrary<WorldCoordinate> = fc
  .tuple(fc.integer({ min: -170, max: 170 }), fc.integer({ min: -80, max: 80 }))
  .map(([lon, lat]) => createCoordinate(lon, lat));

export interface GenSeed {
  readonly vertexCount: number;
  readonly coords: readonly WorldCoordinate[];
  readonly ringCount: number;
  readonly lineCount: number;
}

export const seedArb: fc.Arbitrary<GenSeed> = fc
  .record({ vertexCount: fc.integer({ min: 4, max: 10 }), ringCount: fc.integer({ min: 1, max: 3 }), lineCount: fc.integer({ min: 0, max: 2 }) })
  .chain(({ vertexCount, ringCount, lineCount }) =>
    fc
      .array(coordArb, { minLength: vertexCount, maxLength: vertexCount })
      .map((coords) => ({ vertexCount, coords, ringCount, lineCount })),
  );

export function buildState(seed: GenSeed): SharedVertexState {
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

export type Op =
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'move'; readonly i: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'unshare'; readonly i: number }
  | { readonly t: 'transferIdentity' }
  | { readonly t: 'edgeCut'; readonly primaryIdx: number; readonly partnerIdx: number; readonly lon: number; readonly lat: number };

export const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('share' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('move' as const), i: fc.nat(20), lon: fc.integer({ min: -179, max: 179 }), lat: fc.integer({ min: -85, max: 85 }) }),
  fc.record({ t: fc.constant('unshare' as const), i: fc.nat(20) }),
  fc.record({ t: fc.constant('transferIdentity' as const) }),
  fc.record({ t: fc.constant('edgeCut' as const), primaryIdx: fc.nat(8), partnerIdx: fc.nat(8), lon: fc.integer({ min: -179, max: 179 }), lat: fc.integer({ min: -85, max: 85 }) }),
);

export function pick<T>(arr: readonly T[], idx: number): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[idx % arr.length];
}

export interface ModelCtx {
  state: SharedVertexState;
  idState: IdGeneratorState;
  clock: () => number;
}

export function applyOp(ctx: ModelCtx, op: Op): void {
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

export const SEED2 = 23001;
export const NUM_RUNS2 = 600;

// Choose a real edge start for a container (closed ring: 0..n-1; line: 0..n-2).
export function realEdgeStart(entry: ContainerEntry, pick: number): number | undefined {
  const n = entry.vertexIds.length;
  if (n < 2) return undefined;
  const maxStart = entry.container.kind === 'ring' ? n - 1 : n - 2;
  return pick % (maxStart + 1);
}

export type Op2 =
  | { readonly t: 'multiMove'; readonly idxs: readonly number[]; readonly lon: number; readonly lat: number }
  | { readonly t: 'dupMove'; readonly i: number; readonly lon1: number; readonly lat1: number; readonly lon2: number; readonly lat2: number }
  | { readonly t: 'validEdgeCut'; readonly pIdx: number; readonly qIdx: number; readonly pEdge: number; readonly qEdge: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'mergeTransfer'; readonly a: number; readonly b: number }
  | { readonly t: 'reshareSplit'; readonly i: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number };

export const op2Arb: fc.Arbitrary<Op2> = fc.oneof(
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

export function applyOp2(ctx: ModelCtx, op: Op2): void {
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

export const SEED3 = 23002;
export const NUM_RUNS3 = 600;

// A magnitude safely INSIDE the accepted range but far larger than the small
// integer coords the earlier passes used (well under MAX_COORDINATE_MAGNITUDE so
// createCoordinate never rejects, yet large enough to surface any finiteness
// slip through the store / quantization-adjacent paths).
export const BIG = 1_000_000;

export type Op3 =
  | { readonly t: 'chainTransfer'; readonly a: number; readonly b: number; readonly c: number }
  | { readonly t: 'bigMove'; readonly i: number; readonly lon: number; readonly lat: number; readonly negZeroLon: boolean; readonly negZeroLat: boolean }
  | { readonly t: 'cutThenMove'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'shareMultiCand'; readonly i: number; readonly j: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number };

export const op3Arb: fc.Arbitrary<Op3> = fc.oneof(
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
export function maybeNegZero(value: number, neg: boolean): number {
  return neg && value === 0 ? -0 : value;
}

export function applyOp3(ctx: ModelCtx, op: Op3): void {
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

export const SEED4 = 23003;
export const NUM_RUNS4 = 600;

export type Op4 =
  | { readonly t: 'unshareAll'; readonly i: number }
  | { readonly t: 'chainShare'; readonly c1: number; readonly c2: number; readonly tgt: number }
  | { readonly t: 'multiFoldTransfer'; readonly a: number; readonly b: number; readonly c: number; readonly tgt: number }
  | { readonly t: 'moveAllShared'; readonly lon: number; readonly lat: number }
  | { readonly t: 'edgeCut'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number };

export const op4Arb: fc.Arbitrary<Op4> = fc.oneof(
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

export function applyOp4(ctx: ModelCtx, op: Op4): void {
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

export const SEED5 = 23004;
export const NUM_RUNS5 = 600;

export type Op5 =
  | { readonly t: 'moveThenUnshare'; readonly i: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'cutThenUnshare'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number; readonly which: number }
  | { readonly t: 'foldToBodiless'; readonly a: number; readonly b: number; readonly c: number }
  | { readonly t: 'mixedRemap'; readonly a: number; readonly b: number; readonly id1: number; readonly id2: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number }
  | { readonly t: 'edgeCut'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number };

export const op5Arb: fc.Arbitrary<Op5> = fc.oneof(
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

export function applyOp5(ctx: ModelCtx, op: Op5): void {
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
export function checkSharedSetDistinct(state: SharedVertexState, label: string): void {
  const list = sharedVertexIds(state);
  const set = new Set(list);
  expect(set.size, `${label}: sharedVertexIds has a duplicate (${list.join(', ')})`).toBe(list.length);
}

// ===========================================================================
// SIXTH EXPLORATION PASS (bug-hunt round 3 — "発見のみ・修正しない").
// A FRESH, INDEPENDENT search with a NEW seed (33002 — disjoint from EVERY
// earlier pass: round-1 seeds 1000-6000 / 3004 and round-2 seeds 23001-23004)
// and numRuns deliberately raised. This pass is built around explicit INVERSE
// command pairs so the undo / inverse metamorphic laws — only ever asserted as
// the narrow reshare∘unshare special case before — are exercised over an
// arbitrary reachable state and across EVERY mutating command kind:
//
//   * `moveUndo`        — capture a shared vertex's live coordinate, move it
//                         elsewhere, then move it BACK to the captured value.
//                         undo∘move must restore the state byte-for-byte. (Round
//                         1 checked "move out then back" only from the PRISTINE
//                         buildState; here the base is an arbitrary op-reached
//                         state, and the vertex is required to be SHARED so the
//                         restore must re-converge every referrer, not just one.)
//   * `transferUndo`    — fold a -> b, then fold b -> a (the inverse remap) in a
//                         second call. For a fold where `b` was NOT previously
//                         cited, op∘逆op must return the original citations and
//                         bodies (a genuine algebraic inverse on disjoint ids).
//   * `dupShareInbox`   — attempt shareVertices on two ids that are BOTH cited by
//                         ONE container (same ring / same line path). This MUST
//                         be rejected with REJECT_REASON.Participation and leave
//                         the state untouched — the shipped command's gate. No
//                         earlier pass deliberately fed share a same-container
//                         pair (the random `share` op hit it only incidentally);
//                         here it is the explicit law, asserted directly.
//   * `coordSwap`       — swap the coordinates of TWO distinct shared vertices in
//                         a single multi-spec move (a<-b.coord, b<-a.coord), and
//                         require swap∘swap = identity (an involution). Probes
//                         that a batched move computes every new body from the
//                         ORIGINAL store snapshot (read-before-write), not from
//                         partially-updated bodies — a true simultaneous swap,
//                         never a both-collapse-to-one aliasing bug. (No earlier
//                         multiMove ever cross-assigned ids' coordinates.)
//   * `cutUndo`         — insert a shared-edge cut, then SHARE the minted cut id
//                         onto one of its own edge endpoints to dissolve it back
//                         (a structural inverse of the cut), asserting invariants
//                         hold through the mint→dissolve round (a composite no
//                         earlier pass formed).
//
// New algebraic / metamorphic laws checked here (none asserted by earlier passes
// over an arbitrary reachable base / shared vertex):
//   * undo∘move = identity for a SHARED vertex from an arbitrary reachable state.
//   * op∘逆op = identity for transferSharing on a disjoint fold/un-fold pair.
//   * a coordinate swap of two shared vertices is an involution (swap∘swap = id)
//     AND each body ends at the OTHER's original coordinate (true simultaneity).
//   * shareVertices on a same-container pair is rejected (Participation), input
//     untouched — the participation gate holds for the SHARE command directly.
//   * save∘load = identity across the round-6 op stream.
//   * a rejected round-6 op leaves the input untouched (full rollback).
//   * sharedVertexIds is duplicate-free after every op (selection validity).
// ===========================================================================

export const SEED6 = 33002;
export const NUM_RUNS6 = 1200;

export type Op6 =
  | { readonly t: 'moveUndo'; readonly i: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'transferUndo'; readonly a: number; readonly b: number }
  | { readonly t: 'coordSwap'; readonly i: number; readonly j: number }
  | { readonly t: 'cutUndo'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number }
  | { readonly t: 'edgeCut'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number };

export const op6Arb: fc.Arbitrary<Op6> = fc.oneof(
  fc.record({
    t: fc.constant('moveUndo' as const),
    i: fc.nat(20),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({ t: fc.constant('transferUndo' as const), a: fc.nat(20), b: fc.nat(20) }),
  fc.record({ t: fc.constant('coordSwap' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({
    t: fc.constant('cutUndo' as const),
    pIdx: fc.nat(8),
    qIdx: fc.nat(8),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
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

export function applyOp6(ctx: ModelCtx, op: Op6): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'moveUndo': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const out = moveVertices(ctx.state, [{ vertexId: vid, coordinate: createCoordinate(op.lon, op.lat) }], { validators });
      if (out.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = out.state;
      return;
    }
    case 'transferUndo': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 2) return;
      const from = ids[op.a % ids.length];
      const to = ids[op.b % ids.length];
      if (from === undefined || to === undefined || from === to) return;
      ctx.state = transferSharing(ctx.state, new Map([[from, to]]));
      return;
    }
    case 'coordSwap': {
      const shared = sharedVertexIds(ctx.state);
      if (shared.length < 2) return;
      const a = pick(shared, op.i);
      const b = pick(shared, op.j);
      if (a === undefined || b === undefined || a === b) return;
      const ca = getVertex(ctx.state.vertices, a)?.coordinate;
      const cb = getVertex(ctx.state.vertices, b)?.coordinate;
      if (ca === undefined || cb === undefined) return;
      const res = moveVertices(
        ctx.state,
        [
          { vertexId: a, coordinate: cb },
          { vertexId: b, coordinate: ca },
        ],
        { validators },
      );
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'cutUndo': {
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

// ===========================================================================
// SEVENTH EXPLORATION PASS (bug-hunt round 3 — "発見のみ・修正しない").
// A FRESH, INDEPENDENT search with a NEW seed (33003 — disjoint from EVERY
// earlier pass: round-1 seeds 1000-6000 / 3004, round-2 seeds 23001-23004, and
// the round-3 sixth-pass seed 33002) and a deliberately large numRuns. This
// pass introduces command kinds / generators / metamorphic interactions that
// NONE of the earlier passes exercised, focused on HIGHER-ORDER composites that
// chain a mint with a *second* mint or a move of the just-minted body — the
// stale-snapshot / position-recompute / aliasing surface that only appears when
// one structural mutation is consumed by the next within ONE step:
//
//   * `cutTwice`          — TWO shared-edge cuts on the SAME (primary, partner)
//                           container pair, back to back. The second cut's
//                           edgeStart is RE-DERIVED from the container AFTER the
//                           first cut grew it by one, so it drives the splice
//                           path over a list whose length / positions just
//                           shifted under the first insertion. No earlier pass
//                           ever performed two cuts in one step; this probes that
//                           the second mint reads the LIVE (post-first-cut) state
//                           and yields a second id shared exactly twice, with the
//                           first cut id still shared exactly twice (independent
//                           mints, no position corruption / no id reuse).
//   * `unshareThenMove`   — split ONE reference off a shared vertex, THEN move the
//                           freshly MINTED id (the inverse ordering of round-5's
//                           moveThenUnshare). The minted id must be independently
//                           movable; moving it must NOT drag the original body
//                           (no aliasing), and the original referrers must keep
//                           the original coordinate.
//   * `foldUnfold`        — fold { a -> b } then immediately fold { b -> a } in
//                           the SAME step, in-stream, over an ARBITRARY reachable
//                           base. When `b` was uncited beforehand this is a clean
//                           rename whose inverse must restore the citations; the
//                           op merely exercises the carry-forward / prune path
//                           twice per step (the dedicated law below pins the exact
//                           identity on a disjoint rename).
//   * `moveToExisting`    — move a shared vertex ONTO the exact coordinate of a
//                           DIFFERENT existing vertex. Two distinct ids at one
//                           coordinate are legal as long as they are not adjacent
//                           in any container (zeroLengthEdgeValidator gates on
//                           ADJACENCY, not on global coincidence). Probes that the
//                           validator does not over-reject coincident-but-non-
//                           adjacent vertices, and that when it DOES reject (a
//                           coincidence becomes adjacent) the input is untouched.
//   * `tripleShare`       — fold THREE distinct candidates onto ONE target via
//                           three sequential `shareVertices` applies (incremental
//                           group growth across up to three containers in one
//                           step). Round-4's chainShare only ever did two legs;
//                           this drives the participation gate / prune accounting
//                           across a third consecutive merge onto a growing group.
//
// New algebraic / metamorphic laws checked here (none asserted by earlier passes
// in this exact form / base):
//   * TWO consecutive shared-edge cuts on one container pair mint two DISTINCT
//     ids, each cited exactly twice (a clean share), with the bodies count grown
//     by exactly 2 and no id reused — the second cut reads the live grown state.
//   * unshare-then-move-the-mint: the minted body moves independently of the
//     original (no shared mutable cell); the original body keeps its coordinate.
//   * transferSharing op∘逆op = identity on a disjoint rename reached through the
//     round-7 op stream (re-confirms §4.7 reversibility from a NON-pristine base).
//   * a move onto an existing vertex's coordinate is accepted iff it does not
//     create an adjacent coincidence; on rejection the input is byte-identical.
//   * save∘load = identity across the round-7 op stream.
//   * a rejected round-7 op leaves the input untouched (full rollback).
//   * every-step invariants incl. participation + duplicate-free shared set.
// ===========================================================================

export const SEED7 = 33003;
export const NUM_RUNS7 = 1200;

export type Op7 =
  | { readonly t: 'cutTwice'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'unshareThenMove'; readonly i: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'foldUnfold'; readonly a: number; readonly b: number }
  | { readonly t: 'moveToExisting'; readonly i: number; readonly j: number }
  | { readonly t: 'tripleShare'; readonly c1: number; readonly c2: number; readonly c3: number; readonly tgt: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number }
  | { readonly t: 'edgeCut'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number };

export const op7Arb: fc.Arbitrary<Op7> = fc.oneof(
  fc.record({
    t: fc.constant('cutTwice' as const),
    pIdx: fc.nat(8),
    qIdx: fc.nat(8),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({
    t: fc.constant('unshareThenMove' as const),
    i: fc.nat(20),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({ t: fc.constant('foldUnfold' as const), a: fc.nat(20), b: fc.nat(20) }),
  fc.record({ t: fc.constant('moveToExisting' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('tripleShare' as const), c1: fc.nat(20), c2: fc.nat(20), c3: fc.nat(20), tgt: fc.nat(20) }),
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

export function applyOp7(ctx: ModelCtx, op: Op7): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'cutTwice': {
      const entries = [...ctx.state.containers.values()];
      if (entries.length < 2) return;
      const primary = entries[op.pIdx % entries.length];
      const partner = entries[op.qIdx % entries.length];
      if (primary === undefined || partner === undefined) return;
      const pKey = containerKey(primary.container);
      const qKey = containerKey(partner.container);
      if (pKey === qKey) return;
      // First cut at edge 0 of each container.
      const first = insertSharedEdgeCut(
        ctx.state,
        {
          primary: { containerKey: pKey, edgeStart: 0 },
          partner: { containerKey: qKey, edgeStart: 0 },
          cutCoordinate: createCoordinate(op.lon + 0.5, op.lat + 0.5),
        },
        ctx.idState,
        ctx.clock,
        { validators },
      );
      if (first.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
      ctx.state = first.result.state;
      ctx.idState = first.idState;
      // Second cut: re-derive a real edge from the LIVE (grown) containers.
      const pNow = ctx.state.containers.get(pKey);
      const qNow = ctx.state.containers.get(qKey);
      if (pNow === undefined || qNow === undefined) return;
      const pEdge = realEdgeStart(pNow, op.pIdx + 1);
      const qEdge = realEdgeStart(qNow, op.qIdx + 1);
      if (pEdge === undefined || qEdge === undefined) return;
      const second = insertSharedEdgeCut(
        ctx.state,
        {
          primary: { containerKey: pKey, edgeStart: pEdge },
          partner: { containerKey: qKey, edgeStart: qEdge },
          // Distinct coordinate so neither cut creates a coincident-edge reject.
          cutCoordinate: createCoordinate(op.lon - 0.5, op.lat - 0.5),
        },
        ctx.idState,
        ctx.clock,
        { validators },
      );
      if (second.result.status === SHARED_VERTEX_OUTCOME.Applied) {
        ctx.state = second.result.state;
        ctx.idState = second.idState;
      }
      return;
    }
    case 'unshareThenMove': {
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
      // Move ONLY the freshly minted id.
      const moved = moveVertices(ctx.state, [{ vertexId: newId, coordinate: createCoordinate(op.lon, op.lat) }], {
        validators,
      });
      if (moved.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = moved.state;
      return;
    }
    case 'foldUnfold': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 2) return;
      const a = ids[op.a % ids.length];
      const b = ids[op.b % ids.length];
      if (a === undefined || b === undefined || a === b) return;
      ctx.state = transferSharing(ctx.state, new Map([[a, b]]));
      ctx.state = transferSharing(ctx.state, new Map([[b, a]]));
      return;
    }
    case 'moveToExisting': {
      const shared = sharedVertexIds(ctx.state);
      const vid = pick(shared, op.i);
      if (vid === undefined) return;
      const others = [...new Set(allCitedIds(ctx.state))].filter((id) => id !== vid);
      const targetId = pick(others, op.j);
      if (targetId === undefined) return;
      const targetCoord = getVertex(ctx.state.vertices, targetId)?.coordinate;
      if (targetCoord === undefined) return;
      const res = moveVertices(ctx.state, [{ vertexId: vid, coordinate: targetCoord }], { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'tripleShare': {
      const target0 = pick([...new Set(allCitedIds(ctx.state))], op.tgt);
      if (target0 === undefined) return;
      for (const pickIdx of [op.c1, op.c2, op.c3]) {
        const ids = [...new Set(allCitedIds(ctx.state))];
        const cand = pick(ids, pickIdx);
        if (cand === undefined || cand === target0) continue;
        const r = shareVertices(ctx.state, cand, target0, { validators });
        if (r.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = r.state;
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

// ===========================================================================
// EIGHTH EXPLORATION PASS (bug-hunt round 3 — "発見のみ・修正しない", 第3回).
// A FRESH, INDEPENDENT search with a NEW seed (33004 — disjoint from EVERY
// earlier pass: round-1 seeds 1000-6000 / 3004, round-2 seeds 23001-23004, and
// round-3 seeds 33002 / 33003) and numRuns deliberately raised. The earlier
// passes never:
//   - unshared SEVERAL distinct shared vertices in ONE step (interleaved fan),
//   - moved a vertex EXACTLY onto a non-adjacent same-container neighbour's live
//     coordinate to probe quantized zero-length detection through the linkage,
//   - cut a shared edge and then SHARED the minted cut id onto a THIRD vertex
//     (a different container) in one composite step,
//   - asserted moveVertices COMMUTES with save∘load (the body update is pure
//     plain-data and must survive a round-trip on either side),
//   - asserted unshareReference on a NON-shared vertex's sole reference is a
//     genuine no-op apply that does NOT spuriously birth a shared group, and
//   - asserted that an applied unshare strictly REDUCES the citation count of the
//     original id by exactly one (conservation of citations across the split).
//
// New command kinds:
//   * `fanUnshare`   — split ONE reference off EACH of up to three DISTINCT shared
//                      vertices in a single step (interleaved, re-deriving refs
//                      between legs). Drives the id-mint / reverse-index rebuild
//                      path across multiple simultaneous fans.
//   * `moveToNeighbor` — move a chosen vertex EXACTLY onto the live coordinate of
//                      another vertex that shares one of its containers. The
//                      zeroLengthEdgeValidator must REJECT when the two become
//                      adjacent / quantize-coincident on a ring or line edge, and
//                      the input must be untouched on that rejection.
//   * `cutThenShareThird` — insert a shared-edge cut, then SHARE the minted cut id
//                      onto a third cited vertex of a DIFFERENT container. A mint
//                      followed by a merge of that mint, composed in one step.
//   * `reindexTransfer` — transferSharing folding a cited id onto a target, then
//                      IMMEDIATELY a second fold of a fresh id onto the SAME
//                      target, so the target accrues citations across two folds in
//                      one step (carry-forward / prune run twice back to back).
//
// New algebraic / metamorphic laws checked here (none asserted by earlier passes):
//   * moveVertices COMMUTES with save∘load: load(save(move(s))) ≡
//     move(load(save(s))) for an applied move (plain-data body update is
//     round-trip-stable on either side).
//   * unshareReference on a vertex cited EXACTLY ONCE applies (mints a fresh body
//     and repoints the sole reference) WITHOUT creating a shared group — the
//     original id ends cited zero times, the minted id cited once, neither shared.
//   * an applied unshare conserves citations: refsBefore(original) =
//     refsAfter(original) + 1 (exactly one citation peeled onto the mint).
//   * fully fanning several shared vertices leaves NONE of them shared.
//   * save∘load = identity across the round-8 op stream.
//   * a rejected round-8 op leaves the input untouched (full rollback).
//   * sharedVertexIds is duplicate-free after every op (selection validity).
// ===========================================================================

export const SEED8 = 33004;
export const NUM_RUNS8 = 1200;

export type Op8 =
  | { readonly t: 'fanUnshare'; readonly a: number; readonly b: number; readonly c: number }
  | { readonly t: 'moveToNeighbor'; readonly i: number; readonly j: number }
  | { readonly t: 'cutThenShareThird'; readonly pIdx: number; readonly qIdx: number; readonly tIdx: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'reindexTransfer'; readonly a: number; readonly b: number; readonly tgt: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number }
  | { readonly t: 'edgeCut'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number };

export const op8Arb: fc.Arbitrary<Op8> = fc.oneof(
  fc.record({ t: fc.constant('fanUnshare' as const), a: fc.nat(20), b: fc.nat(20), c: fc.nat(20) }),
  fc.record({ t: fc.constant('moveToNeighbor' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({
    t: fc.constant('cutThenShareThird' as const),
    pIdx: fc.nat(8),
    qIdx: fc.nat(8),
    tIdx: fc.nat(20),
    lon: fc.integer({ min: -179, max: 179 }),
    lat: fc.integer({ min: -85, max: 85 }),
  }),
  fc.record({ t: fc.constant('reindexTransfer' as const), a: fc.nat(20), b: fc.nat(20), tgt: fc.nat(20) }),
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

export function applyOp8(ctx: ModelCtx, op: Op8): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'fanUnshare': {
      // Split ONE reference off EACH of up to three distinct shared vertices,
      // re-deriving the shared set between legs (ids / positions shift as bodies
      // are minted and references repointed).
      for (const pickIdx of [op.a, op.b, op.c]) {
        const shared = sharedVertexIds(ctx.state);
        const vid = pick(shared, pickIdx);
        if (vid === undefined) continue;
        const refs = referencesOf(ctx.state, vid);
        if (refs.length < 2) continue;
        const ref = refs[pickIdx % refs.length];
        if (ref === undefined) continue;
        const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, { validators });
        if (out.result.status === SHARED_VERTEX_OUTCOME.Applied) {
          ctx.state = out.result.state;
          ctx.idState = out.idState;
        }
      }
      return;
    }
    case 'moveToNeighbor': {
      // Move a chosen vertex onto the LIVE coordinate of another cited vertex.
      const ids = [...new Set(allCitedIds(ctx.state))];
      const vid = pick(ids, op.i);
      const other = pick(ids, op.j);
      if (vid === undefined || other === undefined || vid === other) return;
      const target = getVertex(ctx.state.vertices, other);
      if (target === undefined) return;
      const res = moveVertices(ctx.state, [{ vertexId: vid, coordinate: target.coordinate }], { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'cutThenShareThird': {
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
      // Share the minted cut id onto a THIRD cited vertex (merge of the mint).
      const ids = [...new Set(allCitedIds(ctx.state))];
      const third = pick(ids, op.tIdx);
      if (third === undefined || third === cutId) return;
      const merged = shareVertices(ctx.state, cutId, third, { validators });
      if (merged.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = merged.state;
      return;
    }
    case 'reindexTransfer': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 3) return;
      const target = ids[op.tgt % ids.length];
      const a = ids[op.a % ids.length];
      if (target === undefined || a === undefined) return;
      if (a !== target) ctx.state = transferSharing(ctx.state, new Map([[a, target]]));
      // Second fold of a FRESH id onto the SAME target.
      const ids2 = [...new Set(allCitedIds(ctx.state))];
      const b = pick(ids2, op.b);
      if (b === undefined || b === target) return;
      ctx.state = transferSharing(ctx.state, new Map([[b, target]]));
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

// ===========================================================================
// NINTH EXPLORATION PASS (T2 closure bug-hunt — 発見のみ・恒久資産).
// A FRESH, INDEPENDENT search with a NEW seed (43001 — disjoint from EVERY prior
// pass: round-1 1000-6000, round-2 21000-26000 / 23001-23004, round-3
// 31000-36000 / 33002-33004). It introduces command kinds, generators and
// metamorphic laws that NONE of the earlier eight passes exercised. The earlier
// passes covered folds, single/disjoint swaps-by-fold, mint-then-split, move-then-
// unshare, and full fan-out; this pass probes:
//
//   * `transposeRemap`        — transferSharing with a true PERMUTATION
//                               { a -> b, b -> a } (NOT a fold: both ids survive,
//                               their citations swap). No prior pass applied a
//                               permutation remap; every earlier remap was a
//                               collapse (a -> t) or identity. Drives the carry-
//                               forward branch where BOTH remap-to ids already have
//                               bodies (so neither is minted) while BOTH remap-from
//                               ids stay referenced (so neither is pruned).
//   * `reshareOther`          — unshare ONE reference of a shared vertex, then
//                               re-share the freshly minted id onto a DIFFERENT
//                               cited id (not back onto the original). Earlier
//                               passes only ever re-shared the mint back onto its
//                               source (the round-trip identity); folding it onto a
//                               THIRD id exercises a merge whose candidate is a
//                               brand-new single-citation body.
//   * `emptyMove`             — moveVertices with an EMPTY spec list. A no-op move
//                               must APPLY (vacuously) and leave the state content
//                               identical with an empty touched set — a degenerate
//                               input no earlier pass fed the command.
//   * `idempotentShareTwice`  — apply the SAME share(a, t) twice in one step. The
//                               first applies (candidate collapses into target);
//                               the second must REJECT (candidate id no longer
//                               referenced -> NotFound), never re-collapse or
//                               dangle. Probes a duplicated command in one step.
//
// New algebraic / metamorphic laws checked here (none asserted by earlier passes):
//   * transposeRemap is an INVOLUTION: applying the swap { a->b, b->a } twice is
//     the identity on canonical content (a permutation composed with itself = id),
//     AND a single swap conserves the body count (no mint, no prune).
//   * a swap permutation commutes with save∘load (pure plain-data, like folds).
//   * an empty-list move is the identity (applies, touches nothing, content equal).
//   * re-sharing a mint onto a THIRD id keeps every invariant and removes the
//     mint's body (the merge collapses the single-citation mint into the third id).
//   * a repeated identical share rejects the second leg as NotFound and the state
//     after the (single) applied first leg is byte-identical to applying it once.
//   * a rejected NEW op leaves the input state untouched (full rollback) — re-run
//     under the new op alphabet and seed.
//   * sharedVertexIds stays duplicate-free after every op (selection validity).
// ===========================================================================

export const SEED9 = 43001;
export const NUM_RUNS9 = 700;

export type Op9 =
  | { readonly t: 'transposeRemap'; readonly a: number; readonly b: number }
  | { readonly t: 'reshareOther'; readonly i: number; readonly target: number }
  | { readonly t: 'emptyMove' }
  | { readonly t: 'idempotentShareTwice'; readonly i: number; readonly j: number }
  | { readonly t: 'share'; readonly i: number; readonly j: number }
  | { readonly t: 'unshare'; readonly i: number }
  | { readonly t: 'move'; readonly i: number; readonly lon: number; readonly lat: number }
  | { readonly t: 'edgeCut'; readonly pIdx: number; readonly qIdx: number; readonly lon: number; readonly lat: number };

export const op9Arb: fc.Arbitrary<Op9> = fc.oneof(
  fc.record({ t: fc.constant('transposeRemap' as const), a: fc.nat(20), b: fc.nat(20) }),
  fc.record({ t: fc.constant('reshareOther' as const), i: fc.nat(20), target: fc.nat(20) }),
  fc.record({ t: fc.constant('emptyMove' as const) }),
  fc.record({ t: fc.constant('idempotentShareTwice' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('share' as const), i: fc.nat(20), j: fc.nat(20) }),
  fc.record({ t: fc.constant('unshare' as const), i: fc.nat(20) }),
  fc.record({
    t: fc.constant('move' as const),
    i: fc.nat(20),
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
);

export function applyOp9(ctx: ModelCtx, op: Op9): void {
  const validators = [zeroLengthEdgeValidator];
  switch (op.t) {
    case 'transposeRemap': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      if (ids.length < 2) return;
      const a = ids[op.a % ids.length];
      const b = ids[op.b % ids.length];
      if (a === undefined || b === undefined || a === b) return;
      // A true permutation: swap the two ids. Both survive; their citations swap.
      ctx.state = transferSharing(ctx.state, new Map([[a, b], [b, a]]));
      return;
    }
    case 'reshareOther': {
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
      const mint = split.newVertexId;
      if (mint === undefined) return;
      // Re-share the mint onto a DIFFERENT cited id (not the original it split from).
      const others = [...new Set(allCitedIds(ctx.state))].filter((id) => id !== mint && id !== vid);
      const targ = pick(others, op.target);
      if (targ === undefined) return;
      const back = shareVertices(ctx.state, mint, targ, { validators });
      if (back.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = back.state;
      return;
    }
    case 'emptyMove': {
      const res = moveVertices(ctx.state, [], { validators });
      if (res.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = res.state;
      return;
    }
    case 'idempotentShareTwice': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const cand = pick(ids, op.i);
      const targ = pick(ids, op.j);
      if (cand === undefined || targ === undefined || cand === targ) return;
      const r1 = shareVertices(ctx.state, cand, targ, { validators });
      if (r1.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = r1.state;
      // Second identical share: candidate is now unreferenced -> must reject.
      const r2 = shareVertices(ctx.state, cand, targ, { validators });
      if (r2.status === SHARED_VERTEX_OUTCOME.Applied) ctx.state = r2.state;
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
    case 'move': {
      const ids = [...new Set(allCitedIds(ctx.state))];
      const vid = pick(ids, op.i);
      if (vid === undefined) return;
      const res = moveVertices(ctx.state, [{ vertexId: vid, coordinate: createCoordinate(op.lon, op.lat) }], { validators });
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
  }
}
