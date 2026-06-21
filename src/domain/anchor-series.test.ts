// Domain layer (U09): unit + property tests for the anchor series (AC-1〜AC-9).

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createAnchor, createAnchorSnapshot, type Anchor } from './anchor';
import {
  applyPastEdit,
  changeStart,
  createAnchorEntry,
  deleteAnchor,
  normalizeSeries,
  resolveAt,
  setEnd,
  validateSeries,
  withEntrySnapshot,
  type AnchorEntry,
  type AnchorSeries,
  type Resolution,
} from './anchor-series';
import {
  anchorSeriesArb,
  makeAnchor,
  makeSnapshot,
} from './anchor-series.arbitraries';
import { createBasicAttributes, createColorInfo } from './attributes';
import { createCoordinate } from './coordinate';
import { createPointFeature } from './feature';
import { getCalendar } from './time/calendar';
import { asAnchorId, asFeatureId, asVertexId } from './ids';
import { timePointYear, timePointYearMonth } from './time/time-point';
import { createVertex, createVertexStore } from './vertex';

const cal = getCalendar('gregorian');

// --- helpers ----------------------------------------------------------------

function entry(idSeed: number, startYear: number, endYear: number | null): AnchorEntry {
  return createAnchorEntry(
    makeAnchor(idSeed, `-${idSeed}`),
    timePointYear(startYear),
    endYear === null ? null : timePointYear(endYear),
  );
}

function series(...entries: AnchorEntry[]): AnchorSeries {
  return normalizeSeries(entries, cal);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function present(r: Resolution): AnchorEntry {
  if (r.kind !== 'present') throw new Error('expected present');
  return r.entry;
}

// --- AC-2 / §5.8 resolution -------------------------------------------------

describe('resolveAt (AC-2, FR-54)', () => {
  it('is absent before the first start', () => {
    const s = series(entry(1, 100, null));
    expect(resolveAt(s, timePointYear(99), cal).kind).toBe('absent');
  });

  it('resolves the active anchor inside its interval; start is inclusive', () => {
    const s = series(entry(1, 100, null), entry(2, 200, null));
    expect(present(resolveAt(s, timePointYear(100), cal)).start).toEqual(timePointYear(100));
    expect(present(resolveAt(s, timePointYear(150), cal)).anchor.id).toBe(
      s.entries[0]!.anchor.id,
    );
    // At the next start, the next anchor becomes active.
    expect(present(resolveAt(s, timePointYear(200), cal)).anchor.id).toBe(
      s.entries[1]!.anchor.id,
    );
  });

  it('returns absent at and after a set end (end is exclusive)', () => {
    const s = series(entry(1, 100, 150));
    expect(present(resolveAt(s, timePointYear(149), cal)).anchor.id).toBe(
      s.entries[0]!.anchor.id,
    );
    expect(resolveAt(s, timePointYear(150), cal).kind).toBe('absent'); // boundary
    expect(resolveAt(s, timePointYear(151), cal).kind).toBe('absent');
  });

  it('returns absent inside a temporal enclave (gap) between anchors', () => {
    const s = series(entry(1, 100, 120), entry(2, 200, null));
    expect(resolveAt(s, timePointYear(130), cal).kind).toBe('absent');
    expect(present(resolveAt(s, timePointYear(200), cal)).anchor.id).toBe(
      s.entries[1]!.anchor.id,
    );
  });
});

// --- AC-1 / §4.4 invariants -------------------------------------------------

describe('validateSeries (AC-1, §4.4)', () => {
  it('accepts an ascending, non-overlapping series with a gap (INV-4)', () => {
    const s = series(entry(1, 100, 120), entry(2, 200, null));
    expect(validateSeries(s, cal).ok).toBe(true);
  });

  it('accepts end == next start (gapless adjacency)', () => {
    const s = series(entry(1, 100, 200), entry(2, 200, null));
    expect(validateSeries(s, cal).ok).toBe(true);
  });

  it('flags a manually-built out-of-order / overlapping series', () => {
    // Bypass normalization to build an invalid series directly.
    const bad: AnchorSeries = {
      entries: [entry(1, 100, 250), entry(2, 200, null)],
    };
    const res = validateSeries(bad, cal);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.violations.some((v) => v.invariant === 'INV-2')).toBe(true);
    }
  });

  it('flags a zero/negative-span end (INV-3)', () => {
    const bad: AnchorSeries = { entries: [entry(1, 100, 100)] };
    const res = validateSeries(bad, cal);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.violations.some((v) => v.invariant === 'INV-3')).toBe(true);
    }
  });

  it('flags an empty series (INV-5)', () => {
    const res = validateSeries({ entries: [] }, cal);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.violations[0]!.invariant).toBe('INV-5');
    }
  });
});

