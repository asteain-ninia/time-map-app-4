// Domain layer (U09): history-anchor series — temporal-axis logic.
//
// This unit establishes the time-axis management for a single feature's history
// anchors (FR-54〜FR-59). It is PURE: every operation takes an input series (and
// arguments) and returns a NEW series, never mutating the input (lesson 5.22).
// No I/O, randomness, or system clock is referenced. Time comparison is ALWAYS
// routed through the U02 contract (`compare` over TimePoint + Calendar), never
// by decomposing year/month/day here (FR-72, lesson 5.16).
//
// Scope (per spec §2):
//   - The anchor's full-state snapshot (shape / attributes / parent-child) is
//     held OPAQUELY (it rides on the U03 `Anchor`); this unit never interprets
//     it. A whole anchor is replaced as one snapshot (FR-59: no partial commit).
//   - Spatial / hierarchy validity, undo/redo stacks, and UI are out of scope.
//
// Invariants enforced on every output (§4.4):
//   INV-1 ascending: strictly increasing start times (no duplicate starts).
//   INV-2 no overlap: each entry's end (if any) is <= the next entry's start.
//   INV-3 positive span: each end (if any) is strictly after its own start.
//   INV-4 gaps allowed: temporal enclaves (non-existence periods) are valid.
//   INV-5 non-empty: the series always holds at least one anchor.
//   INV-6 unique ids: no two entries share an AnchorId (the id is the routing
//     key for every by-id edit; see validateSeries / indexOfAnchor below).

import type { Anchor, AnchorSnapshot } from './anchor';
import type { AnchorId } from './ids';
import type { Calendar } from './time/calendar';
import type { TimePoint } from './time/time-point';
import { compare, compareNormalized, normalize, type Normalized } from './time/normalized';
import { validate as validateTimePoint, type TimeValidationError } from './time/validate';

// --- Core value types -------------------------------------------------------

/**
 * One history anchor placed on the time axis. Couples the U03 full-state
 * snapshot (held opaquely via {@link Anchor}) with its start time (mandatory)
 * and end time (optional; `null` == open-ended / indefinite continuation).
 *
 * The "effective interval" of an entry is a DERIVED value (computed from the
 * whole series, §4.2) and is intentionally NOT stored on the entry — it is
 * recomputed so it can never drift out of sync.
 */
export interface AnchorEntry {
  readonly anchor: Anchor;
  readonly start: TimePoint;
  readonly end: TimePoint | null;
}

/**
 * A single feature's anchor series: a non-empty list of entries that always
 * satisfies INV-1〜INV-5. Construct it only via {@link normalizeSeries} (or the
 * operations below), which restore the invariants; do not assemble the entry
 * array by hand.
 */
export interface AnchorSeries {
  readonly entries: readonly AnchorEntry[];
}

// --- Derived constructors (immutable; lesson 5.17) --------------------------

/** Builds an anchor entry. `end` defaults to open-ended (`null`). */
export function createAnchorEntry(
  anchor: Anchor,
  start: TimePoint,
  end: TimePoint | null = null,
): AnchorEntry {
  return { anchor, start, end };
}

/** Returns a copy of the entry with a new start time (other fields preserved). */
export function withEntryStart(entry: AnchorEntry, start: TimePoint): AnchorEntry {
  return { anchor: entry.anchor, start, end: entry.end };
}

/** Returns a copy of the entry with a new end time (or `null` to clear it). */
export function withEntryEnd(entry: AnchorEntry, end: TimePoint | null): AnchorEntry {
  return { anchor: entry.anchor, start: entry.start, end };
}

/**
 * Returns a copy of the entry with a replaced full-state snapshot. The whole
 * snapshot is replaced as one unit (FR-59); there is no per-field setter, so a
 * partial / attribute-only commit cannot be expressed.
 */
export function withEntrySnapshot(
  entry: AnchorEntry,
  snapshot: AnchorSnapshot,
): AnchorEntry {
  return {
    anchor: { id: entry.anchor.id, snapshot },
    start: entry.start,
    end: entry.end,
  };
}

// --- Resolution result (discriminated union; §5.3, lesson 5.18) -------------

/**
 * Result of resolving an effective anchor at a given time. The caller is forced
 * to branch on `kind`: `'present'` carries the live entry, `'absent'` means the
 * feature does not exist at that time (before first start, or inside a temporal
 * enclave / after a set end). Non-existence is NOT a `null` short-circuit.
 */
