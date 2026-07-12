// FR-98 詳細文書の編集 — the LIVE dispatch that turns a DetailDocumentEditIntent into
// ONE undo-unit edit over the committed DomainProject. propertyEditDispatch と同型
// (App.tsx): withDetailDocument (via the SINGLE planDetailDocumentEdit) → complete-
// state FeatureSnapshot → createEditProposal(featureId, editTime, …) → the SAME U13
// edit binding startProcess attribute edits run → Committed ⇒ recordCommit = ONE undo
// unit (教訓 5.11 / FR-73). A Rejected result THROWS the pipeline's own message so the
// panel surfaces 保存に失敗 honestly (HB-3 honest-failure discipline; never silent).
//
// WHY THIS FILE (vertex-delete.ts / live-unshare.ts の同型 sibling, 教訓 5.34): the
// dispatch is a non-trivial wiring rule (target resolution at the edit time + the
// WRITE/no-op guards + the commit seam) that must be ONE Vitest-testable place — not
// inlined in the App effect. The App supplies the live ports; tests inject the same
// shapes.

import type { FeatureSnapshot } from '../domain/editing/index';
import {
  PROCESS_STATUS,
  createEditProposal,
  type EditProposal,
  type ProcessResult,
} from '../domain/consistency/index';
import type { DomainProject } from '../domain/persistence/index';
import type { NextTargetPreference } from '../domain/selection/index';
import type { TimePoint } from '../domain/time/time-point';

import { featuresAt } from './live-lookup';
import {
  DETAIL_DOCUMENT_PLAN,
  planDetailDocumentEdit,
} from './property/detail-document';
import { detailDocumentTooLongMessage } from './property/messages';
import type {
  DetailDocumentDispatch,
  DetailDocumentEditIntent,
} from './property/contracts';

/** The host ports the dispatch drives (the SAME seams App wires for attribute edits). */
export interface DetailDocumentDispatchDeps {
  readonly getRoot: () => DomainProject;
  /** The U13 edit pipeline (createLiveEditBinding(...).startProcess). */
  readonly startProcess: (
    proposal: EditProposal<FeatureSnapshot>,
  ) => ProcessResult<DomainProject>;
  /**
   * Record ONE undo unit + re-resolve selection (App recordCommit). `anchorTime` is
   * the COMMIT's anchor time — the intent's editTime, which can differ from the
   * view time (fr100: the auto-recolor funnel evaluates at this instant).
   */
  readonly recordCommit: (
    result: ProcessResult<DomainProject>,
    preference: NextTargetPreference,
    anchorTime: TimePoint,
  ) => void;
}

/**
 * Build the live {@link DetailDocumentDispatch} (FR-98). The guards mirror the
 * section UI's (the SAME planDetailDocumentEdit — 単一真実源 5.29):
 *   - target absent at the edit time → throws (honest, the panel shows why);
 *   - over-length → throws the SAME Japanese message the UI shows (defensive — the
 *     section already refuses to dispatch; the dispatch must never half-apply);
 *   - no-op → returns WITHOUT dispatching (no ghost undo, 教訓 5.24);
 *   - edit → ONE proposal at the intent's editTime, committed via the injected
 *     pipeline and recorded as ONE undo unit with the target promoted (教訓 5.11).
 */
export function createDetailDocumentDispatch(
  deps: DetailDocumentDispatchDeps,
): DetailDocumentDispatch {
  return {
    dispatchDetailDocument(intent: DetailDocumentEditIntent): void {
      const feature = featuresAt(deps.getRoot(), intent.editTime).find(
        (f) => f.id === intent.featureId,
      );
      if (feature === undefined) {
        throw new Error('編集対象が現在の時刻に存在しません。');
      }
      const plan = planDetailDocumentEdit(feature, intent.detailDocument);
      if (plan.kind === DETAIL_DOCUMENT_PLAN.TooLong) {
        throw new Error(detailDocumentTooLongMessage(plan.length));
      }
      if (plan.kind === DETAIL_DOCUMENT_PLAN.NoOp) {
        return; // nothing to save — no ghost undo entry (教訓 5.24)
      }
      // Geometry is unchanged — only the record's optional field moves (vertices: []).
      const snapshot: FeatureSnapshot = { feature: plan.feature, vertices: [] };
      const proposal = createEditProposal(intent.featureId, intent.editTime, snapshot);
      const result = deps.startProcess(proposal);
      if (result.status === PROCESS_STATUS.Committed) {
        deps.recordCommit(result, { featureId: intent.featureId }, intent.editTime);
        return;
      }
      if (result.status === PROCESS_STATUS.Rejected) {
        throw new Error(result.message);
      }
      // detectSpatial=[] on the edit binding, so a document-only edit never reaches
      // ConflictsPending; surface honestly if it somehow does (never a silent success).
      throw new Error('詳細文書の編集を適用できませんでした。');
    },
  };
}
