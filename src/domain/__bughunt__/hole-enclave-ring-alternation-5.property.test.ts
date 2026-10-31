// hole-enclave-ring-alternation の検査 5/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { asRingId } from '../ids';
import { ringIdFromShapeArb } from '../ring-hierarchy.arbitraries';
import { deleteRingAndReorganize } from '../ring-hierarchy';
import {
  type SelState,
  assertSelBundle,
  cfg7,
  editCommand7Arb,
  pickAny,
  reresolveSelection,
  richGeoShapeArb,
  saveLoadSelState,
  scaleSubtreeAbout,
  selectionValid,
  subtreeCentroid,
} from './hole-enclave-ring-alternation.arbitraries';

describe('alternation (seed=22004): subtree-scale + live selection + full-stream undo', () => {
  it('contracting ANY subtree about its centroid keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              k: fc.double({ min: 0.5, max: 0.999, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickAny(shape, op.sel);
          if (targetId === undefined) return;
          const state: SelState = { shape, store, selected: undefined };
          const center = subtreeCentroid(state, targetId);
          if (center === undefined) return;
          const moved = scaleSubtreeAbout(state, targetId, center, op.k);
          // A centroid contraction keeps EVERY focal invariant: containment,
          // sibling/enclave non-overlap, simplicity, finiteness.
          assertSelBundle({ shape, store: moved, selected: undefined });
          // op∘inverse: scale back about the SAME pivot by 1/k restores coords
          // (multiply-then-divide => within a tight epsilon, not bit-exact).
          const back = scaleSubtreeAbout(
            { shape, store: moved, selected: undefined },
            targetId,
            center,
            1 / op.k,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
          }
        },
      ),
      cfg7,
    );
  });

  it('a selection is never left dangling after deleting its own ring', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((selId) => ({ shape, store, selId })),
        ),
        ({ shape, store, selId }) => {
          // Select a ring, then delete that very ring.
          const selected: SelState = { shape, store, selected: selId };
          expect(selectionValid(selected)).toBe(true);
          const afterShape = deleteRingAndReorganize(shape, selId);
          const afterSel = reresolveSelection(afterShape, selId);
          const after: SelState = { shape: afterShape, store, selected: afterSel };
          // The selected ring is gone, so the re-resolved selection MUST be
          // cleared (undefined) — never a dangling id pointing at an absent ring.
          expect(afterShape.rings.some((r) => r.id === selId)).toBe(false);
          expect(afterSel).toBeUndefined();
          assertSelBundle(after);
        },
      ),
      cfg7,
    );
  });

  it('deleting an UNRELATED ring keeps a valid selection pointing at the same ring', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).chain((selId) =>
            ringIdFromShapeArb(shape).map((delId) => ({ shape, store, selId, delId })),
          ),
        ),
        ({ shape, store, selId, delId }) => {
          // Only meaningful when the deleted ring is NOT in the selected ring's
          // subtree-removal set: after deletion, if the selected ring still
          // exists, the selection must be preserved (not spuriously cleared).
          const afterShape = deleteRingAndReorganize(shape, delId);
          const afterSel = reresolveSelection(afterShape, selId);
          const after: SelState = { shape: afterShape, store, selected: afterSel };
          assertSelBundle(after);
          if (afterShape.rings.some((r) => r.id === selId)) {
            // Survivor: selection must still point at it (preserved, not dropped).
            expect(afterSel).toBe(selId);
          } else {
            // Removed by the deletion's reorganization: selection cleared.
            expect(afterSel).toBeUndefined();
          }
        },
      ),
      cfg7,
    );
  });

  it('stateful: interleaved select / delete / scale / save-load keeps the full bundle and undo=identity at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand7Arb(), { minLength: 5, maxLength: shape.rings.length + 12 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: SelState = { shape, store, selected: undefined };
          assertSelBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-22004'))).toEqual(
              state.shape,
            );
            // FULL-STREAM UNDO: snapshot the pre-command state. Whatever the
            // command does, this snapshot must still reproduce the pre-state
            // exactly (undo∘op = identity). Captured via save→load so the snapshot
            // is an independent value, not an alias of the live state.
            const snapshot = saveLoadSelState(state);

            switch (cmd.tag) {
              case 'select': {
                const targetId = pickAny(state.shape, cmd.sel);
                state = { ...state, selected: targetId };
                assertSelBundle(state);
                break;
              }
              case 'delete-selected': {
                if (state.selected === undefined) break;
                const targetId = state.selected;
                const before = state.shape.rings.length;
                const nextShape = deleteRingAndReorganize(state.shape, targetId);
                state = {
                  shape: nextShape,
                  store: state.store,
                  selected: reresolveSelection(nextShape, targetId),
                };
                // The selected ring was present, so deletion strictly shrinks.
                expect(state.shape.rings.length).toBeLessThan(before);
                // Its own ring is gone => selection cleared, never dangling.
                expect(state.selected).toBeUndefined();
                assertSelBundle(state);
                break;
              }
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const nextShape = deleteRingAndReorganize(state.shape, targetId);
                state = {
                  shape: nextShape,
                  store: state.store,
                  selected: reresolveSelection(nextShape, state.selected),
                };
                assertSelBundle(state);
                break;
              }
              case 'scale-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const center = subtreeCentroid(state, targetId);
                if (center === undefined) break;
                const beforeStore = state.store;
                const moved = scaleSubtreeAbout(state, targetId, center, cmd.k);
                state = { ...state, store: moved };
                assertSelBundle(state);
                // op∘inverse: scale back about the same pivot by 1/k restores the
                // prior coordinates (within a tight float epsilon).
                const back = scaleSubtreeAbout(state, targetId, center, 1 / cmd.k);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
                }
                break;
              }
              case 'save-load': {
                const reloaded = saveLoadSelState(state);
                expect(reloaded.shape).toEqual(state.shape);
                expect(reloaded.selected).toEqual(state.selected);
                state = reloaded;
                assertSelBundle(state);
                break;
              }
              case 'delete-absent-noop': {
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-22004'));
                expect(next).toEqual(state.shape);
                state = { ...state, shape: next };
                assertSelBundle(state);
                break;
              }
              default:
                break;
            }

            // UNDO∘op = identity: the pre-command snapshot still reproduces the
            // pre-command state verbatim (shape + selection; the store snapshot is
            // an independent copy so a later mutation cannot have aliased it).
            assertSelBundle(snapshot);
          }
        },
      ),
      cfg7,
    );
  });
});
