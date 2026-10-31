// hole-enclave-ring-alternation の検査 3/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { asRingId } from '../ids';
import { ringIdFromShapeArb } from '../ring-hierarchy.arbitraries';
import { RING_KIND, type Shape } from '../ring';
import { deleteRingAndReorganize, validateGeometry } from '../ring-hierarchy';
import {
  type EditState,
  assertFullBundle,
  assertStructurallyValid,
  cfg5,
  depthsConsistent,
  descendantsLeafFirst,
  editCommand5Arb,
  extractTerritorySubtree,
  pickAny,
  pickTerritory,
  richGeoShapeArb,
  saveLoadState,
  scaledNudge,
  subtreeRingIds,
  translateAnySubtree,
} from './hole-enclave-ring-alternation.arbitraries';

describe('alternation (seed=22002): subtree-nudge + extract + leaf-first deletion', () => {
  it('nudging ANY subtree by a sub-clearance offset keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              fLon: fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
              fLat: fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickAny(shape, op.sel);
          if (targetId === undefined) return;
          const state: EditState = { shape, store };
          // The offset is a FRACTION of this target's OWN clearance, so the property's
          // precondition ("within the clearance") holds at every nesting depth.
          const dLon = scaledNudge(state, targetId, op.fLon);
          const dLat = scaledNudge(state, targetId, op.fLat);
          const moved = translateAnySubtree(state, targetId, dLon, dLat);
          // A rigid nudge within the cell clearance keeps EVERY focal invariant:
          // containment, sibling/enclave non-overlap, simplicity, finiteness.
          assertFullBundle({ shape, store: moved });
          // op∘inverse: nudge back by the negated offset restores coordinates
          // (float add-then-subtract, so within a tight epsilon, not bit-exact).
          const back = translateAnySubtree({ shape, store: moved }, targetId, -dLon, -dLat);
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
          }
        },
      ),
      cfg5,
    );
  });

  it('extract-territory closure: a re-rooted territory subtree is a valid alternating forest with consistent depths', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map((sel) => ({ shape, store, rootId: pickTerritory(shape, sel) })),
        ),
        ({ shape, store, rootId }) => {
          if (rootId === undefined) return; // no territory to extract (vacuous)
          const extracted = extractTerritorySubtree(shape, rootId);
          // The extracted shape contains exactly the subtree's rings.
          const subtreeIds = subtreeRingIds(shape, rootId);
          expect(new Set(extracted.rings.map((r) => r.id))).toEqual(subtreeIds);
          // Closure: re-rooted territory subtree is a valid alternating forest.
          assertStructurallyValid(extracted);
          expect(depthsConsistent(extracted)).toBe(true);
          // Geometry of the surviving rings is unchanged (store untouched). A
          // territory subtree is self-contained: holes still inside their territory,
          // enclaves still inside their hole, and the re-rooted territory is now the
          // single top-level band so it has no enclave-overlap partner. The
          // extracted shape must therefore validate clean against the SAME store.
          expect(validateGeometry(extracted, store).violations).toEqual([]);
          // The re-rooted ring is a top-level territory with no parent link.
          const newRoot = extracted.rings.find((r) => r.id === rootId);
          expect(newRoot?.kind).toBe(RING_KIND.Territory);
          expect(newRoot?.parentRingId).toBeUndefined();
        },
      ),
      cfg5,
    );
  });

  it('confluence: deleting a subtree leaf-first reaches the same forest as deleting its root once', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((rootId) => ({ shape, store, rootId })),
        ),
        ({ shape, store, rootId }) => {
          // Path A: delete every descendant leaf-first, THEN the root.
          let leafUp = shape;
          for (const id of descendantsLeafFirst(shape, rootId)) {
            leafUp = deleteRingAndReorganize(leafUp, id);
            // Invariant holds after every single leaf-first deletion too.
            assertStructurallyValid(leafUp);
            expect(validateGeometry(leafUp, store).violations).toEqual([]);
          }
          leafUp = deleteRingAndReorganize(leafUp, rootId);

          // Path B: delete the root once (reorganization absorbs the subtree).
          const rootOnce = deleteRingAndReorganize(shape, rootId);

          // Both paths remove the entire subtree's rings and keep the rest valid.
          assertStructurallyValid(leafUp);
          assertStructurallyValid(rootOnce);
          const subtreeIds = subtreeRingIds(shape, rootId);
          for (const id of subtreeIds) {
            expect(leafUp.rings.some((r) => r.id === id)).toBe(false);
          }
          // Confluence on the SURVIVING ring set: the rings OUTSIDE the deleted
          // subtree are identical (same ids, kinds, parents) in both paths. (The
          // forests can differ only in absorbed-descendant handling within the
          // subtree, which both paths remove entirely.)
          const survivors = (s: Shape): string =>
            JSON.stringify(
              [...s.rings]
                .filter((r) => !subtreeIds.has(r.id))
                .map((r) => ({ id: r.id, kind: r.kind, parent: r.parentRingId ?? null }))
                .sort((x, y) => x.id.localeCompare(y.id)),
            );
          expect(survivors(leafUp)).toBe(survivors(rootOnce));
        },
      ),
      cfg5,
    );
  });

  it('stateful: interleaved delete / sub-clearance nudge / save-load keeps the full bundle at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand5Arb(), { minLength: 4, maxLength: shape.rings.length + 10 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: EditState = { shape, store };
          assertFullBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-22002'))).toEqual(
              state.shape,
            );
            switch (cmd.tag) {
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const before = state.shape.rings.length;
                state = {
                  shape: deleteRingAndReorganize(state.shape, targetId),
                  store: state.store,
                };
                expect(state.shape.rings.length).toBeLessThan(before);
                assertFullBundle(state);
                break;
              }
              case 'nudge-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const beforeStore = state.store;
                const dLon = scaledNudge(state, targetId, cmd.fLon);
                const dLat = scaledNudge(state, targetId, cmd.fLat);
                const moved = translateAnySubtree(state, targetId, dLon, dLat);
                state = { shape: state.shape, store: moved };
                assertFullBundle(state);
                // UNDO∘op: nudge back restores prior coordinates (tight epsilon).
                const back = translateAnySubtree(state, targetId, -dLon, -dLat);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
                }
                break;
              }
              case 'save-load': {
                const reloaded = saveLoadState(state);
                expect(reloaded.shape).toEqual(state.shape);
                state = reloaded;
                assertFullBundle(state);
                break;
              }
              case 'delete-absent-noop': {
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-22002'));
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
      cfg5,
    );
  });
});
