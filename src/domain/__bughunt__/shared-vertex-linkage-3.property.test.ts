// shared-vertex-linkage の検査 3/3。全体の説明と共有の生成器は shared-vertex-linkage.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { createCoordinate } from '../coordinate';
import { createIdGeneratorState } from '../id-generator';
import { type VertexId } from '../ids';
import { isSharedVertex, moveVertices, referencesOf, shareVertices, sharedVertexIds, transferSharing, unshareReference, zeroLengthEdgeValidator, REJECT_REASON, SHARED_VERTEX_OUTCOME } from '../shared-vertex';
import { getVertex } from '../vertex';
import {
  type ModelCtx,
  NUM_RUNS8,
  NUM_RUNS9,
  SEED8,
  SEED9,
  allCitedIds,
  applyOp8,
  applyOp9,
  buildState,
  canonical,
  checkInvariants,
  checkParticipationOfShared,
  checkSharedSetDistinct,
  load,
  makeClock,
  op8Arb,
  op9Arb,
  pick,
  save,
  seedArb,
} from './shared-vertex-linkage.arbitraries';

describe('shared-vertex-linkage round-3 eighth pass (seed 33004)', () => {
  it('round-8 new-op random sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op8Arb, { minLength: 1, maxLength: 30 }), (seed, ops) => {
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
          applyOp8(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
          checkSharedSetDistinct(ctx.state, label);
        }
      }),
      { seed: SEED8, numRuns: NUM_RUNS8 },
    );
  });

  it('save∘load = identity on round-8 reachable states', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op8Arb, { minLength: 0, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp8(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED8, numRuns: NUM_RUNS8 },
    );
  });

  it('a rejected round-8 op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, op8Arb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = { state, idState: createIdGeneratorState(0, 0), clock: makeClock() };
        applyOp8(ctx, op);
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED8, numRuns: NUM_RUNS8 },
    );
  });

  // moveVertices COMMUTES with save∘load: the body update is pure plain-data, so a
  // JSON round-trip before or after an applied move yields byte-identical content.
  it('moveVertices commutes with save∘load', () => {
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
          const coord = createCoordinate(lon, lat);
          // move THEN round-trip.
          const movedThenLoaded = moveVertices(state, [{ vertexId: vid, coordinate: coord }], { validators: [zeroLengthEdgeValidator] });
          if (movedThenLoaded.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const left = load(save(movedThenLoaded.state));
          // round-trip THEN move.
          const reloaded = load(save(state));
          const movedAfter = moveVertices(reloaded, [{ vertexId: vid, coordinate: coord }], { validators: [zeroLengthEdgeValidator] });
          if (movedAfter.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          checkInvariants(left, 'move-then-load');
          checkInvariants(movedAfter.state, 'load-then-move');
          expect(canonical(left)).toEqual(canonical(movedAfter.state));
        },
      ),
      { seed: SEED8, numRuns: NUM_RUNS8 },
    );
  });

  // Unsharing the SOLE reference of a NON-shared vertex still applies (mints a
  // fresh same-coordinate body, repoints the only reference), but must NOT birth a
  // spurious shared group: the original id ends cited zero times, the minted id
  // cited exactly once, and neither is shared.
  it('unshare of a non-shared vertex repoints its sole reference without sharing', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), (seed, idx) => {
        const state = buildState(seed);
        // Pick a cited id that is NOT shared (cited exactly once).
        const counts = new Map<VertexId, number>();
        for (const id of allCitedIds(state)) counts.set(id, (counts.get(id) ?? 0) + 1);
        const singles = [...counts.entries()].filter(([, c]) => c === 1).map(([id]) => id);
        const vid = pick(singles, idx);
        if (vid === undefined) return;
        const refs = referencesOf(state, vid);
        expect(refs.length).toBe(1);
        const ref = refs[0];
        if (ref === undefined) return;
        const out = unshareReference(state, vid, ref, createIdGeneratorState(0, 0), makeClock(), {
          validators: [zeroLengthEdgeValidator],
        });
        if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        const newId = out.newVertexId;
        expect(newId).toBeDefined();
        if (newId === undefined) return;
        // The original id is now cited zero times; the minted id cited once.
        expect(allCitedIds(out.result.state).includes(vid)).toBe(false);
        expect(referencesOf(out.result.state, newId).length).toBe(1);
        // Neither is shared (no spurious group birthed).
        expect(isSharedVertex(out.result.state, vid)).toBe(false);
        expect(isSharedVertex(out.result.state, newId)).toBe(false);
        checkInvariants(out.result.state, 'after non-shared unshare');
        checkSharedSetDistinct(out.result.state, 'after non-shared unshare');
      }),
      { seed: SEED8, numRuns: NUM_RUNS8 },
    );
  });

  // Citation conservation: an applied unshare peels EXACTLY one citation off the
  // original id onto the freshly minted id — refsBefore(orig) === refsAfter(orig)
  // + 1, and the minted id is cited exactly once.
  it('an applied unshare conserves citations (peels exactly one onto the mint)', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op8Arb, { minLength: 0, maxLength: 12 }), fc.nat(20), (seed, ops, idx) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp8(ctx, op);
        const shared = sharedVertexIds(ctx.state);
        const vid = pick(shared, idx);
        if (vid === undefined) return;
        const refsBefore = referencesOf(ctx.state, vid).length;
        if (refsBefore < 2) return;
        const ref = referencesOf(ctx.state, vid)[idx % refsBefore];
        if (ref === undefined) return;
        const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, {
          validators: [zeroLengthEdgeValidator],
        });
        if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        const newId = out.newVertexId;
        if (newId === undefined) return;
        const refsAfter = referencesOf(out.result.state, vid).length;
        expect(refsAfter).toBe(refsBefore - 1);
        expect(referencesOf(out.result.state, newId).length).toBe(1);
        checkInvariants(out.result.state, 'after conserving unshare');
        checkParticipationOfShared(out.result.state, 'after conserving unshare');
      }),
      { seed: SEED8, numRuns: NUM_RUNS8 },
    );
  });

  // Fully fanning several shared vertices: split off references (last-ref first)
  // from EACH currently-shared vertex until none remain shared. The end state must
  // have an EMPTY shared set, and every invariant must hold throughout.
  it('fanning every shared vertex apart leaves an empty shared set', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op8Arb, { minLength: 0, maxLength: 12 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp8(ctx, op);
        // Repeatedly peel the last ref off each shared vertex until none are left.
        let guard = 0;
        while (guard < 64) {
          guard += 1;
          const shared = sharedVertexIds(ctx.state);
          if (shared.length === 0) break;
          const vid = shared[0];
          if (vid === undefined) break;
          const refs = referencesOf(ctx.state, vid);
          if (refs.length < 2) break;
          const ref = refs[refs.length - 1];
          if (ref === undefined) break;
          const out = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, {
            validators: [zeroLengthEdgeValidator],
          });
          if (out.result.status !== SHARED_VERTEX_OUTCOME.Applied) break; // a leg rejected
          ctx.state = out.result.state;
          ctx.idState = out.idState;
        }
        // If the loop terminated cleanly (no rejection), the shared set is empty.
        if (sharedVertexIds(ctx.state).length === 0) {
          checkInvariants(ctx.state, 'after full fan');
          checkParticipationOfShared(ctx.state, 'after full fan');
          checkSharedSetDistinct(ctx.state, 'after full fan');
        }
      }),
      { seed: SEED8, numRuns: NUM_RUNS8 },
    );
  });

  // moveToNeighbor: moving a vertex EXACTLY onto a same-container neighbour's live
  // coordinate must be REJECTED by the zero-length-edge validator when the two are
  // adjacent (or quantize-coincident) on a ring / line edge — and the input must
  // be untouched on that rejection (immutability + full rollback).
  it('moving onto an adjacent same-container neighbour is rejected (zero-length edge), input untouched', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(8), (seed, cIdx) => {
        const state = buildState(seed);
        const before = canonical(state);
        const entries = [...state.containers.values()];
        const entry = entries[cIdx % Math.max(1, entries.length)];
        if (entry === undefined || entry.vertexIds.length < 2) return;
        // Take two ADJACENT positions in the container.
        const a = entry.vertexIds[0];
        const b = entry.vertexIds[1];
        if (a === undefined || b === undefined || a === b) return;
        const bodyB = getVertex(state.vertices, b);
        if (bodyB === undefined) return;
        // Move `a` onto `b`'s coordinate -> the a->b edge collapses to zero length.
        const res = moveVertices(state, [{ vertexId: a, coordinate: bodyB.coordinate }], {
          validators: [zeroLengthEdgeValidator],
        });
        expect(res.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
        if (res.status === SHARED_VERTEX_OUTCOME.Rejected) {
          expect(res.reason).toBe(REJECT_REASON.ResultInvalid);
        }
        // The input state object is unchanged (immutability).
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED8, numRuns: NUM_RUNS8 },
    );
  });
});

