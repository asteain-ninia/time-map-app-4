// U13 — adapter from U10's raw {@link OverlapPair} to U13's structured
// {@link Conflict} (spec §依存 U10: 本ユニットは検出してもらう立場). This is the
// seam between U10's geometry-only pair (id, id, overlap area) and the
// UI-facing conflict (display names + conflict time + kind). It lives in U13 so
// U10 keeps no UI concern, and the layer-crossing contract is fixed by type and
// exercised by both-side tests (教訓5.33 / 5.34).
//
// Pure: reads the pair + a name/time lookup, returns a fresh conflict.

import type { FeatureId } from '../ids';
import { idToString } from '../ids';
import type { OverlapPair } from '../spatial/overlap';
import {
  CONFLICT_KIND,
  type Conflict,
  type ConflictTime,
} from './types';

/** Resolves the display name (FR-62) for a feature id. */
export type DisplayNameLookup = (id: FeatureId) => string;

/**
 * The in-story time at which a conflict holds. The orchestrator computes this
 * from the proposal / anchor series (the time being confirmed); U10 itself is
 * time-agnostic, so the time is supplied here.
 */
export type ConflictTimeLookup = (pair: OverlapPair) => ConflictTime;

/** Stable conflict id derived from the (already-normalised) id pair. */
export function conflictIdFor(a: FeatureId, b: FeatureId): string {
  return `${idToString(a)}__${idToString(b)}`;
}

/**
 * Build a structured {@link Conflict} from one U10 overlap pair. The pair is
 * already in normalised (min id, max id) order, so the conflict id is stable.
 * Every overlap piece is preserved (教訓5.1).
 */
export function conflictFromOverlapPair(
  pair: OverlapPair,
  names: DisplayNameLookup,
  time: ConflictTimeLookup,
): Conflict {
  return {
    id: conflictIdFor(pair.a, pair.b),
    kind: CONFLICT_KIND.TerminalOverlap,
    time: time(pair),
    a: { featureId: pair.a, displayName: names(pair.a) },
    b: { featureId: pair.b, displayName: names(pair.b) },
    overlap: pair.overlap,
  };
}

/** Map a list of overlap pairs to structured conflicts (片落としなし). */
export function conflictsFromOverlapPairs(
  pairs: readonly OverlapPair[],
  names: DisplayNameLookup,
  time: ConflictTimeLookup,
): Conflict[] {
  return pairs.map((p) => conflictFromOverlapPair(p, names, time));
}