export type Resolution =
  | { readonly kind: 'present'; readonly entry: AnchorEntry }
  | { readonly kind: 'absent' };

const ABSENT: Resolution = { kind: 'absent' };

// --- Operation result (discriminated union; §6, lesson 5.26) ----------------

/** Reasons an operation can be rejected, returned as testable values. */
export type RejectReason =
  /** The operation would leave the series with zero anchors (INV-5). */
  | { readonly code: 'wouldBeEmpty' }
  /** The target anchor id is not present in the series. */
  | { readonly code: 'anchorNotFound'; readonly id: AnchorId }
  /** A requested end time is not strictly after its own start (INV-3). */
  | { readonly code: 'endNotAfterStart' }
  /** A requested end time would exceed the next future anchor's end. */
  | { readonly code: 'endBeyondNextEnd' }
  /**
   * A start-time change would move the entry's start to or past its OWN bounded
   * end (newStart >= end), which would silently turn a finite existence interval
   * into an open-ended one. Rejected rather than clamped so a feature meant to
   * stop existing is never resurrected indefinitely (INV-3, FR-56).
   */
  | { readonly code: 'startNotBeforeEnd' }
  /**
   * A caller-supplied TimePoint is not valid for the calendar (out-of-range
   * month/day, non-integer, or year beyond ±MAX_YEAR). Such a point MUST be
   * rejected at the operation boundary rather than normalized: `normalize`
   * assumes a validated point and an out-of-range month silently ALIASES onto a
   * real date (e.g. 2024-13 → 2025-01), so a genuine neighbouring anchor would
   * collide with it under the dedup and one anchor would be silently lost. This
   * mirrors the persistence boundary, which already routes loaded TimePoints
   * through the same domain `validate` (timePointSchema.superRefine), so the only
   * remaining entry path is an unvalidated in-memory (UI) edit.
   */
  | { readonly code: 'invalidTime'; readonly error: TimeValidationError };

/** Outcome of a mutating operation: a new series, or a rejection reason. */
export type SeriesResult =
  | { readonly ok: true; readonly series: AnchorSeries }
  | { readonly ok: false; readonly reason: RejectReason };

function ok(series: AnchorSeries): SeriesResult {
  return { ok: true, series };
}

function reject(reason: RejectReason): SeriesResult {
  return { ok: false, reason };
}

/**
 * Returns an `invalidTime` rejection if `time` is not valid for the calendar,
 * otherwise `undefined`. This is the SINGLE guard the calendar-aware edit
 * operations call on every caller-supplied TimePoint before it ever reaches
 * `normalize` / `compare`. It routes through the same domain `validate` the
 * persistence boundary uses (単一真実源), so an in-memory UI edit cannot feed an
 * out-of-range TimePoint (e.g. month 13) that would silently alias onto a real
 * date and collide with a genuine anchor during dedup.
 */
function rejectIfInvalidTime(
  time: TimePoint,
  calendar: Calendar,
): SeriesResult | undefined {
  const result = validateTimePoint(time, calendar);
  return result.ok ? undefined : reject({ code: 'invalidTime', error: result.error });
}

// --- Validation (single source of truth; §5.4) ------------------------------

/** Identifies which invariant a violation pertains to. */
export type InvariantId = 'INV-1' | 'INV-2' | 'INV-3' | 'INV-5' | 'INV-6';

/** A single invariant violation, with the offending anchor id(s) when known. */
export interface InvariantViolation {
  readonly invariant: InvariantId;
  readonly anchorIds: readonly AnchorId[];
}

/** Result of validating a series against INV-1〜INV-5. */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly InvariantViolation[] };

/**
 * Validates a series against all invariants (§4.4). This is the SINGLE place
 * the invariants are decided; every operation funnels its output through here
 * (§5.4). INV-4 (gaps allowed) is not a violation and so has no check.
 */
