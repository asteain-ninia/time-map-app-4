// Bug-hunt regression (U09 anchor-series + persistence schema): two entries in
// the SAME series that share an AnchorId must NOT pass validation and must NOT
// misroute by-id edits.
//
// The AnchorId is the routing key for every by-id edit: changeStart / setEnd /
// deleteAnchor all locate the target via indexOfAnchor, which is findIndex (the
// FIRST match). With two entries sharing an id, those edits silently act on the
// EARLIER occurrence regardless of which one the caller meant, and the later one
// is unreachable by id. Before the fix, validateSeries checked only INV-1..INV-5
// (start/end ordering) and never required id uniqueness, so a duplicate-id series
// with DISTINCT starts passed INV-1 (ascending) yet still misrouted; the
// persistence schema likewise did not constrain entry/anchor id uniqueness, so a
// corrupt / legacy / hand-edited manifest loaded the ambiguity silently.
//
// The fix adds INV-6 (per-series AnchorId uniqueness) to validateSeries, makes
// normalizeSeries collapse duplicate ids (keep-last) so every operation output
// is repaired, and adds a featureHistorySchema refinement rejecting duplicate
// anchor ids at the persistence boundary.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  changeStart,
  createAnchorEntry,
  deleteAnchor,
  normalizeSeries,
  validateSeries,
  type AnchorEntry,
  type AnchorSeries,
} from '../anchor-series';
import { makeAnchor } from '../anchor-series.arbitraries';
import { getCalendar } from '../time/calendar';
import { asAnchorId, asFeatureId } from '../ids';
import { timePointYear } from '../time/time-point';
import { featureHistorySchema } from '../persistence/schema';

const cal = getCalendar('gregorian');

// Builds an entry whose anchor id is fully under the caller's control, so two
// entries can be given the SAME id while carrying DISTINCT starts (the case that
// slips past INV-1's ascending-starts check).
function entryWithId(id: string, startYear: number, endYear: number | null): AnchorEntry {
  const a = makeAnchor(startYear, `-${startYear}`);
  return createAnchorEntry(
    { id: asAnchorId(id), snapshot: a.snapshot },
    timePointYear(startYear),
    endYear === null ? null : timePointYear(endYear),
  );
}

describe('duplicate AnchorId within a series (bug-hunt regression)', () => {
  it('validateSeries flags a duplicate id (INV-6) even with distinct ascending starts', () => {
    // Two DISTINCT starts (so INV-1 is satisfied) but a shared id.
    const bad: AnchorSeries = {
      entries: [entryWithId('dup', 100, null), entryWithId('dup', 200, null)],
    };
    const res = validateSeries(bad, cal);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.violations.some((v) => v.invariant === 'INV-6')).toBe(true);
      // No INV-1 violation: the starts ARE ascending — only the id collides.
      expect(res.violations.some((v) => v.invariant === 'INV-1')).toBe(false);
      const inv6 = res.violations.find((v) => v.invariant === 'INV-6')!;
      expect(inv6.anchorIds).toContain(asAnchorId('dup'));
    }
  });

  it('normalizeSeries collapses a duplicate id (keep-last) so the output is valid', () => {
    const s = normalizeSeries(
      [entryWithId('dup', 100, null), entryWithId('dup', 200, null)],
      cal,
    );
    // Exactly one entry survives, and it is the LAST occurrence (start 200).
    expect(s.entries.length).toBe(1);
    expect(s.entries[0]!.start).toEqual(timePointYear(200));
    expect(validateSeries(s, cal).ok).toBe(true);
  });

  it('by-id edits no longer misroute: a normalized series has one entry per id', () => {
    // After normalization the duplicate is gone, so changeStart/deleteAnchor act
    // on the single canonical entry — never the wrong occurrence.
    const s = normalizeSeries(
      [entryWithId('dup', 100, null), entryWithId('keep', 300, null)],
      cal,
    );
    const moved = changeStart(s, asAnchorId('dup'), timePointYear(150), cal);
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(validateSeries(moved.series, cal).ok).toBe(true);
      // 'dup' resolves to exactly one entry, now starting at 150.
      const dupEntries = moved.series.entries.filter((e) => e.anchor.id === asAnchorId('dup'));
      expect(dupEntries.length).toBe(1);
      expect(dupEntries[0]!.start).toEqual(timePointYear(150));
    }
    const deleted = deleteAnchor(s, asAnchorId('dup'), cal);
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.series.entries.some((e) => e.anchor.id === asAnchorId('dup'))).toBe(false);
    }
  });

  it('persistence schema rejects a series carrying duplicate anchor ids', () => {
    const dupAnchor = (id: string) => ({
      id,
      snapshot: { features: [], vertices: [] },
    });
    const history = {
      featureId: 'f-1',
      entries: [
        { anchor: dupAnchor('a-dup'), start: { granularity: 'year', year: 100 }, end: null },
        { anchor: dupAnchor('a-dup'), start: { granularity: 'year', year: 200 }, end: null },
      ],
    };
    const parsed = featureHistorySchema.safeParse(history);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const dupIssue = parsed.error.issues.find((i) =>
        i.message.includes('duplicate anchor id'),
      );
      expect(dupIssue).toBeDefined();
      // Reported at the OFFENDING later entry (path-tagged rejection, 教訓 5.26).
      expect(dupIssue!.path).toEqual(['entries', 1, 'anchor', 'id']);
    }
  });

  it('persistence schema accepts a series whose anchor ids are all distinct', () => {
    const history = {
      featureId: 'f-1',
      entries: [
        {
          anchor: { id: 'a-1', snapshot: { features: [], vertices: [] } },
          start: { granularity: 'year', year: 100 },
          end: null,
        },
        {
          anchor: { id: 'a-2', snapshot: { features: [], vertices: [] } },
          start: { granularity: 'year', year: 200 },
          end: null,
        },
      ],
    };
    expect(featureHistorySchema.safeParse(history).success).toBe(true);
    // featureId asAnchorId import kept meaningful: ids are branded at the domain
    // edge, mirrored here so the test exercises the same string shape the loader
    // would carry.
    void asFeatureId;
  });

  it('property: normalizeSeries always yields a duplicate-free, valid series', () => {
    fc.assert(
      fc.property(
        // A pool of ids with deliberate collisions: indices map into a small set
        // of ids, so many generated series carry duplicates.
        fc.array(
          fc.record({
            idIndex: fc.integer({ min: 0, max: 3 }),
            startYear: fc.integer({ min: -300, max: 300 }),
            hasEnd: fc.boolean(),
            endOffset: fc.integer({ min: 1, max: 50 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (specs) => {
          const ids = ['a-x', 'a-y', 'a-z', 'a-w'];
          const entries = specs.map((sp) =>
            entryWithId(
              ids[sp.idIndex]!,
              sp.startYear,
              sp.hasEnd ? sp.startYear + sp.endOffset : null,
            ),
          );
          const s = normalizeSeries(entries, cal);
          // No duplicate ids survive.
          const seen = new Set<string>();
          for (const e of s.entries) {
            expect(seen.has(e.anchor.id)).toBe(false);
            seen.add(e.anchor.id);
          }
          // And the full invariant set (incl. INV-6) holds.
          expect(validateSeries(s, cal).ok).toBe(true);
        },
      ),
    );
  });
});
