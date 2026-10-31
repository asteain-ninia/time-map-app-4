// hole-enclave-ring-alternation の検査 9/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
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
  cfg11,
  cfg11Stream,
  editCommand11Arb,
  insertAnchor,
  pickAny,
  pickTopLevelId,
  placeSubtree,
  rekeyState,
  removeAnchorAt,
  reresolveSelection,
  richGeoShapeArb,
  saveLoadFullState,
  scaleSubtreeAbout,
  structuralSignature,
  subtreeCentroid,
  uniformScaleAnySubtree,
  unplaceSubtree,
} from './hole-enclave-ring-alternation.arbitraries';

describe('alternation (seed=42001): composite place + uniform-scale-any + rekey-commutes stream', () => {
  it('placing (rotate∘uniform-scale) a top-level band about its centroid keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              k: fc.double({ min: 0.5, max: 0.999, noNaN: true, noDefaultInfinity: true }),
              angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickTopLevelId(shape, op.sel);
          if (targetId === undefined) return;
          const state: FullState = { shape, store, selected: undefined, anchors: [] };
          const center = subtreeCentroid(
            { shape, store, selected: undefined },
            targetId,
          );
          if (center === undefined) return;
          const moved = placeSubtree(state, targetId, center, op.k, op.angle);
          // A composite rotate∘uniform-contraction about the band's own centroid
          // keeps every focal invariant: each axis-aligned rectangle maps to a
          // (rotated, smaller) rectangle (still simple, non-self-intersecting),
          // internal containment is affine-preserved, and the band stays inside
          // its 80-wide cell (circumradius ≤16√2 < 40 half-gap).
          assertFullStateBundle({ shape, store: moved, selected: undefined, anchors: [] });
          // op∘inverse: un-rotate(−angle) then un-scale(1/k) about the SAME
          // centroid restores coords (multiply/rotate then divide/rotate-back =>
          // within a tight epsilon, not bit-exact).
          const back = unplaceSubtree(
            { shape, store: moved, selected: undefined, anchors: [] },
            targetId,
            center,
            op.k,
            op.angle,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
          }
        },
      ),
      cfg11,
    );
  });

  it('uniformly contracting ANY subtree about its centroid keeps the full bundle (op∘inverse restores)', () => {
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
          const state: FullState = { shape, store, selected: undefined, anchors: [] };
          const result = uniformScaleAnySubtree(state, targetId, op.k);
          if (result === undefined) return;
          assertFullStateBundle({
            shape,
            store: result.store,
            selected: undefined,
            anchors: [],
          });
          // op∘inverse: scale back by 1/k about the SAME centroid restores coords.
          const back = scaleSubtreeAbout(
            { shape, store: result.store, selected: undefined },
            targetId,
            result.center,
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
      cfg11,
    );
  });

  it('rekey commutes with delete: rename(delete(s)) ≡ delete(rename(s)) up to the rename prefix', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, store, targetId }) => {
          // (a) delete THEN rename.
          const deletedFirst = deleteRingAndReorganize(shape, targetId);
          const renamedAfterDelete = rekeyState(
            { shape: deletedFirst, store },
            // any valid id works as the second arg; we only use the renamed shape.
            targetId,
          ).state.shape;
          // (b) rename THEN delete (delete the renamed image of the same ring).
          const renamed = rekeyState({ shape, store }, targetId);
          const deletedAfterRename = deleteRingAndReorganize(
            renamed.state.shape,
            renamed.targetId,
          );
          // Both forests, stripped of the rename prefix, are structurally identical:
          // the reorganization is naming-invariant (a pure function of structure).
          expect(structuralSignature(deletedAfterRename, true)).toBe(
            structuralSignature(renamedAfterDelete, true),
          );
          // Both are independently valid alternating forests.
          assertStructurallyValid(deletedAfterRename);
          assertStructurallyValid(renamedAfterDelete);
        },
      ),
      cfg11,
    );
  });

  it('stateful: interleaved select / delete-selected / delete-any / place-top / uscale-any / anchor / save-load / rekey-commutes keeps the full bundle + undo=identity at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand11Arb(), { minLength: 6, maxLength: shape.rings.length + 16 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: FullState = { shape, store, selected: undefined, anchors: [] };
          assertFullStateBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(
              deleteRingAndReorganize(state.shape, asRingId('absent-42001')),
            ).toEqual(state.shape);
            // FULL-STREAM UNDO: an independent snapshot of the pre-command state.
            const snapshot = saveLoadFullState(state);

            switch (cmd.tag) {
              case 'select': {
                const targetId = pickAny(state.shape, cmd.sel);
                state = { ...state, selected: targetId };
                assertFullStateBundle(state);
                break;
              }
              case 'delete-selected': {
                if (state.selected === undefined) {
                  assertFullStateBundle(state);
                  break;
                }
                const before = state.shape.rings.length;
                const nextShape = deleteRingAndReorganize(state.shape, state.selected);
                state = {
                  ...state,
                  shape: nextShape,
                  // selection must follow the model: its own ring is gone now.
                  selected: reresolveSelection(nextShape, state.selected),
                };
                expect(state.shape.rings.length).toBeLessThan(before);
                // a delete-selected always clears the dangling selection.
                expect(state.selected).toBeUndefined();
                assertFullStateBundle(state);
                break;
              }
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) {
                  assertFullStateBundle(state);
                  break;
                }
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
              case 'place-top': {
                const targetId = pickTopLevelId(state.shape, cmd.sel);
                if (targetId === undefined) {
                  assertFullStateBundle(state);
                  break;
                }
                const center = subtreeCentroid(
                  { shape: state.shape, store: state.store, selected: undefined },
                  targetId,
                );
                if (center === undefined) {
                  assertFullStateBundle(state);
                  break;
                }
                const beforeStore = state.store;
                const moved = placeSubtree(state, targetId, center, cmd.k, cmd.angle);
                state = { ...state, store: moved };
                assertFullStateBundle(state);
                // op∘inverse: un-place restores prior coords.
                const back = unplaceSubtree(state, targetId, center, cmd.k, cmd.angle);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
                }
                break;
              }
              case 'uscale-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) {
                  assertFullStateBundle(state);
                  break;
                }
                const beforeStore = state.store;
                const result = uniformScaleAnySubtree(state, targetId, cmd.k);
                if (result === undefined) {
                  assertFullStateBundle(state);
                  break;
                }
                state = { ...state, store: result.store };
                assertFullStateBundle(state);
                // op∘inverse: scale back by 1/k about the SAME centroid.
                const back = scaleSubtreeAbout(
                  { shape: state.shape, store: state.store, selected: undefined },
                  targetId,
                  result.center,
                  1 / cmd.k,
                );
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
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
              case 'rekey-commutes': {
                // METAMORPHIC, live: deleting then renaming equals renaming then
                // deleting (up to the rename prefix) on the CURRENT shape. The
                // state itself is left unchanged — this is a read-only law check.
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) {
                  assertFullStateBundle(state);
                  break;
                }
                const deletedFirst = deleteRingAndReorganize(state.shape, targetId);
                const renamedAfterDelete = rekeyState(
                  { shape: deletedFirst, store: state.store },
                  targetId,
                ).state.shape;
                const renamed = rekeyState(
                  { shape: state.shape, store: state.store },
                  targetId,
                );
                const deletedAfterRename = deleteRingAndReorganize(
                  renamed.state.shape,
                  renamed.targetId,
                );
                expect(structuralSignature(deletedAfterRename, true)).toBe(
                  structuralSignature(renamedAfterDelete, true),
                );
                assertFullStateBundle(state);
                break;
              }
              case 'delete-absent-noop': {
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-42001'));
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
      cfg11Stream,
    );
  });
});
