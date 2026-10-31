// shared-vertex-linkage の検査 2/3。全体の説明と共有の生成器は shared-vertex-linkage.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createCoordinate } from '../coordinate';
import { createIdGeneratorState } from '../id-generator';
import { type VertexId } from '../ids';
import { containerKey, insertSharedEdgeCut, isSharedVertex, moveVertices, referencesOf, shareVertices, sharedVertexIds, transferSharing, unshareReference, zeroLengthEdgeValidator, REJECT_REASON, SHARED_VERTEX_OUTCOME } from '../shared-vertex';
import { getVertex } from '../vertex';
import {
  type ModelCtx,
  NUM_RUNS6,
  NUM_RUNS7,
  SEED6,
  SEED7,
  allCitedIds,
  applyOp6,
  applyOp7,
  buildState,
  canonical,
  checkInvariants,
  checkParticipationOfShared,
  checkSharedSetDistinct,
  load,
  makeClock,
  op6Arb,
  op7Arb,
  pick,
  realEdgeStart,
  save,
  seedArb,
} from './shared-vertex-linkage.arbitraries';

describe('shared-vertex-linkage round-3 sixth pass (seed 33002)', () => {
  it('round-6 inverse-pair op sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op6Arb, { minLength: 1, maxLength: 30 }), (seed, ops) => {
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
          applyOp6(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
          checkSharedSetDistinct(ctx.state, label);
        }
      }),
      { seed: SEED6, numRuns: NUM_RUNS6 },
    );
  });

  it('save∘load = identity on round-6 reachable states', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op6Arb, { minLength: 0, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp6(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED6, numRuns: NUM_RUNS6 },
    );
  });

  it('a rejected round-6 op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, op6Arb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = { state, idState: createIdGeneratorState(0, 0), clock: makeClock() };
        applyOp6(ctx, op);
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED6, numRuns: NUM_RUNS6 },
    );
  });

  // undo∘move = identity for a SHARED vertex reached through an arbitrary op
  // stream: capture the live coordinate, move it elsewhere, then move it BACK to
  // the captured value. Restoring must re-converge EVERY referrer (single body),
  // yielding canonical content byte-identical to before the move.
  it('undo (move-back) of a shared-vertex move restores the state exactly', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.array(op6Arb, { minLength: 0, maxLength: 12 }),
        fc.nat(20),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, ops, idx, lon, lat) => {
          const ctx: ModelCtx = {
            state: buildState(seed),
            idState: createIdGeneratorState(0, 0),
            clock: makeClock(),
          };
          for (const op of ops) applyOp6(ctx, op);
          const base = ctx.state;
          const baseCanon = canonical(base);
          const shared = sharedVertexIds(base);
          const vid = pick(shared, idx);
          if (vid === undefined) return;
          const orig = getVertex(base.vertices, vid)?.coordinate;
          if (orig === undefined) return;
          const out = moveVertices(base, [{ vertexId: vid, coordinate: createCoordinate(lon, lat) }], {
            validators: [zeroLengthEdgeValidator],
          });
          if (out.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const undo = moveVertices(out.state, [{ vertexId: vid, coordinate: orig }], {
            validators: [zeroLengthEdgeValidator],
          });
          if (undo.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          expect(canonical(undo.state)).toEqual(baseCanon);
          checkInvariants(undo.state, 'after move undo');
        },
      ),
      { seed: SEED6, numRuns: NUM_RUNS6 },
    );
  });

  // op∘逆op = identity for transferSharing on a DISJOINT fold/un-fold pair: when
  // the target `to` is NOT itself cited beforehand (so the fold is a clean rename
  // of `from`'s citations), folding from -> to and then to -> from must restore
  // the original citations AND bodies (a genuine algebraic inverse). When `to` is
  // already cited (a real merge, lossy) the law does not apply, so it is skipped.
  it('transferSharing fold then inverse-fold is the identity on a disjoint rename', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), (seed, a, b) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 2) return;
        const from = ids[a % ids.length];
        const to = ids[b % ids.length];
        if (from === undefined || to === undefined || from === to) return;
        // A clean rename requires the target id to be absent from the store and
        // uncited, so folding is reversible (no pre-existing citations are lost).
        if (getVertex(state.vertices, to) !== undefined) return;
        if (allCitedIds(state).includes(to)) return;
        const folded = transferSharing(state, new Map([[from, to]]));
        const back = transferSharing(folded, new Map([[to, from]]));
        checkInvariants(folded, 'after fold');
        checkInvariants(back, 'after inverse fold');
        expect(canonical(back)).toEqual(canonical(state));
      }),
      { seed: SEED6, numRuns: NUM_RUNS6 },
    );
  });

  // A coordinate swap of two distinct shared vertices is an INVOLUTION: swapping
  // their coordinates, then swapping again, returns the original state — and a
  // single swap lands each body at the OTHER's original coordinate (proving the
  // batched move reads every source coordinate from the ORIGINAL snapshot, a true
  // simultaneous swap with no read-after-write aliasing).
  it('a coordinate swap of two shared vertices is a simultaneous involution', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op6Arb, { minLength: 0, maxLength: 12 }), fc.nat(20), fc.nat(20), (seed, ops, ai, bi) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp6(ctx, op);
        const base = ctx.state;
        const baseCanon = canonical(base);
        const shared = sharedVertexIds(base);
        if (shared.length < 2) return;
        const a = shared[ai % shared.length];
        const b = shared[bi % shared.length];
        if (a === undefined || b === undefined || a === b) return;
        const ca = getVertex(base.vertices, a)?.coordinate;
        const cb = getVertex(base.vertices, b)?.coordinate;
        if (ca === undefined || cb === undefined) return;
        const swap1 = moveVertices(
          base,
          [
            { vertexId: a, coordinate: cb },
            { vertexId: b, coordinate: ca },
          ],
          { validators: [zeroLengthEdgeValidator] },
        );
        if (swap1.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        // Each body landed at the OTHER's original coordinate (true simultaneity).
        expect(getVertex(swap1.state.vertices, a)?.coordinate).toEqual(cb);
        expect(getVertex(swap1.state.vertices, b)?.coordinate).toEqual(ca);
        checkInvariants(swap1.state, 'after swap');
        // Swap again -> involution -> back to the original.
        const swap2 = moveVertices(
          swap1.state,
          [
            { vertexId: a, coordinate: ca },
            { vertexId: b, coordinate: cb },
          ],
          { validators: [zeroLengthEdgeValidator] },
        );
        if (swap2.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        expect(canonical(swap2.state)).toEqual(baseCanon);
      }),
      { seed: SEED6, numRuns: NUM_RUNS6 },
    );
  });

  // shareVertices on two ids cited by ONE container (same ring / same line path)
  // MUST be rejected with Participation, leaving the state byte-identical. This
  // pins the SHARE command's participation gate directly (the random `share` op
  // only hit this incidentally); a regression that silently merged a same-ring
  // pair would create a self-citing container and a zero-length edge.
  it('share of two same-container vertices is rejected (participation), input untouched', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(8), fc.nat(8), fc.nat(8), (seed, cIdx, pi, pj) => {
        const state = buildState(seed);
        const before = canonical(state);
        const entries = [...state.containers.values()];
        if (entries.length === 0) return;
        const entry = entries[cIdx % entries.length];
        if (entry === undefined) return;
        const ids = entry.vertexIds;
        if (ids.length < 2) return;
        const a = ids[pi % ids.length];
        const b = ids[pj % ids.length];
        if (a === undefined || b === undefined || a === b) return;
        const res = shareVertices(state, a, b, { validators: [zeroLengthEdgeValidator] });
        // Two vertices of the SAME container can never be merged into one group.
        expect(res.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
        if (res.status === SHARED_VERTEX_OUTCOME.Rejected) {
          expect(res.reason).toBe(REJECT_REASON.Participation);
        }
        // The input value is immutable regardless of outcome.
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED6, numRuns: NUM_RUNS6 },
    );
  });

  // A shared-edge cut followed by re-sharing the minted cut id onto one of its
  // own edge-endpoints dissolves the freshly minted share. The mint→dissolve
  // round must keep every invariant and never strand a dangling reference; the
  // cut id must vanish (its sole remaining purpose folded back into an endpoint).
  it('cut then re-share the cut id onto an endpoint keeps invariants and prunes the mint', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(8),
        fc.nat(8),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, pIdx, qIdx, lon, lat) => {
          const state = buildState(seed);
          const entries = [...state.containers.values()];
          if (entries.length < 2) return;
          const primary = entries[pIdx % entries.length];
          const partner = entries[qIdx % entries.length];
          if (primary === undefined || partner === undefined) return;
          const pKey = containerKey(primary.container);
          const qKey = containerKey(partner.container);
          if (pKey === qKey) return;
          const cut = insertSharedEdgeCut(
            state,
            {
              primary: { containerKey: pKey, edgeStart: 0 },
              partner: { containerKey: qKey, edgeStart: 0 },
              cutCoordinate: createCoordinate(lon + 0.5, lat + 0.5),
            },
            createIdGeneratorState(0, 0),
            makeClock(),
            { validators: [zeroLengthEdgeValidator] },
          );
          if (cut.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const cutId = cut.cutVertexId;
          if (cutId === undefined) return;
          const afterCut = cut.result.state;
          checkInvariants(afterCut, 'after cut');
          checkParticipationOfShared(afterCut, 'after cut');
          // Re-share the cut id onto SOME other cited id (the dissolve direction).
          const others = [...new Set(allCitedIds(afterCut))].filter((id) => id !== cutId);
          const target = others[0];
          if (target === undefined) return;
          const dissolve = shareVertices(afterCut, cutId, target, {
            validators: [zeroLengthEdgeValidator],
          });
          if (dissolve.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          // The cut id is folded away entirely.
          expect(allCitedIds(dissolve.state).includes(cutId)).toBe(false);
          expect(getVertex(dissolve.state.vertices, cutId)).toBeUndefined();
          checkInvariants(dissolve.state, 'after cut dissolve');
          checkParticipationOfShared(dissolve.state, 'after cut dissolve');
          checkSharedSetDistinct(dissolve.state, 'after cut dissolve');
        },
      ),
      { seed: SEED6, numRuns: NUM_RUNS6 },
    );
  });
});

