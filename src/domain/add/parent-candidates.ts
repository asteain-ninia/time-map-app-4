// U23 — face parent-candidate enumeration (FR-77 / FR-48 / FR-39, 教訓 5.3 / 5.4
// / 5.18 / 5.30).
//
// Pure domain logic that lists the EXISTING faces eligible to be a new face's
// parent at a given time (spec §面追加時の親選択). Eligibility (spec §親候補の妥当性
// FR-77 / FR-48):
//   - the candidate is a FACE feature (leaf or aggregate — only面情報 can parent a
//     面情報; point / line are excluded by kind, 教訓 5.19),
//   - the candidate EXISTS at the指定時刻 (= the new face's anchor start = the
//     current timeline time) so it can cover the new face's existence period
//     (FR-48 covering condition, simplified to the start instant for the first
//     anchor — the new face begins now),
//   - the candidate is drawn from the DISPLAYED feature set at that time (教訓 5.3
//     / 5.4: operate on what is visible / current, not the whole data source).
//
// The new face itself is NOT a candidate (it is being newly created, so there is
// no cycle to exclude — 教訓 5.30: this candidate rule is NOT the same as the
// 所属変更 (move) candidate rule, which must exclude cycles; we deliberately do
// not share that logic).
//
// Existence-at-time is INJECTED (spec 依存: 表示状態に基づく / 単一の真実源): this
// module never resolves time itself; the caller backs the predicate with U09 /
// the displayed feature data.

import { FEATURE_KIND, featureDisplayName, type Feature } from '../feature';
import type { FeatureId } from '../ids';

/** A parent candidate: the face id plus its display name (for the選択 UI). */
export interface ParentCandidate {
  readonly featureId: FeatureId;
  readonly displayName: string;
}

/** True iff a feature is a面情報 (leaf or aggregate) — the only parentable kind. */
export function isFaceFeature(feature: Feature): boolean {
  return (
    feature.kind === FEATURE_KIND.Leaf || feature.kind === FEATURE_KIND.Aggregate
  );
}

/**
 * Predicate: does `featureId` exist (and is displayed) at the candidate-listing
 * time? Injected so this module stays time-agnostic (spec 依存). The caller backs
 * it with the displayed-at-time feature set (教訓 5.3).
 */
export type ExistsAtTime = (featureId: FeatureId) => boolean;

/**
 * Enumerate the eligible parent candidates for a NEW face whose existence begins
 * at the listing time (FR-77). `displayedFeatures` is the feature set currently
 * displayed at that time (教訓 5.3 / 5.4 — the caller supplies the displayed set,
 * not the whole store). A feature qualifies iff it is a face AND `existsAt`
 * returns true for it. The new face is not in `displayedFeatures` (it does not
 * exist yet), so no self-exclusion is needed (教訓 5.30).
 *
 * Returns the candidates in the order given (the caller controls ordering). An
 * EMPTY result is a valid "no covering face" state (教訓 5.18) — the UI then
 * offers only the 親なし choice; the caller must NOT confuse "no candidates" with
 * "親なし already selected" (spec §注意点 / 教訓 5.18).
 */
export function parentCandidates(
  displayedFeatures: readonly Feature[],
  existsAt: ExistsAtTime,
): ParentCandidate[] {
  const out: ParentCandidate[] = [];
  for (const feature of displayedFeatures) {
    if (!isFaceFeature(feature)) continue;
    if (!existsAt(feature.id)) continue;
    out.push({ featureId: feature.id, displayName: featureDisplayName(feature) });
  }
  return out;
}

/** The candidate ids as a set (for {@link revalidateParent} membership tests). */
export function candidateIdSet(
  candidates: readonly ParentCandidate[],
): Set<FeatureId> {
  return new Set(candidates.map((c) => c.featureId));
}