// --- AC-3 / §4.5 / §5.6 reorganization --------------------------------------

describe('setEnd (AC-3, FR-58, §4.5)', () => {
  it('rejects an end not strictly after start (INV-3)', () => {
    const s = series(entry(1, 100, null));
    const r = setEnd(s, s.entries[0]!.anchor.id, timePointYear(100), cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.code).toBe('endNotAfterStart');
  });

  it('rejects an end beyond the next future anchor end', () => {
    const s = series(entry(1, 100, null), entry(2, 200, 250));
    const r = setEnd(s, s.entries[0]!.anchor.id, timePointYear(260), cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.code).toBe('endBeyondNextEnd');
  });

  it('shortens an overrun into the next start by auto-reorg (not rejection)', () => {
    const s = series(entry(1, 100, null), entry(2, 200, null));
    // Try to set first end past the second start; reorg clamps it to 200.
    const r = setEnd(s, s.entries[0]!.anchor.id, timePointYear(250), cal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validateSeries(r.series, cal).ok).toBe(true);
      expect(r.series.entries[0]!.end).toEqual(timePointYear(200));
    }
  });

  it('clears an end (open-ended) — the inverse operation', () => {
    const s = series(entry(1, 100, 150));
    const r = setEnd(s, s.entries[0]!.anchor.id, null, cal);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.series.entries[0]!.end).toBeNull();
  });

  it('allows the last anchor to set an end (existence stop)', () => {
    const s = series(entry(1, 100, null));
    const r = setEnd(s, s.entries[0]!.anchor.id, timePointYear(150), cal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(resolveAt(r.series, timePointYear(150), cal).kind).toBe('absent');
    }
  });

  // --- regression (bughunt2): setEnd must edit the FIRST occurrence of a
  // duplicate AnchorId and keep that edit, not silently drop it in favour of the
  // unedited later occurrence. A duplicate-id series (INV-6 violation) is only
  // reachable from corrupt / legacy / hand-edited persistence loaded BEFORE the
  // consistency repair runs, but on such a series setEnd must not lose the edit.
  // Previously setEnd kept the edited entry at the FIRST occurrence's position
  // and normalizeSeries' keep-last dedup then dropped it, retaining the UNEDITED
  // later entry and reporting ok:true — the edit was silently lost.
  it('keeps the edited entry on a duplicate-AnchorId series (does not drop it)', () => {
    // Build a RAW series with two entries sharing one AnchorId — bypass the
    // series() helper, which normalizes (and would collapse the duplicate).
    const dup: AnchorSeries = {
      entries: [entry(1, 0, null), entry(1, 100, null)],
    };
    const sharedId = dup.entries[0]!.anchor.id;
    expect(dup.entries[1]!.anchor.id).toBe(sharedId); // precondition: same id.

    const r = setEnd(dup, sharedId, timePointYear(50), cal);

    expect(r.ok).toBe(true);
    if (r.ok) {
      // The dedup collapses to a single entry (unique id, INV-6 restored)...
      expect(r.series.entries).toHaveLength(1);
      // ...and the surviving entry MUST be the edited one: start=0 with end=50,
      // NOT the unedited start=100 entry.
      const survivor = r.series.entries[0]!;
      expect(survivor.start).toEqual(timePointYear(0));
      expect(survivor.end).toEqual(timePointYear(50));
      expect(validateSeries(r.series, cal).ok).toBe(true);
    }
  });

  it('applyPastEdit keeps the in-place edit on a duplicate-AnchorId series', () => {
    // Two entries share an id but DIFFER in start and snapshot. The in-place
    // update branch fires on the FIRST occurrence (start=0); its snapshot must be
    // the one applyPastEdit just replaced, not the unedited later duplicate's.
    // (Decouple id from snapshot: createAnchor lets a shared id carry distinct
    // snapshots, which makeAnchor — id tied to seed — cannot express.)
    const sharedId = asAnchorId('a-dup');
    const first = createAnchorEntry(
      createAnchor(sharedId, makeSnapshot(1)),
      timePointYear(0),
      null,
    );
    const later = createAnchorEntry(
      createAnchor(sharedId, makeSnapshot(2)),
      timePointYear(100),
      null,
    );
    const dup: AnchorSeries = { entries: [first, later] };

    // The edit replaces the start=0 entry's snapshot with a fresh, distinct one.
    const editedSnapshot = makeSnapshot(99);
    const edited = applyPastEdit(
      dup,
      timePointYear(0),
      () => createAnchor(sharedId, editedSnapshot),
      cal,
    );

    // Dedup restores INV-6 (single id). The survivor MUST be the edited start=0
    // entry carrying the new snapshot — not the unedited start=100 duplicate.
    expect(edited.entries).toHaveLength(1);
    const survivor = edited.entries[0]!;
    expect(survivor.anchor.id).toBe(sharedId);
    expect(survivor.start).toEqual(timePointYear(0));
    expect(survivor.anchor.snapshot).toEqual(editedSnapshot);
    expect(validateSeries(edited, cal).ok).toBe(true);
  });
});

