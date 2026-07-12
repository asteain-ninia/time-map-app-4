// UI layer (U32 / property panel): the 詳細文書 editor section (FR-98 後段).
//
// The EDIT surface for a feature's detail document lives in the SIDEBAR property
// panel (設計批評の採択); the floating DetailPanel stays VIEW-ONLY. The section
// shows a 閲覧 (sanitized preview = the EXISTING MarkdownView — no second render
// path, FR-116) / 編集 (raw Markdown textarea) toggle plus an explicit 保存 button.
//
// Disciplines:
//   - ONE editable gate for the whole section (教訓 5.13): view mode / an unwired
//     dispatch shows the sanitized preview only — no dead textarea or save button.
//   - The draft re-seeds on the EDIT-TARGET boundary 地物×錨 (feature.id × anchorId),
//     the SAME rule BasicInfoForm uses (教訓 5.2 / bughunt 第12波 #1): a time move
//     that advances the effective anchor re-seeds from the CURRENT anchor's snapshot;
//     selection-object churn that names the same target preserves the draft.
//   - WRITE guard BEFORE dispatch (FR-98): an over-length draft surfaces an honest
//     Japanese message and never dispatches (the domain RangeError is the last防波堤,
//     not the UX); a no-op draft dispatches nothing (教訓 5.24). Both decided by the
//     SINGLE planDetailDocumentEdit the live dispatch also consults (教訓 5.29).
//   - The held message follows 教訓 5.12: cleared only by a same-operation re-save,
//     an explicit dismiss, or a successful save — never by unrelated操作.

import { useState } from 'react';

import type { Feature } from '../../domain/feature';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

import type { AssetResolver } from './contracts';
import { DETAIL_DOCUMENT_PLAN, planDetailDocumentEdit } from './detail-document';
import { MarkdownView } from './MarkdownView';
import { PROPERTY_STRINGS, detailDocumentTooLongMessage } from './messages';

export interface DetailDocumentSectionProps {
  /** The feature whose詳細文書 is shown/edited (the resolved edit target). */
  readonly feature: Feature;
  /** Whole-section edit gate (教訓 5.13). False = sanitized preview only. */
  readonly editable: boolean;
  /** The edit time = current edit-target anchor's start time (教訓 5.15). */
  readonly editTime: TimePoint | null;
  /** The edit-target ANCHOR id — the draft re-seed boundary 地物×錨 (教訓 5.2). */
  readonly anchorId: AnchorId | null;
  /** Resolves ZIP-internal image references for the preview (FR-02). */
  readonly assetResolver: AssetResolver;
  /** Object-reference (feature:) link clicks in the preview (U22). */
  readonly onSelectFeature?: (featureId: FeatureId) => void;
  /**
   * Save handler (the parent owns dispatch — propertyEditDispatch と同型). Receives
   * the raw draft + edit time; returns an error message to display, or null.
   * Called ONLY for a real edit (the no-op / over-length guards run here first).
   */
  readonly onSave: (detailDocument: string, editTime: TimePoint) => string | null;
}

export function DetailDocumentSection(props: DetailDocumentSectionProps): JSX.Element {
  const { feature, editable, editTime, anchorId, assetResolver, onSelectFeature, onSave } =
    props;

  // The committed baseline ('' for absent — the textarea's canonical empty form).
  const baseline = feature.detailDocument ?? '';

  const [draft, setDraft] = useState<string>(baseline);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Re-seed the draft when the EDIT TARGET (地物×錨) changes — the BasicInfoForm
  // sentinel pattern (render-time state sync, no effect). The transient 閲覧/編集
  // toggle also resets (教訓 5.2); the held message is PRESERVED (教訓 5.12 — a
  // target change is not one of the three clear契機).
  const editTargetKey = `${feature.id as unknown as string} ${
    anchorId === null ? '' : (anchorId as unknown as string)
  }`;
  const [syncedTargetKey, setSyncedTargetKey] = useState<string>(editTargetKey);
  if (syncedTargetKey !== editTargetKey) {
    setSyncedTargetKey(editTargetKey);
    setDraft(baseline);
    setEditing(false);
  }

  function handleSave(): void {
    if (editTime === null) {
      setMessage(`${PROPERTY_STRINGS.saveFailedPrefix}編集対象の錨が選択されていません。`);
      return;
    }
    const plan = planDetailDocumentEdit(feature, draft);
    if (plan.kind === DETAIL_DOCUMENT_PLAN.TooLong) {
      // WRITE guard (FR-98): honest rejection BEFORE any dispatch.
      setMessage(detailDocumentTooLongMessage(plan.length));
      return;
    }
    if (plan.kind === DETAIL_DOCUMENT_PLAN.NoOp) {
      // 教訓 5.24: no ghost undo. Clearing the message is the same-operation契機.
      setMessage(null);
      return;
    }
    setMessage(onSave(draft, editTime));
  }

  const showEditor = editable && editing;

  return (
    <section className="detail-document" data-testid="detail-document-section">
      <h3>{PROPERTY_STRINGS.detailDocumentTitle}</h3>

      {editable && (
        <div
          className="detail-document__modes"
          role="group"
          aria-label={PROPERTY_STRINGS.detailDocumentTitle}
        >
          <button
            type="button"
            data-testid="detail-doc-mode-view"
            aria-pressed={!editing}
            onClick={() => setEditing(false)}
          >
            {PROPERTY_STRINGS.detailDocViewToggle}
          </button>
          <button
            type="button"
            data-testid="detail-doc-mode-edit"
            aria-pressed={editing}
            onClick={() => setEditing(true)}
          >
            {PROPERTY_STRINGS.detailDocEditToggle}
          </button>
        </div>
      )}

      {showEditor ? (
        <textarea
          data-testid="detail-doc-textarea"
          aria-label={PROPERTY_STRINGS.detailDocTextareaLabel}
          value={draft}
          rows={8}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : /* 閲覧: the sanitized preview — the EXISTING MarkdownView is the ONLY
             render path (FR-116; no second sanitizer). While editable, the preview
             shows the DRAFT so a 編集→閲覧 toggle previews the unsaved text; in
             view-only mode the draft always equals the committed baseline. */
      (editable ? draft : baseline).length > 0 ? (
        <MarkdownView
          source={editable ? draft : baseline}
          assetResolver={assetResolver}
          {...(onSelectFeature ? { onSelectFeature } : {})}
        />
      ) : (
        <p className="detail-document__empty" data-testid="detail-doc-empty">
          {PROPERTY_STRINGS.detailDocEmpty}
        </p>
      )}

      {message !== null && (
        <div className="detail-document__message" role="alert" data-testid="detail-doc-message">
          <span>{message}</span>
          <button
            type="button"
            aria-label={PROPERTY_STRINGS.dismissMessage}
            onClick={() => setMessage(null)}
          >
            ×
          </button>
        </div>
      )}

      {showEditor && (
        <button
          type="button"
          className="detail-document__save"
          data-testid="detail-doc-save"
          onClick={handleSave}
        >
          {PROPERTY_STRINGS.saveButton}
        </button>
      )}
    </section>
  );
}
