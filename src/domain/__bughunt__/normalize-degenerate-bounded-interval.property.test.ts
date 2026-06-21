// Bug-hunt regression (U09 anchor-series): normalizeSeries must NOT silently
// convert a degenerate bounded interval (own end <= own start) into an
// open-ended (end === null) entry. Doing so would resurrect a feature that was
// meant to stop existing as one that exists forever — contradicting the guarded
// edit paths (changeStart's `startNotBeforeEnd`, setEnd's `endNotAfterStart`)
// and INV-3 / FR-56. The correct recovery is to DROP the degenerate entry,
// preserving the remaining valid anchors while keeping the series non-empty
// (INV-5). This path is reachable from persistence repair (normalizeHistories)
// and applyPastEdit, not just from hand-built series.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  createAnchorEntry,
  normalizeSeries,
  resolveAt,
  validateSeries,
  type AnchorEntry,
} from '../anchor-series';
import { makeAnchor } from '../anchor-series.arbitraries';
import { getCalendar } from '../time/calendar';
import { compare } from '../time/normalized';
import { timePointYear } from '../time/time-point';

const cal = getCalendar('gregorian');

function entry(seed: number, startYear: number, endYear: number | null): AnchorEntry {
  return createAnchorEntry(
    makeAnchor(seed, `-${seed}`),
    timePointYear(startYear),
    endYear === null ? null : timePointYear(endYear),
  );
}

describe('normalizeSeries — degenerate bounded interval (bug-hunt regression)', () => {
  it('drops an entry whose own end equals its start (never reopens to null)', () => {
    // The degenerate entry sits between two valid open-ended anchors.
    const s = normalizeSeries(
      [entry(1, 100, null), entry(2, 200, 200), entry(3, 300, null)],
      cal,
    );
    // The degenerate entry (start 200, end 200) must be GONE, not resurrected.
    expect(s.entries.map((e) => e.anchor.id)).toEqual([
      makeAnchor(1, '-1').id,
      makeAnchor(3, '-3').id,
    ]);
    // The degenerate anchor must not be the entry effective at its own start:
    // it carried no valid existence and is dropped, so whatever the prior
    // open-ended anchor (entry-1) covers is what resolves at year 200.
    const at200 = resolveAt(s, timePointYear(200), cal);
    expect(at200.kind === 'present' && at200.entry.anchor.id).not.toBe(
      makeAnchor(2, '-2').id,
    );
    expect(validateSeries(s, cal).ok).toBe(true);
  });

  it('drops an entry whose own end precedes its start (negative span)', () => {
    const s = normalizeSeries(
      [entry(1, 100, null), entry(2, 250, 200), entry(3, 300, null)],
      cal,
    );
    expect(s.entries.some((e) => e.anchor.id === makeAnchor(2, '-2').id)).toBe(false);
    expect(validateSeries(s, cal).ok).toBe(true);
  });

  it('keeps one open-ended entry when EVERY entry is degenerate (INV-5 fallback)', () => {
    const s = normalizeSeries([entry(1, 100, 100), entry(2, 200, 150)], cal);
    expect(s.entries.length).toBe(1);
    expect(validateSeries(s, cal).ok).toBe(true);
  });

  it('property: no surviving entry was reopened from a degenerate bounded input', () => {
    // Generate arbitrary entries on distinct ascending starts, each either
    // open-ended, validly bounded, or DEGENERATE (end <= start). After
    // normalization: (a) the result is always valid & non-empty, and (b) no
    // entry that was degenerate on input survives with end === null.
    const entriesArb = fc
      .uniqueArray(fc.integer({ min: -300, max: 300 }), { minLength: 1, maxLength: 6 })
      .chain((starts) =>
        fc
          .array(
            fc.oneof(
              fc.constant<{ kind: 'open' }>({ kind: 'open' }),
              fc.constant<{ kind: 'degenerate' }>({ kind: 'degenerate' }),
              fc.integer({ min: 1, max: 50 }).map((d) => ({ kind: 'bounded' as const, d })),
            ),
            { minLength: starts.length, maxLength: starts.length },
          )
          .map((kinds) => ({ starts, kinds })),
      );

    fc.assert(
      fc.property(entriesArb, ({ starts, kinds }) => {
        const degenerateIds = new Set<string>();
        const built: AnchorEntry[] = starts.map((startYear, i) => {
          const k = kinds[i]!;
          const a = makeAnchor(i, `-${startYear}`);
          let endYear: number | null = null;
          if (k.kind === 'bounded') {
            endYear = startYear + k.d;
          } else if (k.kind === 'degenerate') {
            // end <= start: equal or strictly before.
            endYear = startYear - (i % 2); // start-0 (equal) or start-1 (before)
            degenerateIds.add(a.id);
          }
          return createAnchorEntry(a, timePointYear(startYear), endYear === null ? null : timePointYear(endYear));
        });

        const result = normalizeSeries(built, cal);

        // Always non-empty and valid.
        expect(result.entries.length).toBeGreaterThanOrEqual(1);
        expect(validateSeries(result, cal).ok).toBe(true);

        // No entry that was degenerate on input survives as an eternal feature,
        // EXCEPT the INV-5 fallback when every entry was degenerate (then the
        // earliest survivor is intentionally reopened — but only one survives).
        const allDegenerate = built.every((e) => degenerateIds.has(e.anchor.id));
        for (const e of result.entries) {
          if (degenerateIds.has(e.anchor.id) && e.end === null) {
            // Allowed only as the lone INV-5 fallback.
            expect(allDegenerate).toBe(true);
            expect(result.entries.length).toBe(1);
          }
        }

        // Every surviving bounded end is strictly after its own start (INV-3).
        for (const e of result.entries) {
          if (e.end !== null) {
            expect(compare(e.start, e.end, cal) < 0).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