export function validateSeries(series: AnchorSeries, calendar: Calendar): ValidationResult {
  const violations: InvariantViolation[] = [];
  const entries = series.entries;

  // INV-5 non-empty.
  if (entries.length === 0) {
    violations.push({ invariant: 'INV-5', anchorIds: [] });
    return { ok: false, violations };
  }

  // INV-6 unique ids: the AnchorId is the routing key for every by-id edit
  // (changeStart / setEnd / deleteAnchor all locate the target via the FIRST
  // entry matching the id; see indexOfAnchor). Two entries sharing an id would
  // make every such edit silently act on the earlier occurrence regardless of
  // which one the caller meant, and the later one would be unreachable by id.
  // Validate uniqueness here (the single source of truth) rather than relying on
  // the start-time check (INV-1): distinct-start duplicates pass INV-1 yet still
  // misroute. The earliest entry of each duplicated id is the canonical one; the
  // violation names the duplicated id so the caller can locate every collision.
  const firstSeenById = new Map<AnchorId, number>();
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i]!.anchor.id;
    const firstSeen = firstSeenById.get(id);
    if (firstSeen === undefined) {
      firstSeenById.set(id, i);
    } else {
      violations.push({ invariant: 'INV-6', anchorIds: [id] });
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // INV-3 positive span (end strictly after start).
    if (entry.end !== null && compare(entry.start, entry.end, calendar) >= 0) {
      violations.push({ invariant: 'INV-3', anchorIds: [entry.anchor.id] });
    }

    const next = entries[i + 1];
    if (next !== undefined) {
      // INV-1 strictly ascending starts (no duplicate / out-of-order starts).
      if (compare(entry.start, next.start, calendar) >= 0) {
        violations.push({
          invariant: 'INV-1',
          anchorIds: [entry.anchor.id, next.anchor.id],
        });
      }
      // INV-2 no overlap: this end (if any) must be <= next start.
      if (entry.end !== null && compare(entry.end, next.start, calendar) > 0) {
        violations.push({
          invariant: 'INV-2',
          anchorIds: [entry.anchor.id, next.anchor.id],
        });
      }
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Convenience predicate over {@link validateSeries}. */
export function isValidSeries(series: AnchorSeries, calendar: Calendar): boolean {
  return validateSeries(series, calendar).ok;
}

// --- Normalization (§5.6 / §6: the entry point for invariant recovery) ------

/**
 * Sorts entries by start time and shortens any entry whose end overruns the
 * next entry's start, restoring INV-1〜INV-3 while preserving gaps (INV-4).
 * Entries sharing an AnchorId are collapsed first by keeping the LAST one given
 * (INV-6: an id is the routing key for by-id edits and must be unique), then
 * entries with equal start times are collapsed by keeping the LAST one given
 * (deterministic, §9.... determinism), so the result has strictly ascending
 * starts and unique ids. An entry that carries a degenerate bounded interval
 * (its own end is
 * not strictly after its start, INV-3) is DROPPED entirely rather than silently
 * reopened to null: reopening would resurrect a feature meant to stop existing
 * as one that exists forever, contradicting the guarded edit paths (changeStart
 * / setEnd) and FR-56. The result is non-empty unless the input was empty: if
 * every input entry is degenerate (a fully corrupt history reachable only from
 * persistence repair, never from this unit's operations), the earliest entry is
 * kept as open-ended as the least-bad INV-5 fallback.
 *
 * This is deterministic: identical input always yields identical output.
 */
export function normalizeSeries(
  entries: readonly AnchorEntry[],
  calendar: Calendar,
): AnchorSeries {
  // Collapse duplicate AnchorIds (INV-6) FIRST, keeping the LAST entry for each
  // id (consistent with the keep-last duplicate-start collapse below, and with
  // the guarded edit paths that append the explicitly-edited entry last so it
  // wins). An id is the routing key for every by-id edit; two entries sharing it
  // make those edits misroute, so a series carrying duplicates (only reachable
  // from corrupt / hand-edited persistence — this unit's operations never mint a
  // duplicate) must be repaired here before validation, not just flagged. Done
  // before the sort so the surviving entry keeps its own start for the dedup and
  // overrun passes. This preserves input order among distinct ids (Map iteration
  // order), so the subsequent stable sort is deterministic.
  const byId = new Map<AnchorId, AnchorEntry>();
  for (const entry of entries) {
    byId.set(entry.anchor.id, entry);
  }
  const unique = [...byId.values()];

  // Stable sort by start time. Array.prototype.sort is stable in modern V8.
  const sorted = [...unique].sort((a, b) => compare(a.start, b.start, calendar));

  // Collapse duplicate starts: keep the last entry for each distinct start.
  const deduped: AnchorEntry[] = [];
  for (const entry of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev !== undefined && compare(prev.start, entry.start, calendar) === 0) {
      deduped[deduped.length - 1] = entry;
    } else {
      deduped.push(entry);
    }
  }

  // Shorten overruns so each end <= next start, then enforce INV-3 (positive
  // span). Note: after dedup the starts are strictly ascending, so an end that
  // is shortened to `next.start` is always strictly after this entry's start —
  // the only way `start >= end` can hold below is when the entry carries its
  // OWN degenerate bounded interval (end <= start) on input.
  const result: AnchorEntry[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const entry = deduped[i]!;
    const next = deduped[i + 1];
    let end = entry.end;
    if (next !== undefined && end !== null && compare(end, next.start, calendar) > 0) {
      // Overrun: shorten to the next start (INV-2). This is the §5.6 "短縮".
      end = next.start;
    }
    // INV-3 positive span: an end that is not strictly after its own start is a
    // degenerate bounded interval (the feature exists for a zero/negative span).
    // Do NOT silently clear it to null — that would resurrect a feature meant to
    // stop existing as one that exists forever, contradicting the guarded edit
    // paths (changeStart's `startNotBeforeEnd`, setEnd's `endNotAfterStart`,
    // INV-3 / FR-56). The entry has no valid existence, so DROP it entirely
    // (§5.6: "fully covered" → removed), preserving the remaining anchors.
    if (end !== null && compare(entry.start, end, calendar) >= 0) {
      continue;
    }
    result.push(end === entry.end ? entry : withEntryEnd(entry, end));
  }

  // INV-5: a series may never be empty. If the only entries on input were all
  // degenerate (a fully corrupt history — not producible by this unit's guarded
  // operations, but reachable from persistence repair), recovery must still
  // yield a non-empty series. As the least-bad fallback, keep the earliest such
  // entry as open-ended: there is no valid bounded interpretation of any entry,
  // and an empty series is forbidden. A mixed input (some valid entries) never
  // reaches this branch because the valid entries survive the drop above.
  if (result.length === 0 && deduped.length > 0) {
    const first = deduped[0]!;
    result.push(first.end === null ? first : withEntryEnd(first, null));
  }

  return { entries: result };
}

// --- Lookup helpers ---------------------------------------------------------

function indexOfAnchor(series: AnchorSeries, id: AnchorId): number {
  return series.entries.findIndex((e) => e.anchor.id === id);
}

// --- §5.8 resolution: effective anchor at a time ----------------------------

/**
 * Resolves the anchor effective at `time` (§5.8). The result is the entry with
 * the greatest start <= time; if that entry has an end and time >= end, the
 * feature is in a temporal enclave / past its end -> `absent`. Times before the
 * first start are `absent` (existence has not begun). Boundary rules: start is
 * inclusive (effective AT the start), end is exclusive (absent AT the end).
 */
export function resolveAt(
  series: AnchorSeries,
  time: TimePoint,
  calendar: Calendar,
): Resolution {
  const entries = series.entries;
  // The entry effective at `time` is the one with the GREATEST start <= time.
  //
  // A binary search would be tempting (INV-1 promises strictly ascending starts),
  // but `resolveAt` is reachable from the persistence / consistency path on a
  // series that has NOT been re-normalized on load (serialize deserializeHistory
  // restores entries verbatim; consistency.checkTimeSlice resolves on that raw
  // series). A corrupt / hand-edited / legacy file can therefore present an
  // UNSORTED series, and binary search on unsorted starts returns the wrong
  // anchor (e.g. starts [100,0,200] at t=150 would land on start=0, not 100),
  // making load-time consistency inspect the wrong snapshot. A linear "greatest
  // start <= time" scan is correct for BOTH normalized and unvalidated input and
  // is cheap: anchor series are per-feature and short. On a normalized series it
  // yields exactly the same entry the binary search did.
  //
  // `time` is normalized exactly once. Ties on start cannot occur in a valid
  // series (INV-1 forbids duplicate starts); should a corrupt / hand-edited /
  // legacy series carry them, the LAST occurrence wins (`>=` advances the index
  // on a tie). This MUST match normalizeSeries' duplicate-start collapse, which
  // also keeps the LAST entry for each distinct start (see the keep-last dedup
  // there). Otherwise the snapshot the consistency check inspects on the RAW
  // series (resolveAt, this path) would differ from the snapshot that survives
  // a NormalizeSeries repair, flipping which feature is effective at a tie time
  // and making applyRepairChecked see a spurious "new" overlap/topology
  // inconsistency that blocks the TimeConflict repair (bughunt2).
  const t: Normalized = normalize(time, calendar);
  let idx = -1;
  let best: Normalized | null = null;
  for (let i = 0; i < entries.length; i++) {
    const start = normalize(entries[i]!.start, calendar);
    if (compareNormalized(start, t) > 0) continue; // start after time: not yet effective.
    if (best === null || compareNormalized(start, best) >= 0) {
      best = start;
      idx = i;
    }
  }
  if (idx < 0) return ABSENT;
  const candidate = entries[idx]!;
  if (candidate.end !== null && compareNormalized(t, normalize(candidate.end, calendar)) >= 0) {
    return ABSENT;
  }
  return { kind: 'present', entry: candidate };
}

// --- §5.7 past-edit application ---------------------------------------------

/**
 * Applies a past edit at the editing base time (§5.7, FR-55/FR-57). If an entry
 * already starts exactly at `baseTime`, its full-state snapshot is REPLACED and
 * the count does not change. Otherwise a NEW anchor (built by `makeAnchor`) is
 * inserted with `baseTime` as its start; its effective interval is naturally
 * bounded by the next future anchor's start, so the future anchor's content is
 * never auto-rewritten (FR-55).
 *
 * `makeAnchor` is the caller's factory for the new anchor's snapshot; for the
 * insert case it is given the entry effective at `baseTime` (`Resolution`) so
 * the new anchor can inherit it (§5.7 step 3) — in a temporal enclave that is
 * `absent`, and the caller supplies a fresh full state.
 *
 * The new entry inherits NO end (open within its slot); overlap is resolved by
 * normalization. Because the only structural change is at `baseTime`, this never
 * alters any future entry's start or snapshot.
 *
 * `baseTime` MUST be a TimePoint valid for the calendar. Unlike the guarded
 * `SeriesResult`-returning operations (changeStart / setEnd), this returns a
 * series directly and cannot surface a rejection reason, so an invalid base time
 * throws a `RangeError` rather than being normalized: an out-of-range month
 * aliases onto a real date (e.g. 2024-13 → 2025-01) and would collide with a
 * genuine anchor under the dedup, silently dropping one. All in-tree callers
 * pass a resolved/validated time, so this is a defensive boundary assertion.
 */
export function applyPastEdit(
  series: AnchorSeries,
  baseTime: TimePoint,
  makeAnchor: (effective: Resolution) => Anchor,
  calendar: Calendar,
): AnchorSeries {
  const timeCheck = validateTimePoint(baseTime, calendar);
  if (!timeCheck.ok) {
    throw new RangeError(`applyPastEdit: invalid baseTime (${timeCheck.error})`);
  }

  const existingIndex = series.entries.findIndex(
    (e) => compare(e.start, baseTime, calendar) === 0,
  );

  if (existingIndex >= 0) {
    // Update in place: replace the snapshot, keep start/end and ordering.
    const target = series.entries[existingIndex]!;
    const replacement = makeAnchor({ kind: 'present', entry: target });
    const updated = withEntrySnapshot(target, replacement.snapshot);
    const entries = series.entries.map((e, i) => (i === existingIndex ? updated : e));
    return normalizeSeries(entries, calendar);
  }

  // Insert a new anchor; inherit the state effective at baseTime.
  const effective = resolveAt(series, baseTime, calendar);
  const anchor = makeAnchor(effective);
  const inserted = createAnchorEntry(anchor, baseTime, null);
  return normalizeSeries([...series.entries, inserted], calendar);
}

// --- §5.6 start-time change (auto-reorganization) ---------------------------

/**
 * Changes the start time of the target anchor and auto-reorganizes (§5.6). The
 * moved entry keeps its snapshot and end; the series is re-sorted and overruns
 * shortened (normalization). Entries whose distinct start collides with the new
 * start are collapsed (the moved entry wins, since dedup keeps the last at a
 * given start — we place the moved entry last among equals by appending it). A
 * result that would be empty is impossible here (count is preserved), but a
 * full collision could reduce the count; we still never drop below 1.
 */
export function changeStart(
  series: AnchorSeries,
  id: AnchorId,
  newStart: TimePoint,
  calendar: Calendar,
): SeriesResult {
  // Reject an out-of-range start before it can be normalized (an invalid month
  // aliases onto a real date and would collide with a genuine anchor on dedup).
  const invalid = rejectIfInvalidTime(newStart, calendar);
  if (invalid !== undefined) return invalid;

  const index = indexOfAnchor(series, id);
  if (index < 0) return reject({ code: 'anchorNotFound', id });

  const target = series.entries[index]!;
  // Guard the silent bounded→open-ended degeneration: if the entry has its OWN
  // end and the new start would land at or past it, normalization would clear
  // the (now non-positive) end to null and the feature would exist forever.
  // Reject instead so a bounded existence is never silently resurrected (§5.6 /
  // INV-3): the caller must move the end too, or drop the anchor explicitly.
  if (target.end !== null && compare(newStart, target.end, calendar) >= 0) {
    return reject({ code: 'startNotBeforeEnd' });
  }

  const moved = withEntryStart(target, newStart);
  // Build the new array with all other entries first and the moved entry last,
  // so dedup (keep-last) lets the explicitly-moved entry win on a start tie.
  const others = series.entries.filter((_, i) => i !== index);
  const next = normalizeSeries([...others, moved], calendar);

  if (next.entries.length === 0) return reject({ code: 'wouldBeEmpty' });
  return ok(next);
}

// --- §4.5 / §5.6 end-time set / change / clear ------------------------------

/**
 * Sets, changes, or clears (`null`) the end time of the target anchor (§4.5).
 * Constraints (rejected with a testable reason rather than silently clamped):
 *   - end must be strictly after the entry's own start (INV-3).
 *   - end must not exceed the next future anchor's end, if that anchor has one.
 * The "end must be <= next start" constraint is NOT a rejection: an overrun
 * there is resolved by auto-reorganization (shorten the overrun via
 * normalization), per §4.5 ("自動再編で解消するか、超過を拒否する" — we choose
 * reorganize). Clearing the end (open-ended) is always allowed.
 */
export function setEnd(
  series: AnchorSeries,
  id: AnchorId,
  newEnd: TimePoint | null,
  calendar: Calendar,
): SeriesResult {
  // Reject an out-of-range end before it can be normalized (clearing the end via
  // `null` is always valid and skips this guard).
  if (newEnd !== null) {
    const invalid = rejectIfInvalidTime(newEnd, calendar);
    if (invalid !== undefined) return invalid;
  }

  const index = indexOfAnchor(series, id);
  if (index < 0) return reject({ code: 'anchorNotFound', id });

  const target = series.entries[index]!;

  if (newEnd !== null) {
    // INV-3: end strictly after this entry's start.
    if (compare(target.start, newEnd, calendar) >= 0) {
      return reject({ code: 'endNotAfterStart' });
    }
    // Must not exceed the next future anchor's end (§4.5). The "next future
    // anchor" is the entry with the smallest start strictly greater than this
    // entry's start.
    const nextFuture = findNextFuture(series, target, calendar);
    if (
      nextFuture !== undefined &&
      nextFuture.end !== null &&
      compare(newEnd, nextFuture.end, calendar) > 0
    ) {
      return reject({ code: 'endBeyondNextEnd' });
    }
  }

  const updated = withEntryEnd(target, newEnd);
  const entries = series.entries.map((e, i) => (i === index ? updated : e));
  const next = normalizeSeries(entries, calendar);
  if (next.entries.length === 0) return reject({ code: 'wouldBeEmpty' });
  return ok(next);
}

/** The entry with the smallest start strictly greater than `entry`'s start. */
function findNextFuture(
  series: AnchorSeries,
  entry: AnchorEntry,
  calendar: Calendar,
): AnchorEntry | undefined {
  let best: AnchorEntry | undefined;
  for (const e of series.entries) {
    if (compare(e.start, entry.start, calendar) > 0) {
      if (best === undefined || compare(e.start, best.start, calendar) < 0) {
        best = e;
      }
    }
  }
  return best;
}

// --- §5.6 delete (with the 0-entry guard) -----------------------------------

/**
 * Removes the target anchor (§5.6). Rejected if it is the last remaining anchor
 * (INV-5: a series may never become empty — that is a different concept than
 * deleting the feature itself, §9.1). Deleting one of several anchors leaves the
 * rest re-validated by normalization (gaps that open up are allowed, INV-4).
 */
export function deleteAnchor(
  series: AnchorSeries,
  id: AnchorId,
  calendar: Calendar,
): SeriesResult {
  const index = indexOfAnchor(series, id);
  if (index < 0) return reject({ code: 'anchorNotFound', id });
  if (series.entries.length <= 1) return reject({ code: 'wouldBeEmpty' });

  const entries = series.entries.filter((_, i) => i !== index);
  return ok(normalizeSeries(entries, calendar));
}