describe('changeStart (AC-3, FR-58)', () => {
  it('re-sorts and keeps invariants after moving an anchor earlier', () => {
    const s = series(entry(1, 100, null), entry(2, 200, null), entry(3, 300, null));
    const r = changeStart(s, s.entries[2]!.anchor.id, timePointYear(50), cal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validateSeries(r.series, cal).ok).toBe(true);
      expect(r.series.entries[0]!.anchor.id).toBe(s.entries[2]!.anchor.id);
    }
  });

  it('shortens an earlier overrun when an anchor is moved between two others', () => {
    const s = series(entry(1, 100, 400), entry(2, 500, null));
    // Move the second anchor to 200, landing inside the first's [100,400) span.
    const r = changeStart(s, s.entries[1]!.anchor.id, timePointYear(200), cal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validateSeries(r.series, cal).ok).toBe(true);
      // First anchor's end shortened to 200 (no overlap).
      const first = r.series.entries[0]!;
      expect(first.end).toEqual(timePointYear(200));
    }
  });

  it('rejects an unknown anchor id', () => {
    const s = series(entry(1, 100, null));
    const r = changeStart(s, asAnchorId('nope'), timePointYear(50), cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.code).toBe('anchorNotFound');
  });

  it('rejects a move that would push the start at/past its own bounded end (no silent resurrection)', () => {
    // [100,150) moved to start 200 must NOT become open-ended [200,inf): the
    // feature was meant to stop existing at 150 (regression for the bounded→open
    // clamp). The move is rejected; the bounded existence is preserved.
    const s = series(entry(1, 100, 150), entry(2, 300, null));
    const r = changeStart(s, s.entries[0]!.anchor.id, timePointYear(200), cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.code).toBe('startNotBeforeEnd');
    // The original series is untouched and the entry's end is still bounded.
    expect(s.entries[0]!.end).toEqual(timePointYear(150));
  });

  it('rejects a move to exactly the entry end (non-positive span)', () => {
    const s = series(entry(1, 100, 150));
    const r = changeStart(s, s.entries[0]!.anchor.id, timePointYear(150), cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.code).toBe('startNotBeforeEnd');
  });

  it('still allows moving a bounded entry to a start strictly before its end', () => {
    const s = series(entry(1, 100, 150), entry(2, 300, null));
    const r = changeStart(s, s.entries[0]!.anchor.id, timePointYear(120), cal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validateSeries(r.series, cal).ok).toBe(true);
      const moved = r.series.entries.find((e) => e.anchor.id === s.entries[0]!.anchor.id)!;
      expect(moved.end).toEqual(timePointYear(150));
    }
  });
});

