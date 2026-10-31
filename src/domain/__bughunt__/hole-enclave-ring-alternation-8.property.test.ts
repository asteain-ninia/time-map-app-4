// hole-enclave-ring-alternation の検査 8/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { asRingId, type RingId } from '../ids';
import { ringIdFromShapeArb } from '../ring-hierarchy.arbitraries';
import { childrenOf, deleteRingAndReorganize, validateGeometry } from '../ring-hierarchy';
import {
  type FullState,
  assertFullStateBundle,
  assertStructurallyValid,
  cfg10,
  editCommand10Arb,
  insertAnchor,
  pickAny,
  pickTopLevelId,
  removeAnchorAt,
  reresolveSelection,
  richGeoShapeArb,
  saveLoadFullState,
  scaleSubtreeAnisotropic,
  subtreeCentroid,
} from './hole-enclave-ring-alternation.arbitraries';

describe('alternation (seed=32004): anisotropic scale of top bands + subtree-absorption law', () => {
  it('non-uniformly scaling a top-level band about its centroid keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              kx: fc.double({ min: 0.5, max: 0.999, noNaN: true, noDefaultInfinity: true }),
              ky: fc.double({ min: 0.5, max: 0.999, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickTopLevelId(shape, op.sel);
          if (targetId === undefined) return;
          const center = subtreeCentroid({ shape, store, selected: undefined }, targetId);
          if (center === undefined) return;
          const state: FullState = { shape, store, selected: undefined, anchors: [] };
          const moved = scaleSubtreeAnisotropic(state, targetId, center, op.kx, op.ky);
          // A whole-band anisotropic contraction keeps EVERY focal invariant:
          // simplicity (axis-aligned rect → smaller axis-aligned rect), internal
          // containment (affine-preserved), band non-overlap (box only shrinks).
          assertFullStateBundle({ shape, store: moved, selected: undefined, anchors: [] });
          // op∘inverse: scale back by (1/kx, 1/ky) about the SAME pivot restores
          // coords (multiply-then-divide => within a tight epsilon, not bit-exact).
          const back = scaleSubtreeAnisotropic(
            { shape, store: moved, selected: undefined, anchors: [] },
            targetId,
            center,
            1 / op.kx,
            1 / op.ky,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
          }
        },
      ),
      cfg10,
    );
  });

  it('direct-child absorption + no-dangling: deleting a ring removes it and its direct children, lifts grandchildren, leaves no dangling parent', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((rootId) => ({ shape, store, rootId })),
        ),
        ({ shape, store, rootId }) => {
          // The direct children of the deleted root in the ORIGINAL shape are
          // absorbed (a hole whose territory is gone / an enclave whose hole is
          // gone has no surviving parent), so they are removed alongside the root.
          const directChildIds = new Set(childrenOf(shape, rootId).map((r) => r.id));
          const removed = new Set<RingId>([rootId, ...directChildIds]);

          const after = deleteRingAndReorganize(shape, rootId);
          assertStructurallyValid(after);
          expect(validateGeometry(after, store).violations).toEqual([]);

          // (a) the root and (b) every original direct child are gone.
          for (const id of removed) {
            expect(after.rings.some((r) => r.id === id)).toBe(false);
          }
          // (c) NO surviving ring still references a removed ring as parent — the
          // reorganizer re-linked (lifted) grand-children rather than leaving a
          // dangling reference to the deleted root / absorbed child (教訓5.21).
          for (const r of after.rings) {
            if (r.parentRingId !== undefined) {
              expect(removed.has(r.parentRingId)).toBe(false);
            }
          }
          // Re-deleting the (now-absent) root id is the identity.
          expect(deleteRingAndReorganize(after, rootId)).toEqual(after);
        },
      ),
      cfg10,
    );
  });

  it('stateful: interleaved select / delete / aniso-scale-top / anchor / save-load keeps the full bundle at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand10Arb(), { minLength: 5, maxLength: shape.rings.length + 14 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: FullState = { shape, store, selected: undefined, anchors: [] };
          assertFullStateBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-32004'))).toEqual(
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
              case 'aniso-scale-top': {
                const targetId = pickTopLevelId(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const center = subtreeCentroid(
                  { shape: state.shape, store: state.store, selected: undefined },
                  targetId,
                );
                if (center === undefined) break;
                const beforeStore = state.store;
                const moved = scaleSubtreeAnisotropic(state, targetId, center, cmd.kx, cmd.ky);
                state = { ...state, store: moved };
                assertFullStateBundle(state);
                // op∘inverse: scale back by (1/kx, 1/ky) restores prior coords.
                const back = scaleSubtreeAnisotropic(
                  state,
                  targetId,
                  center,
                  1 / cmd.kx,
                  1 / cmd.ky,
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
              case 'delete-absent-noop': {
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-32004'));
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
      cfg10,
    );
  });
});
