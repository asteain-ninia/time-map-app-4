// U22 context-analysis property tests (NFR 5.8 / fast-check). For ANY vertex set
// and ANY ownership map, the single-owner classification has no false positive
// and no false negative (spec テスト「fast-check で偽陽性／偽陰性を出さない」).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { asFeatureId, asVertexId, type FeatureId, type VertexId } from '../ids';

import { ownerLookupFromMap } from './contracts';
import { CONTEXT_KIND, analyzeVertexContext } from './context';

// A vertex id plus its (possibly absent) owner. Absent owner = a dangling vertex.
interface Entry {
  readonly vid: VertexId;
  readonly owner: FeatureId | null;
}

function entryArb(): fc.Arbitrary<Entry> {
  return fc
    .record({
      v: fc.string({ minLength: 1, maxLength: 4 }),
      owner: fc.option(fc.constantFrom('A', 'B', 'C'), { nil: null }),
    })
    .map(({ v, owner }) => ({
      vid: asVertexId(`v-${v}`),
      owner: owner === null ? null : asFeatureId(owner),
    }));
}

function buildLookup(entries: readonly Entry[]) {
  const m = new Map<VertexId, FeatureId>();
  for (const e of entries) if (e.owner !== null) m.set(e.vid, e.owner);
  return ownerLookupFromMap(m);
}

describe('analyzeVertexContext — no false positive / negative (NFR 5.8)', () => {
  it('classifies Single iff every selected vertex resolves to one same owner', () => {
    fc.assert(
      fc.property(fc.array(entryArb(), { maxLength: 12 }), (entries) => {
        // Deduplicate by vid (a Set models the selection set; later wins like Map).
        const byVid = new Map<VertexId, FeatureId | null>();
        for (const e of entries) byVid.set(e.vid, e.owner);
        const selection = new Set(byVid.keys());
        const lookup = buildLookup(
          [...byVid].map(([vid, owner]) => ({ vid, owner })),
        );

        const ctx = analyzeVertexContext(selection, lookup);

        // Ground truth computed independently from the raw set (教訓 5.10).
        const ownersResolved = [...byVid.values()];
        const anyUnknown = ownersResolved.some((o) => o === null);
        const distinct = new Set(ownersResolved.filter((o) => o !== null));

        if (selection.size === 0) {
          expect(ctx.kind).toBe(CONTEXT_KIND.Empty);
        } else if (anyUnknown) {
          expect(ctx.kind).toBe(CONTEXT_KIND.Unknown);
        } else if (distinct.size === 1) {
          expect(ctx.kind).toBe(CONTEXT_KIND.Single);
          if (ctx.kind === CONTEXT_KIND.Single) {
            expect(distinct.has(ctx.ownerFeatureId)).toBe(true);
          }
        } else {
          expect(ctx.kind).toBe(CONTEXT_KIND.Multi);
        }
      }),
    );
  });

  it('Single is reported ONLY when there is exactly one owner and no unknowns', () => {
    fc.assert(
      fc.property(fc.array(entryArb(), { minLength: 1, maxLength: 12 }), (entries) => {
        const byVid = new Map<VertexId, FeatureId | null>();
        for (const e of entries) byVid.set(e.vid, e.owner);
        const selection = new Set(byVid.keys());
        const lookup = buildLookup([...byVid].map(([vid, owner]) => ({ vid, owner })));
        const ctx = analyzeVertexContext(selection, lookup);

        if (ctx.kind === CONTEXT_KIND.Single) {
          const owners = [...byVid.values()];
          expect(owners.every((o) => o !== null)).toBe(true);
          expect(new Set(owners).size).toBe(1);
        }
      }),
    );
  });
});