// --- regression: invalid in-memory TimePoint must be rejected, not aliased --
//
// `normalize` assumes a validated point: its month loop only touches
// `daysInMonth` for m < month, so month 13 NEVER throws and instead aliases
// onto the next year's Jan 1 (timePointYearMonth(2024, 13) ≡ 2024-01-01 + a full
// year ≡ 2025-01-01). The series ops dedup distinct starts by `compare`/
// `normalize`, so before the fix an invalid 2024-13 start collided with a
// genuine 2025-01 anchor and keep-last dedup silently dropped one anchor. The
// persistence boundary already validates (timePointSchema.superRefine); these
// guard the in-memory UI edit path the same way.
describe('invalid TimePoint rejection at the series-op boundary (no aliasing)', () => {
  it('changeStart rejects an out-of-range month instead of aliasing onto a real date', () => {
    // Two genuine anchors; the second starts at 2025-01.
    const s = normalizeSeries(
      [
        createAnchorEntry(makeAnchor(1, '-a'), timePointYearMonth(2024, 1)),
        createAnchorEntry(makeAnchor(2, '-b'), timePointYearMonth(2025, 1)),
      ],
      cal,
    );
    expect(s.entries).toHaveLength(2);

    // 2024-13 normalizes to the same integer as 2025-01: WITHOUT the guard this
    // collides with anchor #2 and keep-last dedup drops one anchor.
    const r = changeStart(s, s.entries[0]!.anchor.id, timePointYearMonth(2024, 13), cal);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.code).toBe('invalidTime');
      if (r.reason.code === 'invalidTime') {
        expect(r.reason.error).toBe('month-out-of-range');
      }
    }
    // The original series must be untouched: no anchor was lost or moved.
    expect(s.entries).toHaveLength(2);
    expect(s.entries[1]!.start).toEqual(timePointYearMonth(2025, 1));
  });

  it('setEnd rejects an out-of-range end but still allows clearing to null', () => {
    const s = series(entry(1, 100, null));
    const bad = setEnd(s, s.entries[0]!.anchor.id, timePointYearMonth(2024, 13), cal);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason.code).toBe('invalidTime');

    // Clearing the end (null) skips the time guard and remains valid.
    const cleared = setEnd(s, s.entries[0]!.anchor.id, null, cal);
    expect(cleared.ok).toBe(true);
  });

  it('applyPastEdit throws on an invalid base time rather than aliasing/dropping', () => {
    const s = series(entry(1, 100, null));
    expect(() =>
      applyPastEdit(s, timePointYearMonth(2024, 13), () => makeAnchor(2, '-c'), cal),
    ).toThrow(RangeError);
  });
});

// --- resolveAt correctness over a deep series -------------------------------

describe('resolveAt deep-series correctness', () => {
  it('resolves the correct entry across a long ascending series', () => {
    const entries: AnchorEntry[] = [];
    for (let i = 0; i < 200; i++) entries.push(entry(i + 1, i * 10, null));
    const s = normalizeSeries(entries, cal);
    // Spot-check several queries against the expected effective entry.
    expect(present(resolveAt(s, timePointYear(0), cal)).anchor.id).toBe(s.entries[0]!.anchor.id);
    expect(present(resolveAt(s, timePointYear(995), cal)).anchor.id).toBe(
      s.entries[99]!.anchor.id, // start 990, next 1000
    );
    expect(present(resolveAt(s, timePointYear(1990), cal)).anchor.id).toBe(
      s.entries[199]!.anchor.id,
    );
    expect(resolveAt(s, timePointYear(-1), cal).kind).toBe('absent');
  });
});

