// UI layer (U39): the unsaved-changes warning DIALOG BODY (FR-107 / spec §B).
//
// This is the renderable React component the spec §B requires: the 3-choice
// warning (保存して続行 / 保存せずに続行 / キャンセル) mounted on U20's
// DraggablePanel modal vessel (spec §依存 U20「モーダルの器に載せる」). It is a
// PURE PRESENTATION over the decision model: each button resolves the user's
// {@link UnsavedChoice} back to the caller, which feeds it into
// `decideUnsavedGuard` / `runUnsavedGuard` (unsaved-guard.ts). The dialog owns no
// branch logic — that lives in the pure decision model (受け入れ基準 7 / 教訓 5.41).
//
// The 3 callers (新ファイル読み込み / アプリ終了 / 新規プロジェクト開始) all show
// THIS one dialog through `runUnsavedGuard`'s `promptUnsaved` port, so no path
// gets a different dialog (教訓 5.6 / 受け入れ基準 2).

import { useCallback, useEffect, useRef } from 'react';

import { DraggablePanel } from '../shell/DraggablePanel';
import { useModalKeydown } from '../a11y/index';
import { UNSAVED_CHOICE, type UnsavedChoice } from './unsaved-guard';
import { UNSAVED_STRINGS } from './strings';

export interface UnsavedWarningDialogProps {
  /**
   * Resolve the user's 3-choice. Wired to `runUnsavedGuard`'s `promptUnsaved`
   * port resolver: 保存 → Save, 保存せず続行 → Discard, キャンセル → Cancel. Esc
   * and the close button both resolve Cancel (キャンセル = keep current state,
   * the safe default — never silently discard).
   */
  readonly onChoose: (choice: UnsavedChoice) => void;
  /** Front-most z-index from U20's z-order model (FR-112 前面化). */
  readonly zIndex?: number;
}

/** Initial position of the warning panel (centred-ish on the overlay). */
const INITIAL_POSITION = { x: 360, y: 220 } as const;

export function UnsavedWarningDialog(props: UnsavedWarningDialogProps): JSX.Element {
  const { onChoose, zIndex } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Esc resolves キャンセル (the safe default: keep state, protect unsaved data) and
  // Tab / Shift+Tab cycle inside the dialog — the shared trap (教訓 5.13).
  const cancel = useCallback(() => onChoose(UNSAVED_CHOICE.Cancel), [onChoose]);
  const onKeyDown = useModalKeydown(rootRef, cancel);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  return (
    <div
      className="unsaved-modal-root"
      data-testid="unsaved-modal-root"
      role="dialog"
      aria-modal="true"
      aria-label={UNSAVED_STRINGS.title}
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <DraggablePanel
        id="unsaved-warning"
        title={UNSAVED_STRINGS.title}
        initialPosition={INITIAL_POSITION}
        zIndex={zIndex ?? 1000}
        onClose={() => onChoose(UNSAVED_CHOICE.Cancel)}
      >
        <div className="unsaved-dialog" data-testid="unsaved-dialog">
          <p className="unsaved-dialog__body" data-testid="unsaved-body">
            {UNSAVED_STRINGS.body}
          </p>
          <div className="unsaved-dialog__choices">
            <button
              type="button"
              className="unsaved-dialog__save"
              data-testid="unsaved-save"
              onClick={() => onChoose(UNSAVED_CHOICE.Save)}
            >
              {UNSAVED_STRINGS.save}
            </button>
            <button
              type="button"
              className="unsaved-dialog__discard"
              data-testid="unsaved-discard"
              onClick={() => onChoose(UNSAVED_CHOICE.Discard)}
            >
              {UNSAVED_STRINGS.discard}
            </button>
            <button
              type="button"
              className="unsaved-dialog__cancel"
              data-testid="unsaved-cancel"
              onClick={() => onChoose(UNSAVED_CHOICE.Cancel)}
            >
              {UNSAVED_STRINGS.cancel}
            </button>
          </div>
        </div>
      </DraggablePanel>
    </div>
  );
}
