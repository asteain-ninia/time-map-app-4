// UI layer (U32 / property panel): the PURE 詳細文書 edit plan (FR-98).
//
// ONE place decides what a detail-document save does (単一真実源, 教訓 5.29 / 5.30):
// the sidebar section's save button AND the App-side live dispatch both consult THIS
// plan, so the WRITE guard (over-length), the no-op guard (教訓 5.24) and the
// canonical-empty rule ('' → absent) can never drift between the UI gate and the
// commit path.
//
//   - TooLong … the draft EXCEEDS MAX_DETAIL_DOCUMENT_LENGTH (domain barrel). This is
//     the WRITE-side guard: the domain's own normalizeDetailDocument throws a
//     RangeError at the boundary, but that throw is the last防波堤 — the UX is an
//     honest Japanese message BEFORE any dispatch (書込⊆読込の非対称を作らない).
//   - NoOp … the normalized draft equals the feature's current document (both absent
//     for the empty form) — nothing to save, no ghost undo entry (教訓 5.24).
//   - Edit … the after-state feature via the domain's SINGLE withDetailDocument
//     (normalization included: '' → absent), ready for the complete-state snapshot.

import {
  MAX_DETAIL_DOCUMENT_LENGTH,
  normalizeDetailDocument,
  withDetailDocument,
} from '../../domain/index';
import type { Feature } from '../../domain/feature';

/** Plan kinds (typed constants, 教訓 5.19). */
export const DETAIL_DOCUMENT_PLAN = {
  /** Nothing to save: the normalized draft equals the current document. */
  NoOp: 'noop',
  /** The draft exceeds the domain maximum — MUST NOT be dispatched. */
  TooLong: 'tooLong',
  /** A real edit: `feature` is the complete after-state record. */
  Edit: 'edit',
} as const;

export type DetailDocumentPlanKind =
  (typeof DETAIL_DOCUMENT_PLAN)[keyof typeof DETAIL_DOCUMENT_PLAN];

export type DetailDocumentPlan =
  | { readonly kind: typeof DETAIL_DOCUMENT_PLAN.NoOp }
  | {
      readonly kind: typeof DETAIL_DOCUMENT_PLAN.TooLong;
      readonly length: number;
      readonly max: number;
    }
  | { readonly kind: typeof DETAIL_DOCUMENT_PLAN.Edit; readonly feature: Feature };

/**
 * Decide what saving `draft` onto `feature` means (FR-98). Pure. The length guard
 * runs FIRST so the domain normalize (which throws past the boundary) is never
 * reached with an over-long draft — the caller shows the honest message instead.
 */
export function planDetailDocumentEdit(feature: Feature, draft: string): DetailDocumentPlan {
  if (draft.length > MAX_DETAIL_DOCUMENT_LENGTH) {
    return {
      kind: DETAIL_DOCUMENT_PLAN.TooLong,
      length: draft.length,
      max: MAX_DETAIL_DOCUMENT_LENGTH,
    };
  }
  // Canonical empty: '' normalizes to absent (undefined) — the SAME single rule the
  // domain applies on write, so the no-op comparison sees one empty form (教訓 5.24).
  const normalized = normalizeDetailDocument(draft);
  if (normalized === feature.detailDocument) {
    return { kind: DETAIL_DOCUMENT_PLAN.NoOp };
  }
  return { kind: DETAIL_DOCUMENT_PLAN.Edit, feature: withDetailDocument(feature, draft) };
}
