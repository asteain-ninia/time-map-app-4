// hole-enclave-ring-alternation の検査 2/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { asRingId } from '../ids';
import { ringIdFromShapeArb } from '../ring-hierarchy.arbitraries';
import { deleteRingAndReorganize, validateGeometry } from '../ring-hierarchy';
import {
  type EditState,
  assertFullBundle,
  cfg4,
  editCommandArb,
  pickAny,
  pickTopLevel,
  richGeoShapeArb,
  saveLoadState,
  translateSubtree,
} from './hole-enclave-ring-alternation.arbitraries';

describe('alternation (seed=22001): stateful edit-command stream + metamorphic laws', () => {
  it('every command keeps the full invariant bundle and the absent-delete identity holds at each step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommandArb(), { minLength: 3, maxLength: shape.rings.length + 8 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: EditState = { shape, store };
          assertFullBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC (every step): deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-22001'))).toEqual(
              state.shape,
            );

            switch (cmd.tag) {
              case 'delete': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const nextShape = deleteRingAndReorganize(state.shape, targetId);
                state = { shape: nextShape, store: state.store };
                assertFullBundle(state);
                break;
              }
              case 'translate': {
                const targetId = pickTopLevel(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const movedStore = translateSubtree(state, targetId, cmd.dLon, cmd.dLat);
                const moved: EditState = { shape: state.shape, store: movedStore };
                // A RAW translate has no collision guard: sliding a top-level territory
                // can make it OVERLAP a sibling (even a hair-thin positive-area sliver
                // whose long edges are exactly collinear — detected by ringsOverlap's
                // coincident-boundary probe). In the live app such a move is caught by
                // consistency + conflict-resolution (FR-62/63); this raw-op stream runs
                // NO orchestrator, so it explores only invariant-PRESERVING transitions:
                // a move that produces a geometry violation is skipped (state unchanged),
                // not asserted valid. (Previously this stream silently accepted such an
                // overlap because ringsOverlap missed the collinear-sliver case — the
                // very false-negative the ring-hierarchy fix closes.)
                if (validateGeometry(moved.shape, moved.store).violations.length > 0) break;
                const before = state.store;
                state = moved;
                assertFullBundle(state);
                // OP∘INVERSE = identity (modulo IEEE-754 rounding): translating the
                // same subtree back by the negated offset restores the prior store
                // coordinates. Float add-then-subtract is not bit-exact in general
                // (e.g. (-1.6 + 4) - 4 != -1.6), so the honest law is "equal within
                // a tight epsilon", asserted here — NOT exact equality, which would
                // be a false property of floating-point translation.
                const restored = translateSubtree(state, targetId, -cmd.dLon, -cmd.dLat);
                for (const v of before.byId.values()) {
                  const rv = restored.byId.get(v.id);
                  expect(rv).not.toBeUndefined();
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
                }
                break;
              }
              case 'saveLoad': {
                // SAVE∘LOAD = identity as an explicit command in the stream.
                const reloaded = saveLoadState(state);
                expect(reloaded.shape).toEqual(state.shape);
                state = reloaded;
                assertFullBundle(state);
                break;
              }
              case 'noop-delete-absent': {
                const next = deleteRingAndReorganize(state.shape, asRingId('absent-cmd'));
                expect(next).toEqual(state.shape);
                state = { shape: next, store: state.store };
                assertFullBundle(state);
                break;
              }
              default:
                break;
            }
          }
        },
      ),
      cfg4,
    );
  });

  it('op∘inverse: translate(+d) then translate(-d) on a subtree restores the store (within float epsilon)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              dLon: fc.double({ min: -15, max: 15, noNaN: true, noDefaultInfinity: true }),
              dLat: fc.double({ min: -15, max: 15, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const state: EditState = { shape, store };
          const targetId = pickTopLevel(shape, op.sel);
          if (targetId === undefined) return;
          const moved = translateSubtree(state, targetId, op.dLon, op.dLat);
          // The whole state with the moved subtree must still be fully valid.
          assertFullBundle({ shape, store: moved });
          const back = translateSubtree({ shape, store: moved }, targetId, -op.dLon, -op.dLat);
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            // Equal within a tight epsilon (float add-then-subtract is not bit-exact).
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
          }
        },
      ),
      cfg4,
    );
  });

  it('undo∘delete: the pre-delete snapshot reproduces the original valid state verbatim', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, store, targetId }) => {
          const before: EditState = { shape, store };
          const snapshot = saveLoadState(before);
          const afterShape = deleteRingAndReorganize(shape, targetId);
          const after: EditState = { shape: afterShape, store };
          assertFullBundle(after);
          // UNDO = restore snapshot: the snapshot reproduces the original state
          // exactly (what an undo of the delete must yield).
          expect(snapshot.shape).toEqual(shape);
          assertFullBundle(snapshot);
          // The delete only ever shrinks (or keeps) the forest.
          expect(after.shape.rings.length).toBeLessThanOrEqual(shape.rings.length);
        },
      ),
      cfg4,
    );
  });
});
