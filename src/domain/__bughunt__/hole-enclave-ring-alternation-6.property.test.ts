// hole-enclave-ring-alternation の検査 6/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { asRingId } from '../ids';
import { deleteRingAndReorganize } from '../ring-hierarchy';
import {
  type FullState,
  assertFullStateBundle,
  cfg8,
  editCommand8Arb,
  insertAnchor,
  pickAny,
  pickTopLevelId,
  reflectSubtreeAbout,
  removeAnchorAt,
  reresolveSelection,
  richGeoShapeArb,
  rotateSubtreeAbout,
  saveLoadFullState,
  subtreeCentroid,
} from './hole-enclave-ring-alternation.arbitraries';

describe('alternation (seed=32002): rigid rotate/reflect of top bands + selection + anchors', () => {
  it('rotating a top-level band about its centroid keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickTopLevelId(shape, op.sel);
          if (targetId === undefined) return;
          const state: FullState = { shape, store, selected: undefined, anchors: [] };
          const pivot = subtreeCentroid(
            { shape, store, selected: undefined },
            targetId,
          );
          if (pivot === undefined) return;
          const moved = rotateSubtreeAbout(state, targetId, pivot, op.angle);
          // A rigid rotation of a whole top band keeps EVERY focal invariant:
          // internal containment, sibling/enclave non-overlap, simplicity, finite.
          assertFullStateBundle({ shape, store: moved, selected: undefined, anchors: [] });
          // op∘inverse: rotate back by −angle about the SAME pivot restores coords
          // (trig round-trip => within a tight epsilon, not bit-exact).
          const back = rotateSubtreeAbout(
            { shape, store: moved, selected: undefined, anchors: [] },
            targetId,
            pivot,
            -op.angle,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
          }
        },
      ),
      cfg8,
    );
  });

  it('reflecting a top-level band across its centroid axis keeps the full bundle (reflect∘reflect = identity)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map((sel) => ({ shape, store, sel })),
        ),
        ({ shape, store, sel }) => {
          const targetId = pickTopLevelId(shape, sel);
          if (targetId === undefined) return;
          const state: FullState = { shape, store, selected: undefined, anchors: [] };
          const centroid = subtreeCentroid(
            { shape, store, selected: undefined },
            targetId,
          );
          if (centroid === undefined) return;
          const moved = reflectSubtreeAbout(state, targetId, centroid.lon);
          // A reflection of a whole top band is an isometry confined to its own
          // bounding box: full bundle survives.
          assertFullStateBundle({ shape, store: moved, selected: undefined, anchors: [] });
          // op∘op = identity: reflecting back across the SAME axis restores coords.
          const back = reflectSubtreeAbout(
            { shape, store: moved, selected: undefined, anchors: [] },
            targetId,
            centroid.lon,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
          }
        },
      ),
      cfg8,
    );
  });

  it('stateful: interleaved select / delete / rotate-top / reflect-top / anchor / save-load keeps the full bundle at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand8Arb(), { minLength: 5, maxLength: shape.rings.length + 14 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: FullState = { shape, store, selected: undefined, anchors: [] };
          assertFullStateBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-32002'))).toEqual(
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
              case 'rotate-top': {
                const targetId = pickTopLevelId(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const pivot = subtreeCentroid(
                  { shape: state.shape, store: state.store, selected: undefined },
                  targetId,
                );
                if (pivot === undefined) break;
                const beforeStore = state.store;
                const moved = rotateSubtreeAbout(state, targetId, pivot, cmd.angle);
                state = { ...state, store: moved };
                assertFullStateBundle(state);
                // op∘inverse: rotate back restores prior coordinates (tight epsilon).
                const back = rotateSubtreeAbout(state, targetId, pivot, -cmd.angle);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
                }
                break;
              }
              case 'reflect-top': {
                const targetId = pickTopLevelId(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const centroid = subtreeCentroid(
                  { shape: state.shape, store: state.store, selected: undefined },
                  targetId,
                );
                if (centroid === undefined) break;
                const beforeStore = state.store;
                const moved = reflectSubtreeAbout(state, targetId, centroid.lon);
                state = { ...state, store: moved };
                assertFullStateBundle(state);
                // reflect∘reflect = identity: reflecting back restores coordinates.
                const back = reflectSubtreeAbout(state, targetId, centroid.lon);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
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
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-32002'));
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
      cfg8,
    );
  });
});
