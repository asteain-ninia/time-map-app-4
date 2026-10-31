// hole-enclave-ring-alternation の検査 7/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { asRingId } from '../ids';
import { ringIdFromShapeArb } from '../ring-hierarchy.arbitraries';
import { deleteRingAndReorganize } from '../ring-hierarchy';
import {
  type FullState,
  assertFullStateBundle,
  assertStructurallyValid,
  cfg9,
  editCommand9Arb,
  insertAnchor,
  pickAny,
  pickTopLevelId,
  rekeyState,
  removeAnchorAt,
  reresolveSelection,
  richGeoShapeArb,
  saveLoadFullState,
  shearSubtreeAbout,
  structuralSignature,
  subtreeCentroid,
} from './hole-enclave-ring-alternation.arbitraries';

describe('alternation (seed=32003): affine shear of top bands + rekey-commutes-with-delete', () => {
  it('vertical-shearing a top-level band about its centroid lon keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              s: fc.double({ min: -2, max: 2, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickTopLevelId(shape, op.sel);
          if (targetId === undefined) return;
          const pivot = subtreeCentroid({ shape, store, selected: undefined }, targetId);
          if (pivot === undefined) return;
          const state: FullState = { shape, store, selected: undefined, anchors: [] };
          const moved = shearSubtreeAbout(state, targetId, pivot.lon, op.s);
          // A whole-band affine shear keeps EVERY focal invariant: simplicity (a
          // parallelogram is simple), internal containment (affine-preserved), and
          // band non-overlap (lat-only change cannot close an 80° lon gap).
          assertFullStateBundle({ shape, store: moved, selected: undefined, anchors: [] });
          // op∘inverse: shear back by −s about the SAME pivot lon restores coords
          // (multiply-add-then-subtract => within a tight epsilon, not bit-exact).
          const back = shearSubtreeAbout(
            { shape, store: moved, selected: undefined, anchors: [] },
            targetId,
            pivot.lon,
            -op.s,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
          }
        },
      ),
      cfg9,
    );
  });

  it('naming invariance: rekey-then-delete equals delete-then-rekey (structural signature)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, store, targetId }) => {
          // Path A: rename everything, THEN delete the renamed target.
          const renamed = rekeyState({ shape, store }, targetId);
          const deletedAfterRename = deleteRingAndReorganize(renamed.state.shape, renamed.targetId);
          // Path B: delete the original target, THEN rename the result.
          const deletedFirst = deleteRingAndReorganize(shape, targetId);
          const renamedAfterDelete = rekeyState({ shape: deletedFirst, store }, targetId);
          // The two forests must be IDENTICAL once the rekey prefix is stripped:
          // deletion depends only on graph structure, not on the id strings. A
          // mismatch would reveal a string-order dependence inside the reorganizer.
          expect(structuralSignature(deletedAfterRename, true)).toBe(
            structuralSignature(renamedAfterDelete.state.shape, true),
          );
          // Both results are valid alternating forests, referentially integral.
          assertStructurallyValid(deletedAfterRename);
          assertStructurallyValid(renamedAfterDelete.state.shape);
        },
      ),
      cfg9,
    );
  });

  it('stateful: interleaved select / delete / shear-top / anchor / save-load keeps the full bundle at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand9Arb(), { minLength: 5, maxLength: shape.rings.length + 14 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: FullState = { shape, store, selected: undefined, anchors: [] };
          assertFullStateBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-32003'))).toEqual(
              state.shape,
            );
            // FULL-STREAM UNDO: an independent snapshot of the pre-command state.
            const snapshot = saveLoadFullState(state);

            switch (cmd.tag) {
              case 'select': {
                const targetId = pickAny(state.shape, cmd.sel);
                state = { ...state, selected: targetId };
                assertFullStateBundle(state);
                break;
              }
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const before = state.shape.rings.length;
                const nextShape = deleteRingAndReorganize(state.shape, targetId);
                state = {
                  ...state,
                  shape: nextShape,
                  selected: reresolveSelection(nextShape, state.selected),
                };
                expect(state.shape.rings.length).toBeLessThan(before);
                assertFullStateBundle(state);
                break;
              }
              case 'shear-top': {
                const targetId = pickTopLevelId(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const pivot = subtreeCentroid(
                  { shape: state.shape, store: state.store, selected: undefined },
                  targetId,
                );
                if (pivot === undefined) break;
                const beforeStore = state.store;
                const moved = shearSubtreeAbout(state, targetId, pivot.lon, cmd.s);
                state = { ...state, store: moved };
                assertFullStateBundle(state);
                // op∘inverse: shear back by −s about the same axis restores coords.
                const back = shearSubtreeAbout(state, targetId, pivot.lon, -cmd.s);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
                }
                break;
              }
              case 'anchor-insert': {
                const before = state.anchors;
                state = { ...state, anchors: insertAnchor(state.anchors, cmd.value) };
                if (before.includes(cmd.value)) expect(state.anchors).toEqual(before);
                assertFullStateBundle(state);
                break;
              }
              case 'anchor-remove': {
                const idx =
                  state.anchors.length === 0
                    ? -1
                    : Math.min(
                        state.anchors.length - 1,
                        Math.floor(cmd.sel * state.anchors.length),
                      );
                state = { ...state, anchors: removeAnchorAt(state.anchors, idx) };
                assertFullStateBundle(state);
                break;
              }
              case 'save-load': {
                const reloaded = saveLoadFullState(state);
                expect(reloaded.shape).toEqual(state.shape);
                expect(reloaded.selected).toEqual(state.selected);
                expect(reloaded.anchors).toEqual(state.anchors);
                state = reloaded;
                assertFullStateBundle(state);
                break;
              }
              case 'delete-absent-noop': {
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-32003'));
                expect(next).toEqual(state.shape);
                state = { ...state, shape: next };
                assertFullStateBundle(state);
                break;
              }
              default:
                break;
            }

            // UNDO∘op = identity: the pre-command snapshot still reproduces the
            // pre-command state verbatim (an independent copy, no aliasing).
            assertFullStateBundle(snapshot);
          }
        },
      ),
      cfg9,
    );
  });
});