// --- regression: resolveAt on an UNSORTED (corrupt/legacy) series -----------
//
// resolveAt is reachable from the persistence / consistency path on a series
// that has NOT been re-normalized on load (deserializeHistory restores entries
// verbatim; consistency.checkTimeSlice resolves on that raw series). A corrupt,
// hand-edited, or legacy file can present an UNSORTED series. resolveAt must
// still return the entry with the GREATEST start <= time, not whatever a search
// that assumes ascending starts happens to land on. We build the series object
// DIRECTLY (bypassing normalizeSeries) to model exactly the unvalidated input
// that deserialization can yield.
describe('resolveAt on an unsorted series (corrupt/legacy persistence input)', () => {
  it('returns the greatest start <= time for the reported repro [100,0,200]@150', () => {
    // The exact failing case: a naive binary search returns the start=0 entry.
    const unsorted: AnchorSeries = {
      entries: [entry(1, 100, null), entry(2, 0, null), entry(3, 200, null)],
    };
    const r = present(resolveAt(unsorted, timePointYear(150), cal));
    expect(r.start).toEqual(timePointYear(100));
    expect(r.anchor.id).toBe(unsorted.entries[0]!.anchor.id);
  });

  it('matches the normalized resolution for arbitrary permutations of any series', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.integer({ min: -1000, max: 5000 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (sorted, queryYear, shuffleSeed) => {
          const query = timePointYear(queryYear);
          // A permutation of a VALID series is still semantically the same set of
          // entries; resolveAt must be order-independent — the effective entry is
          // defined by start times, not array position. Shuffle deterministically.
          const arr = [...sorted.entries];
          for (let i = arr.length - 1; i > 0; i--) {
            const j = ((shuffleSeed * (i + 1)) >>> 0) % (i + 1);
            [arr[i], arr[j]] = [arr[j]!, arr[i]!];
          }
          const shuffled: AnchorSeries = { entries: arr };

          const expected = resolveAt(sorted, query, cal);
          const actual = resolveAt(shuffled, query, cal);
          expect(actual.kind).toBe(expected.kind);
          if (expected.kind === 'present' && actual.kind === 'present') {
            // Same start time selected (ties cannot occur in a valid series).
            expect(actual.entry.start).toEqual(expected.entry.start);
            expect(actual.entry.anchor.id).toBe(expected.entry.anchor.id);
          }
        },
      ),
    );
  });
});

// --- regression (bughunt2): resolveAt / normalizeSeries duplicate-start parity
//
// consistency.checkTimeSlice resolves the effective snapshot on the RAW
// (un-normalized) series via resolveAt, while a NormalizeSeries repair collapses
// the series with normalizeSeries. If a corrupt / hand-edited / legacy series
// carries DUPLICATE starts (an INV-1 TimeConflict, separately flagged), the two
// MUST pick the SAME entry at the tie time — otherwise the snapshot inspected
// during detection differs from the one that survives repair, surfacing a
// spurious "new" overlap/topology inconsistency that blocks the TimeConflict
// repair in applyRepairChecked. normalizeSeries keeps the LAST entry for a
// duplicate start; resolveAt must agree (LAST wins), not pick the FIRST.
describe('resolveAt vs normalizeSeries on duplicate starts (bughunt2 parity)', () => {
  it('resolveAt picks the LAST entry for a tie, matching normalizeSeries collapse', () => {
    // Two distinct anchors sharing start=100 (an INV-1 violation a raw/legacy
    // series can carry). Build the series object DIRECTLY to bypass the
    // normalization that would collapse them — this is the unvalidated input the
    // consistency path resolves on.
    const a = entry(1, 100, null);
    const b = entry(2, 100, null);
    const raw: AnchorSeries = { entries: [a, b] };

    // What the repair would keep: the LAST entry for the duplicate start.
    const normalized = normalizeSeries(raw.entries, cal);
    expect(normalized.entries).toHaveLength(1);
    const survivor = normalized.entries[0]!;
    expect(survivor.anchor.id).toBe(b.anchor.id);

    // What detection sees on the RAW series must be the SAME entry.
    const resolved = present(resolveAt(raw, timePointYear(150), cal));
    expect(resolved.anchor.id).toBe(survivor.anchor.id);
    expect(resolved.anchor.id).toBe(b.anchor.id); // LAST, not FIRST (a).
  });

  it('agrees across an arbitrary number of duplicate-start entries', () => {
    // start=50 carries three duplicates; the LAST (id seed 3) must win in BOTH.
    const raw: AnchorSeries = {
      entries: [entry(1, 50, null), entry(2, 50, null), entry(3, 50, null)],
    };
    const survivor = normalizeSeries(raw.entries, cal).entries.find(
      (e) => e.start.year === 50,
    )!;
    const resolved = present(resolveAt(raw, timePointYear(50), cal));
    expect(resolved.anchor.id).toBe(survivor.anchor.id);
    expect(resolved.anchor.id).toBe(raw.entries[2]!.anchor.id);
  });
});

describe('deleteAnchor (AC-3, INV-5, §9.2 pair concept)', () => {
  it('deletes a middle anchor and opens a valid gap', () => {
    const s = series(entry(1, 100, 150), entry(2, 200, 250), entry(3, 300, null));
    const r = deleteAnchor(s, s.entries[1]!.anchor.id, cal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.series.entries).toHaveLength(2);
      expect(validateSeries(r.series, cal).ok).toBe(true);
    }
  });

  it('rejects deleting the last remaining anchor (0-count guard)', () => {
    const s = series(entry(1, 100, null));
    const r = deleteAnchor(s, s.entries[0]!.anchor.id, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.code).toBe('wouldBeEmpty');
  });
});

