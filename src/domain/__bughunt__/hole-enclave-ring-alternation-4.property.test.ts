// hole-enclave-ring-alternation の検査 4/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { asRingId } from '../ids';
import { RING_KIND, type Shape } from '../ring';
import { deleteRingAndReorganize } from '../ring-hierarchy';
import {
  type EditState,
  type GrowState,
  addEnclaveToLeafHole,
  addHoleToLeafTerritory,
  anchorsAscendingUnique,
  assertGrowBundle,
  cfg6,
  editCommand6Arb,
  insertAnchor,
  isLeafRing,
  pickAny,
  removeAnchorAt,
  richGeoShapeArb,
  saveLoadGrowState,
  scaledNudge,
  translateAnySubtree,
} from './hole-enclave-ring-alternation.arbitraries';

describe('alternation (seed=22003): GROW (add hole/enclave) + anchor series + metamorphic laws', () => {
  it('adding a centered hole to a leaf territory keeps the full geometry bundle (undo = delete restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map((sel) => ({ shape, store, sel })),
        ),
        ({ shape, store, sel }) => {
          const leafTerritories = shape.rings.filter(
            (r) => r.kind === RING_KIND.Territory && isLeafRing(shape, r.id),
          );
          if (leafTerritories.length === 0) return; // vacuous
          const idx = Math.min(leafTerritories.length - 1, Math.floor(sel * leafTerritories.length));
          const target = leafTerritories[idx];
          if (target === undefined) return;

          const start: GrowState = { shape, store, nextId: 0, anchors: [] };
          const result = addHoleToLeafTerritory(start, target.id);
          expect(result).not.toBeUndefined();
          if (result === undefined) return;
          // The grown state is fully valid: the new hole is contained, simple,
          // finite, and creates no sibling/containment violation.
          assertGrowBundle(result.state);
          // The added ring is present, is a hole, and is parented to the target.
          const added = result.state.shape.rings.find((r) => r.id === result.addedId);
          expect(added?.kind).toBe(RING_KIND.Hole);
          expect(added?.parentRingId).toBe(target.id);
          // UNDO∘add = delete the added ring: it restores the original forest
          // structure exactly (same ids/kinds/parents) — the added ring is the
          // only one removed and it had no children.
          const undone = deleteRingAndReorganize(result.state.shape, result.addedId);
          const norm = (s: Shape): string =>
            JSON.stringify(
              [...s.rings]
                .map((r) => ({ id: r.id, kind: r.kind, parent: r.parentRingId ?? null }))
                .sort((x, y) => x.id.localeCompare(y.id)),
            );
          expect(norm(undone)).toBe(norm(shape));
        },
      ),
      cfg6,
    );
  });

  it('adding a centered enclave to a leaf hole keeps the full geometry bundle (undo = delete restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map((sel) => ({ shape, store, sel })),
        ),
        ({ shape, store, sel }) => {
          const leafHoles = shape.rings.filter(
            (r) => r.kind === RING_KIND.Hole && isLeafRing(shape, r.id),
          );
          if (leafHoles.length === 0) return; // vacuous
          const idx = Math.min(leafHoles.length - 1, Math.floor(sel * leafHoles.length));
          const target = leafHoles[idx];
          if (target === undefined) return;

          const start: GrowState = { shape, store, nextId: 0, anchors: [] };
          const result = addEnclaveToLeafHole(start, target.id);
          expect(result).not.toBeUndefined();
          if (result === undefined) return;
          assertGrowBundle(result.state);
          const added = result.state.shape.rings.find((r) => r.id === result.addedId);
          expect(added?.kind).toBe(RING_KIND.Territory);
          expect(added?.parentRingId).toBe(target.id);
          // UNDO∘add = delete the added enclave restores the original forest.
          const undone = deleteRingAndReorganize(result.state.shape, result.addedId);
          const norm = (s: Shape): string =>
            JSON.stringify(
              [...s.rings]
                .map((r) => ({ id: r.id, kind: r.kind, parent: r.parentRingId ?? null }))
                .sort((x, y) => x.id.localeCompare(y.id)),
            );
          expect(norm(undone)).toBe(norm(shape));
        },
      ),
      cfg6,
    );
  });

  it('anchor series stays strictly ascending & duplicate-free under insert/remove and round-trips', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('insert' as const), value: fc.integer({ min: -30, max: 30 }) }),
            fc.record({ op: fc.constant('remove' as const), sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }) }),
          ),
          { minLength: 1, maxLength: 30 },
        ),
        (ops) => {
          let anchors: readonly number[] = [];
          for (const op of ops) {
            if (op.op === 'insert') {
              anchors = insertAnchor(anchors, op.value);
            } else {
              const idx = anchors.length === 0 ? -1 : Math.min(anchors.length - 1, Math.floor(op.sel * anchors.length));
              anchors = removeAnchorAt(anchors, idx);
            }
            // Invariant after EVERY op: strictly ascending (=> sorted + unique).
            expect(anchorsAscendingUnique(anchors)).toBe(true);
            // save → load is the identity on the anchor series.
            expect(JSON.parse(JSON.stringify(anchors))).toEqual(anchors);
          }
          // Inserting a value already present is a no-op (set semantics).
          if (anchors.length > 0) {
            const existing = anchors[0];
            if (existing !== undefined) {
              expect(insertAnchor(anchors, existing)).toEqual(anchors);
            }
          }
        },
      ),
      cfg6,
    );
  });

  it('stateful: interleaved add / delete / nudge / anchor-insert / anchor-remove / save-load keeps the full bundle', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand6Arb(), { minLength: 5, maxLength: shape.rings.length + 14 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: GrowState = { shape, store, nextId: 0, anchors: [] };
          assertGrowBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-22003'))).toEqual(
              state.shape,
            );

            switch (cmd.tag) {
              case 'add-hole': {
                const leafTerritories = state.shape.rings.filter(
                  (r) => r.kind === RING_KIND.Territory && isLeafRing(state.shape, r.id),
                );
                if (leafTerritories.length === 0) break;
                const i = Math.min(
                  leafTerritories.length - 1,
                  Math.floor(cmd.sel * leafTerritories.length),
                );
                const target = leafTerritories[i];
                if (target === undefined) break;
                const before = state.shape.rings.length;
                const r = addHoleToLeafTerritory(state, target.id);
                if (r === undefined) break;
                state = r.state;
                expect(state.shape.rings.length).toBe(before + 1);
                assertGrowBundle(state);
                break;
              }
              case 'add-enclave': {
                const leafHoles = state.shape.rings.filter(
                  (r) => r.kind === RING_KIND.Hole && isLeafRing(state.shape, r.id),
                );
                if (leafHoles.length === 0) break;
                const i = Math.min(leafHoles.length - 1, Math.floor(cmd.sel * leafHoles.length));
                const target = leafHoles[i];
                if (target === undefined) break;
                const before = state.shape.rings.length;
                const r = addEnclaveToLeafHole(state, target.id);
                if (r === undefined) break;
                state = r.state;
                expect(state.shape.rings.length).toBe(before + 1);
                assertGrowBundle(state);
                break;
              }
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const before = state.shape.rings.length;
                state = { ...state, shape: deleteRingAndReorganize(state.shape, targetId) };
                expect(state.shape.rings.length).toBeLessThan(before);
                assertGrowBundle(state);
                break;
              }
              case 'nudge-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const beforeStore = state.store;
                const editState: EditState = { shape: state.shape, store: state.store };
                // Fractions of the target's OWN clearance: the grow stream keeps adding
                // children at 0.2× their parent, so any fixed absolute bound would
                // eventually exceed the real clearance and assert a false property.
                const dLon = scaledNudge(editState, targetId, cmd.fLon);
                const dLat = scaledNudge(editState, targetId, cmd.fLat);
                const moved = translateAnySubtree(editState, targetId, dLon, dLat);
                state = { ...state, store: moved };
                assertGrowBundle(state);
                // op∘inverse: nudge back restores prior coordinates (tight epsilon).
                const back = translateAnySubtree(
                  { shape: state.shape, store: state.store },
                  targetId,
                  -dLon,
                  -dLat,
                );
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
                // Insert is idempotent for an already-present value.
                if (before.includes(cmd.value)) expect(state.anchors).toEqual(before);
                assertGrowBundle(state);
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
                assertGrowBundle(state);
                break;
              }
              case 'save-load': {
                const reloaded = saveLoadGrowState(state);
                expect(reloaded.shape).toEqual(state.shape);
                expect(reloaded.anchors).toEqual(state.anchors);
                state = reloaded;
                assertGrowBundle(state);
                break;
              }
              default:
                break;
            }
          }
        },
      ),
      cfg6,
    );
  });
});