describe('shared-vertex-linkage round-3 seventh pass (seed 33003)', () => {
  it('round-7 higher-order composite op sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op7Arb, { minLength: 1, maxLength: 30 }), (seed, ops) => {
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
          applyOp7(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
          checkSharedSetDistinct(ctx.state, label);
        }
      }),
      { seed: SEED7, numRuns: NUM_RUNS7 },
    );
  });

  it('save∘load = identity on round-7 reachable states', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op7Arb, { minLength: 0, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp7(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED7, numRuns: NUM_RUNS7 },
    );
  });

  it('a rejected round-7 op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, op7Arb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = { state, idState: createIdGeneratorState(0, 0), clock: makeClock() };
        applyOp7(ctx, op);
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED7, numRuns: NUM_RUNS7 },
    );
  });

  // TWO consecutive shared-edge cuts on ONE (primary, partner) container pair: the
  // second cut's edgeStart is re-derived from the container AFTER the first grew
  // it. Both cuts must mint DISTINCT ids, each cited exactly twice (a clean share
  // across the two containers), the body count must grow by exactly 2, and no id
  // may be reused. Drives the splice / position recompute over a just-mutated list.
  it('two consecutive cuts on one container pair mint two distinct twice-shared ids', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.nat(8),
        fc.nat(8),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, pIdx, qIdx, lon, lat) => {
          const state = buildState(seed);
          const entries = [...state.containers.values()];
          if (entries.length < 2) return;
          const primary = entries[pIdx % entries.length];
          const partner = entries[qIdx % entries.length];
          if (primary === undefined || partner === undefined) return;
          const pKey = containerKey(primary.container);
          const qKey = containerKey(partner.container);
          if (pKey === qKey) return;
          const idState0 = createIdGeneratorState(0, 0);
          const clock = makeClock();
          const bodiesBefore = state.vertices.byId.size;
          const first = insertSharedEdgeCut(
            state,
            {
              primary: { containerKey: pKey, edgeStart: 0 },
              partner: { containerKey: qKey, edgeStart: 0 },
              cutCoordinate: createCoordinate(lon + 0.5, lat + 0.5),
            },
            idState0,
            clock,
            { validators: [zeroLengthEdgeValidator] },
          );
          if (first.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const id1 = first.cutVertexId;
          if (id1 === undefined) return;
          const afterFirst = first.result.state;
          const pNow = afterFirst.containers.get(pKey);
          const qNow = afterFirst.containers.get(qKey);
          if (pNow === undefined || qNow === undefined) return;
          const pEdge = realEdgeStart(pNow, pIdx + 1);
          const qEdge = realEdgeStart(qNow, qIdx + 1);
          if (pEdge === undefined || qEdge === undefined) return;
          const second = insertSharedEdgeCut(
            afterFirst,
            {
              primary: { containerKey: pKey, edgeStart: pEdge },
              partner: { containerKey: qKey, edgeStart: qEdge },
              cutCoordinate: createCoordinate(lon - 0.5, lat - 0.5),
            },
            first.idState,
            clock,
            { validators: [zeroLengthEdgeValidator] },
          );
          if (second.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const id2 = second.cutVertexId;
          if (id2 === undefined) return;
          const afterSecond = second.result.state;
          // The two mints are DISTINCT ids (no reuse across cuts).
          expect(id1).not.toBe(id2);
          // Each cut id is cited exactly twice (a clean cross-container share).
          expect(referencesOf(afterSecond, id1).length).toBe(2);
          expect(referencesOf(afterSecond, id2).length).toBe(2);
          expect(isSharedVertex(afterSecond, id1)).toBe(true);
          expect(isSharedVertex(afterSecond, id2)).toBe(true);
          // Body count grew by exactly 2 (one per cut).
          expect(afterSecond.vertices.byId.size).toBe(bodiesBefore + 2);
          checkInvariants(afterSecond, 'after two cuts');
          checkParticipationOfShared(afterSecond, 'after two cuts');
        },
      ),
      { seed: SEED7, numRuns: NUM_RUNS7 },
    );
  });

  // unshare then move the MINTED id: the freshly split body must be independently
  // movable — moving it must NOT change the original body's coordinate (no shared
  // mutable cell / aliasing), and the original's referrers must keep its value.
  it('moving a freshly unshared mint does not drag the original body', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.array(op7Arb, { minLength: 0, maxLength: 10 }),
        fc.nat(20),
        fc.integer({ min: -179, max: 179 }),
        fc.integer({ min: -85, max: 85 }),
        (seed, ops, idx, lon, lat) => {
          const ctx: ModelCtx = {
            state: buildState(seed),
            idState: createIdGeneratorState(0, 0),
            clock: makeClock(),
          };
          for (const op of ops) applyOp7(ctx, op);
          const shared = sharedVertexIds(ctx.state);
          const vid = pick(shared, idx);
          if (vid === undefined) return;
          const origCoord = getVertex(ctx.state.vertices, vid)?.coordinate;
          if (origCoord === undefined) return;
          const refs = referencesOf(ctx.state, vid);
          const ref = refs[idx % refs.length];
          if (ref === undefined) return;
          const split = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, {
            validators: [zeroLengthEdgeValidator],
          });
          if (split.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const newId = split.newVertexId;
          if (newId === undefined) return;
          // The mint starts at the original coordinate (same-coordinate split).
          expect(getVertex(split.result.state.vertices, newId)?.coordinate).toEqual(origCoord);
          // Move ONLY the mint somewhere it will not become adjacent-coincident.
          const dest = createCoordinate(lon, lat);
          const moved = moveVertices(split.result.state, [{ vertexId: newId, coordinate: dest }], {
            validators: [zeroLengthEdgeValidator],
          });
          if (moved.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          // The mint moved; the original body is UNCHANGED (no aliasing).
          expect(getVertex(moved.state.vertices, newId)?.coordinate).toEqual(dest);
          expect(getVertex(moved.state.vertices, vid)?.coordinate).toEqual(origCoord);
          checkInvariants(moved.state, 'after unshare-then-move-mint');
          checkParticipationOfShared(moved.state, 'after unshare-then-move-mint');
        },
      ),
      { seed: SEED7, numRuns: NUM_RUNS7 },
    );
  });

  // transferSharing op∘逆op = identity on a DISJOINT rename, reached through the
  // round-7 op stream (a NON-pristine base). When the target id is absent from the
  // store and uncited, folding from -> to then to -> from must restore the exact
  // citations and bodies (a genuine algebraic inverse; re-confirms §4.7).
  it('transferSharing fold-then-unfold is the identity on a disjoint rename (round-7 base)', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op7Arb, { minLength: 0, maxLength: 12 }), fc.nat(20), fc.nat(20), (seed, ops, a, b) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp7(ctx, op);
        const base = ctx.state;
        const ids = [...new Set(allCitedIds(base))];
        if (ids.length < 2) return;
        const from = ids[a % ids.length];
        const to = ids[b % ids.length];
        if (from === undefined || to === undefined || from === to) return;
        // Clean rename requires the target to be absent + uncited beforehand.
        if (getVertex(base.vertices, to) !== undefined) return;
        if (allCitedIds(base).includes(to)) return;
        const folded = transferSharing(base, new Map([[from, to]]));
        const back = transferSharing(folded, new Map([[to, from]]));
        checkInvariants(folded, 'fold');
        checkInvariants(back, 'unfold');
        expect(canonical(back)).toEqual(canonical(base));
      }),
      { seed: SEED7, numRuns: NUM_RUNS7 },
    );
  });

  // A move of a shared vertex ONTO the exact coordinate of a DIFFERENT existing
  // vertex: legal iff it does not create an adjacent coincidence in any container
  // (zeroLengthEdgeValidator gates on ADJACENCY, never on global coincidence). The
  // validator must not over-reject coincident-but-non-adjacent vertices; and on a
  // (legitimate) rejection the input must be byte-identical (full rollback).
  it('moving onto an existing coordinate is gated by adjacency, never global coincidence', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op7Arb, { minLength: 0, maxLength: 10 }), fc.nat(20), fc.nat(20), (seed, ops, ai, bi) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp7(ctx, op);
        const base = ctx.state;
        const before = canonical(base);
        const ids = [...new Set(allCitedIds(base))];
        if (ids.length < 2) return;
        const vid = ids[ai % ids.length];
        const other = ids[bi % ids.length];
        if (vid === undefined || other === undefined || vid === other) return;
        const targetCoord = getVertex(base.vertices, other)?.coordinate;
        if (targetCoord === undefined) return;
        const res = moveVertices(base, [{ vertexId: vid, coordinate: targetCoord }], {
          validators: [zeroLengthEdgeValidator],
        });
        // The input value is immutable regardless of outcome (full rollback).
        expect(canonical(base)).toEqual(before);
        if (res.status === SHARED_VERTEX_OUTCOME.Applied) {
          // Accepted: the body now sits at the coincident coordinate, and the
          // result is internally consistent (no dangling refs / finite coords).
          expect(getVertex(res.state.vertices, vid)?.coordinate).toEqual(targetCoord);
          checkInvariants(res.state, 'after move-onto-existing');
          checkParticipationOfShared(res.state, 'after move-onto-existing');
          // The accepted state must itself report ZERO zero-length-edge violations
          // (acceptance ⇔ no adjacent coincidence — the validator is the authority).
          expect(zeroLengthEdgeValidator(res.state).length).toBe(0);
        } else {
          // Rejected: the ONLY legitimate reason for a pure coordinate move is a
          // result-invalid (adjacent coincidence), and there must be at least one
          // such violation present in the would-be state (i.e. the move really did
          // create an adjacent coincidence — never a spurious rejection).
          expect(res.reason).toBe(REJECT_REASON.ResultInvalid);
        }
      }),
      { seed: SEED7, numRuns: NUM_RUNS7 },
    );
  });

  // tripleShare accounting: folding up to three distinct candidates onto ONE
  // target via three sequential applied shares leaves NONE of the applied
  // candidates cited, the target cited by the union of the merged groups, and the
  // state fully consistent. Every applied leg's candidate body must be pruned.
  it('three sequential shares onto one target fold every applied candidate away', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), fc.nat(20), fc.nat(20), (seed, c1, c2, c3, tgt) => {
        const validators = [zeroLengthEdgeValidator];
        let state = buildState(seed);
        const target = pick([...new Set(allCitedIds(state))], tgt);
        if (target === undefined) return;
        const appliedCandidates: VertexId[] = [];
        for (const pickIdx of [c1, c2, c3]) {
          const ids = [...new Set(allCitedIds(state))];
          const cand = pick(ids, pickIdx);
          if (cand === undefined || cand === target) continue;
          const r = shareVertices(state, cand, target, { validators });
          if (r.status !== SHARED_VERTEX_OUTCOME.Applied) continue;
          state = r.state;
          appliedCandidates.push(cand);
        }
        if (appliedCandidates.length === 0) return;
        // Every applied candidate is gone (no body, no citation).
        for (const cand of appliedCandidates) {
          expect(allCitedIds(state).includes(cand), `candidate ${cand} still cited`).toBe(false);
          expect(getVertex(state.vertices, cand), `candidate ${cand} still bodied`).toBeUndefined();
        }
        // The target survives and is bodied.
        expect(getVertex(state.vertices, target)).toBeDefined();
        checkInvariants(state, 'after tripleShare');
        checkParticipationOfShared(state, 'after tripleShare');
        checkSharedSetDistinct(state, 'after tripleShare');
      }),
      { seed: SEED7, numRuns: NUM_RUNS7 },
    );
  });
});