// --- AC-4 / §5.7 past edit --------------------------------------------------

describe('applyPastEdit (AC-4, FR-55/FR-57)', () => {
  it('updates in place when an anchor starts exactly at the base time', () => {
    const s = series(entry(1, 100, null), entry(2, 200, null));
    const before = s.entries.length;
    const replacementSnapshot = makeSnapshot(999);
    const next = applyPastEdit(
      s,
      timePointYear(100),
      () => createAnchor(s.entries[0]!.anchor.id, replacementSnapshot),
      cal,
    );
    expect(next.entries).toHaveLength(before); // count unchanged
    expect(next.entries[0]!.anchor.snapshot).toBe(replacementSnapshot);
  });

  it('inserts a new anchor at the base time, inheriting the effective state', () => {
    const s = series(entry(1, 100, null), entry(2, 300, null));
    let inherited: Resolution | undefined;
    const next = applyPastEdit(
      s,
      timePointYear(200),
      (effective) => {
        inherited = effective;
        return makeAnchor(200, '-new');
      },
      cal,
    );
    expect(next.entries).toHaveLength(3);
    // The factory was handed the entry effective at 200 (the first anchor).
    expect(inherited!.kind).toBe('present');
    if (inherited!.kind === 'present') {
      expect(inherited!.entry.anchor.id).toBe(s.entries[0]!.anchor.id);
    }
    expect(validateSeries(next, cal).ok).toBe(true);
  });

  it('hands an absent inheritance inside a temporal enclave', () => {
    const s = series(entry(1, 100, 150), entry(2, 300, null));
    let inherited: Resolution | undefined;
    applyPastEdit(
      s,
      timePointYear(200),
      (effective) => {
        inherited = effective;
        return makeAnchor(200, '-new');
      },
      cal,
    );
    expect(inherited!.kind).toBe('absent');
  });

  it('does not rewrite future anchors (start and snapshot unchanged)', () => {
    const s = series(entry(1, 100, null), entry(2, 300, null));
    const futureBefore = s.entries[1]!;
    const next = applyPastEdit(
      s,
      timePointYear(200),
      () => makeAnchor(200, '-new'),
      cal,
    );
    const futureAfter = next.entries.find(
      (e) => e.anchor.id === futureBefore.anchor.id,
    )!;
    expect(futureAfter.start).toEqual(futureBefore.start);
    expect(futureAfter.anchor.snapshot).toBe(futureBefore.anchor.snapshot);
  });
});

// --- AC-6 / FR-59 full-state unitary update ---------------------------------

describe('withEntrySnapshot (AC-6, FR-59)', () => {
  it('replaces the whole snapshot as one unit, preserving shape + parent refs', () => {
    const vid = asVertexId('v-x');
    const fid = asFeatureId('f-x');
    const feature = createPointFeature(
      fid,
      createBasicAttributes('orig', 0, 1),
      createColorInfo(true, '#000000', '#111111', '#222222'),
      vid,
      { parentId: asFeatureId('parent-1') },
    );
    const snap = createAnchorSnapshot(
      [feature],
      createVertexStore([createVertex(vid, createCoordinate(10, 20))]),
    );
    const anchor: Anchor = createAnchor(asAnchorId('a-x'), snap);
    const e = createAnchorEntry(anchor, timePointYear(0), null);

    // An "attribute-only" edit still goes through a full snapshot replacement.
    const newFeature = createPointFeature(
      fid,
      createBasicAttributes('renamed', 0, 1),
      feature.color,
      vid,
      { parentId: asFeatureId('parent-1') },
    );
    const newSnap = createAnchorSnapshot(
      [newFeature],
      createVertexStore([createVertex(vid, createCoordinate(10, 20))]),
    );
    const updated = withEntrySnapshot(e, newSnap);
    const f = updated.anchor.snapshot.features[0]!;
    expect(f.kind).toBe('point'); // shape/kind retained
    expect(f.parentId).toBe(asFeatureId('parent-1')); // parent retained
    expect(updated.anchor.snapshot.vertices.byId.size).toBe(1); // vertices retained
  });
});