describe('shared-vertex-linkage round-4 ninth pass (seed 43001)', () => {
  it('round-9 permutation/composite op sequences preserve all invariants after every step', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op9Arb, { minLength: 1, maxLength: 30 }), (seed, ops) => {
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
          applyOp9(ctx, op);
          step += 1;
          const label = `after step ${step} (${op.t})`;
          checkInvariants(ctx.state, label);
          checkParticipationOfShared(ctx.state, label);
          checkSharedSetDistinct(ctx.state, label);
        }
      }),
      { seed: SEED9, numRuns: NUM_RUNS9 },
    );
  });

  it('save∘load = identity on round-9 reachable states', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op9Arb, { minLength: 0, maxLength: 25 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp9(ctx, op);
        const restored = load(save(ctx.state));
        expect(canonical(restored)).toEqual(canonical(ctx.state));
        expect(canonical(load(save(restored)))).toEqual(canonical(ctx.state));
      }),
      { seed: SEED9, numRuns: NUM_RUNS9 },
    );
  });

  it('a rejected round-9 op leaves the input state untouched (full rollback)', () => {
    fc.assert(
      fc.property(seedArb, op9Arb, (seed, op) => {
        const state = buildState(seed);
        const before = canonical(state);
        const ctx: ModelCtx = { state, idState: createIdGeneratorState(0, 0), clock: makeClock() };
        applyOp9(ctx, op);
        expect(canonical(state)).toEqual(before);
      }),
      { seed: SEED9, numRuns: NUM_RUNS9 },
    );
  });

  // transposeRemap is an INVOLUTION: applying the swap { a->b, b->a } twice returns
  // the original canonical content, AND a single swap mints/prunes nothing (both
  // ids already have bodies and both stay referenced).
  it('a swap permutation remap is an involution and conserves the body count', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), (seed, ai, bi) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 2) return;
        const a = ids[ai % ids.length];
        const b = ids[bi % ids.length];
        if (a === undefined || b === undefined || a === b) return;
        const swap = new Map<VertexId, VertexId>([[a, b], [b, a]]);
        const before = canonical(state);
        const beforeBodies = state.vertices.byId.size;
        const once = transferSharing(state, swap);
        checkInvariants(once, 'after one swap');
        checkParticipationOfShared(once, 'after one swap');
        // A swap conserves bodies (no mint of a new id, no prune of an old one):
        // both a and b already had bodies and both remain referenced after the swap.
        expect(once.vertices.byId.size).toBe(beforeBodies);
        // Both ids still resolve to bodies (single source of truth across the swap).
        expect(getVertex(once.vertices, a)).toBeDefined();
        expect(getVertex(once.vertices, b)).toBeDefined();
        // Involution: swapping again restores the original canonical content.
        const twice = transferSharing(once, swap);
        expect(canonical(twice)).toEqual(before);
      }),
      { seed: SEED9, numRuns: NUM_RUNS9 },
    );
  });

  // A swap permutation commutes with save∘load (pure plain-data fold, like every
  // other transferSharing remap): round-trip before or after the swap agree.
  it('a swap permutation commutes with save∘load', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), (seed, ai, bi) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 2) return;
        const a = ids[ai % ids.length];
        const b = ids[bi % ids.length];
        if (a === undefined || b === undefined || a === b) return;
        const swap = new Map<VertexId, VertexId>([[a, b], [b, a]]);
        const swapThenLoad = load(save(transferSharing(state, swap)));
        const loadThenSwap = transferSharing(load(save(state)), swap);
        checkInvariants(swapThenLoad, 'swap-then-load');
        checkInvariants(loadThenSwap, 'load-then-swap');
        expect(canonical(swapThenLoad)).toEqual(canonical(loadThenSwap));
      }),
      { seed: SEED9, numRuns: NUM_RUNS9 },
    );
  });

  // An EMPTY-list move never MUTATES the state and never mints / deletes a body.
  // Two outcomes are legitimate and both are pinned here:
  //   * APPLIED — the reached state is already validator-clean: the move touches
  //     nothing (empty touched / created / deleted sets) and the content is equal;
  //   * REJECTED(ResultInvalid) — a prior transferSharing left a LATENT zero-length
  //     edge in the reached state (transferSharing is a pure continuity transfer
  //     with NO validator gate by design, §4.7), so running the injected
  //     zeroLengthEdgeValidator over the unchanged state reports it. Even then the
  //     INPUT is untouched (full rollback / immutability). Either way the empty
  //     move is content-preserving; we assert exactly that without presuming the
  //     reached state passes the validator.
  it('an empty-list move never mutates the state (applies as a no-op or rejects cleanly)', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op9Arb, { minLength: 0, maxLength: 12 }), (seed, ops) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp9(ctx, op);
        const before = canonical(ctx.state);
        const res = moveVertices(ctx.state, [], { validators: [zeroLengthEdgeValidator] });
        if (res.status === SHARED_VERTEX_OUTCOME.Applied) {
          // Vacuous move: nothing touched, created, or deleted; content unchanged.
          expect(res.change.touchedVertexIds.size).toBe(0);
          expect(res.change.touchedFeatureIds.size).toBe(0);
          expect(res.change.createdVertexIds.size).toBe(0);
          expect(res.change.deletedVertexIds.size).toBe(0);
          expect(canonical(res.state)).toEqual(before);
        } else {
          // The only legitimate rejection of an empty move is a latent invalid
          // geometry surfaced by the validator over the unchanged state.
          expect(res.reason).toBe(REJECT_REASON.ResultInvalid);
        }
        // The input state object is never mutated, regardless of outcome.
        expect(canonical(ctx.state)).toEqual(before);
      }),
      { seed: SEED9, numRuns: NUM_RUNS9 },
    );
  });

  // Re-sharing a freshly unshared mint onto a THIRD id (not the source it split
  // from) keeps every invariant and collapses the single-citation mint body into
  // the third id (the mint id is gone from every container and its body pruned).
  it('re-sharing a mint onto a third id collapses the mint and keeps invariants', () => {
    fc.assert(
      fc.property(seedArb, fc.array(op9Arb, { minLength: 0, maxLength: 12 }), fc.nat(20), fc.nat(20), (seed, ops, idx, ti) => {
        const ctx: ModelCtx = {
          state: buildState(seed),
          idState: createIdGeneratorState(0, 0),
          clock: makeClock(),
        };
        for (const op of ops) applyOp9(ctx, op);
        const shared = sharedVertexIds(ctx.state);
        const vid = pick(shared, idx);
        if (vid === undefined) return;
        const refs = referencesOf(ctx.state, vid);
        const ref = refs[idx % refs.length];
        if (ref === undefined) return;
        const split = unshareReference(ctx.state, vid, ref, ctx.idState, ctx.clock, {
          validators: [zeroLengthEdgeValidator],
        });
        if (split.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        const mint = split.newVertexId;
        if (mint === undefined) return;
        const afterSplit = split.result.state;
        const others = [...new Set(allCitedIds(afterSplit))].filter((id) => id !== mint && id !== vid);
        const targ = pick(others, ti);
        if (targ === undefined) return;
        const beforeBodies = afterSplit.vertices.byId.size;
        const back = shareVertices(afterSplit, mint, targ, { validators: [zeroLengthEdgeValidator] });
        if (back.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        // The mint collapsed into the third id: gone from every container, body pruned.
        expect(allCitedIds(back.state).includes(mint)).toBe(false);
        expect(getVertex(back.state.vertices, mint)).toBeUndefined();
        expect(back.state.vertices.byId.size).toBe(beforeBodies - 1);
        expect(back.change.deletedVertexIds.has(mint)).toBe(true);
        checkInvariants(back.state, 'after reshare-other');
        checkParticipationOfShared(back.state, 'after reshare-other');
        checkSharedSetDistinct(back.state, 'after reshare-other');
      }),
      { seed: SEED9, numRuns: NUM_RUNS9 },
    );
  });

  // A repeated identical share rejects the second leg as NotFound (the candidate is
  // unreferenced after the first applied merge) and the post-first-leg state equals
  // applying the single share once (the duplicate is a true no-op on a fresh value).
  it('a repeated identical share applies once then rejects the duplicate as NotFound', () => {
    fc.assert(
      fc.property(seedArb, fc.nat(20), fc.nat(20), (seed, ci, ti) => {
        const state = buildState(seed);
        const ids = [...new Set(allCitedIds(state))];
        if (ids.length < 2) return;
        const cand = ids[ci % ids.length];
        const targ = ids[ti % ids.length];
        if (cand === undefined || targ === undefined || cand === targ) return;
        const r1 = shareVertices(state, cand, targ, { validators: [zeroLengthEdgeValidator] });
        if (r1.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        // The candidate is now unreferenced (all citations moved to target).
        const r2 = shareVertices(r1.state, cand, targ, { validators: [zeroLengthEdgeValidator] });
        expect(r2.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
        if (r2.status === SHARED_VERTEX_OUTCOME.Rejected) {
          expect(r2.reason).toBe(REJECT_REASON.NotFound);
        }
        // The duplicate did not alter the first-leg state.
        const single = shareVertices(state, cand, targ, { validators: [zeroLengthEdgeValidator] });
        if (single.status !== SHARED_VERTEX_OUTCOME.Applied) return;
        expect(canonical(r1.state)).toEqual(canonical(single.state));
        checkInvariants(r1.state, 'after idempotent share');
        checkParticipationOfShared(r1.state, 'after idempotent share');
        checkSharedSetDistinct(r1.state, 'after idempotent share');
      }),
      { seed: SEED9, numRuns: NUM_RUNS9 },
    );
  });
});