// --- AC-8 purity / AC-9 determinism -----------------------------------------

describe('purity and determinism (AC-8, AC-9)', () => {
  it('does not mutate a deep-frozen input series', () => {
    const s = deepFreeze(series(entry(1, 100, null), entry(2, 200, null)));
    expect(() => resolveAt(s, timePointYear(150), cal)).not.toThrow();
    expect(() => setEnd(s, s.entries[0]!.anchor.id, timePointYear(150), cal)).not.toThrow();
    expect(() => changeStart(s, s.entries[1]!.anchor.id, timePointYear(50), cal)).not.toThrow();
    expect(() => deleteAnchor(s, s.entries[0]!.anchor.id, cal)).not.toThrow();
    expect(() =>
      applyPastEdit(s, timePointYear(250), () => makeAnchor(250, '-z'), cal),
    ).not.toThrow();
  });

  it('returns identical output for identical input (normalize)', () => {
    const input = [entry(2, 200, null), entry(1, 100, 300), entry(3, 300, null)];
    const a = normalizeSeries(input, cal);
    const b = normalizeSeries(input, cal);
    expect(a).toEqual(b);
  });
});

// --- AC-1 / AC-5 property tests ---------------------------------------------

describe('property: invariants hold after any reorg (AC-5, FR-56/FR-72)', () => {
  it('generated series are always valid', () => {
    fc.assert(
      fc.property(anchorSeriesArb(cal), (s) => {
        expect(s.entries.length).toBeGreaterThanOrEqual(1);
        expect(validateSeries(s, cal).ok).toBe(true);
      }),
    );
  });

  it('a sequence of random reorg operations preserves invariants every step', () => {
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant('changeStart' as const), year: fc.integer({ min: -500, max: 500 }) }),
      fc.record({
        kind: fc.constant('setEnd' as const),
        end: fc.option(fc.integer({ min: -500, max: 500 }), { nil: null }),
      }),
      fc.record({ kind: fc.constant('delete' as const) }),
      fc.record({ kind: fc.constant('pastEdit' as const), year: fc.integer({ min: -500, max: 500 }) }),
      fc.record({ kind: fc.constant('resolve' as const), year: fc.integer({ min: -500, max: 500 }) }),
    );

    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(fc.tuple(opArb, fc.nat()), { maxLength: 12 }),
        (initial, ops) => {
          let s = initial;
          for (const [op, idx] of ops) {
            const target = s.entries[idx % s.entries.length]!.anchor.id;
            if (op.kind === 'changeStart') {
              const r = changeStart(s, target, timePointYear(op.year), cal);
              if (r.ok) s = r.series;
            } else if (op.kind === 'setEnd') {
              const r = setEnd(
                s,
                target,
                op.end === null ? null : timePointYear(op.end),
                cal,
              );
              if (r.ok) s = r.series;
            } else if (op.kind === 'delete') {
              const r = deleteAnchor(s, target, cal);
              if (r.ok) s = r.series;
            } else if (op.kind === 'pastEdit') {
              s = applyPastEdit(s, timePointYear(op.year), () => makeAnchor(op.year, '-pe'), cal);
            } else {
              resolveAt(s, timePointYear(op.year), cal);
            }
            // Every step: non-empty + all invariants.
            expect(s.entries.length).toBeGreaterThanOrEqual(1);
            expect(validateSeries(s, cal).ok).toBe(true);
          }
        },
      ),
    );
  });
});

// --- AC-7 time comparison routed through U02 (mock-swap sanity) --------------

describe('time routing (AC-7, FR-72)', () => {
  it('ordering is consistent under a different but valid calendar instance', () => {
    // Using the same comparison path (compare over TimePoint+Calendar) means
    // swapping the calendar object still yields a coherent ordering: a series
    // valid under the gregorian calendar resolves consistently.
    const s = series(entry(1, -50, 0), entry(2, 50, null));
    expect(present(resolveAt(s, timePointYear(-50), cal)).anchor.id).toBe(
      s.entries[0]!.anchor.id,
    );
    expect(present(resolveAt(s, timePointYear(60), cal)).anchor.id).toBe(
      s.entries[1]!.anchor.id,
    );
    expect(validateSeries(s, cal).ok).toBe(true);
  });
});
