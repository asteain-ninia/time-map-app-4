// UI layer (U32 / 素性欄): **印を付けた地物へまとめて種別を付ける板**
//（FR-73 / FR-94 / 増分 7 の中身 8）。
//
// **これが直すもの**: 実データには種別ラベルの付いていない地物が 335 件ある。1 件ずつ
// 保存すると取り消しが 335 手になり、**間違えたときに戻せない**（設計書 §C.5 / §D.5）。
// この板の確定は 1 つの複合コマンドに畳まれるので、**Ctrl+Z 1 回で全部戻る。**
//
// 手順は右クリックから 4 手（一覧でマーク → 右クリック →「まとめて種別を付ける」→
// 種別を打って確定）。確定に時間がかかる件数なので、**進行表示を出し、その間は
// 押せない**（`useDeferredCommit`。所属変更の確定と同じ器）。

import { useCallback, useEffect, useRef, useState } from 'react';

import { useModalKeydown } from '../a11y/index';
import { useDeferredCommit, type CommitScheduler } from '../shell/useDeferredCommit';

import { PROPERTY_STRINGS } from './messages';

export interface BulkKindLabelDialogProps {
  /** 相手の件数（見出しに出す）。 */
  readonly count: number;
  /** 確定（種別ラベル。空文字は「種別を外す」）。 */
  readonly onConfirm: (kindLabel: string) => void;
  readonly onCancel: () => void;
  /** 確定を遅らせる口（検査は同期の実装を差し込む）。 */
  readonly commitScheduler?: CommitScheduler | undefined;
}

export function BulkKindLabelDialog(props: BulkKindLabelDialogProps): JSX.Element {
  const { count, onConfirm, onCancel } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [kindLabel, setKindLabel] = useState('');
  const deferred = useDeferredCommit(
    props.commitScheduler === undefined ? undefined : { schedule: props.commitScheduler },
  );

  const onKeyDown = useModalKeydown(dialogRef, onCancel);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const confirm = useCallback(() => {
    deferred.run(() => onConfirm(kindLabel.trim()));
  }, [deferred, onConfirm, kindLabel]);

  return (
    <div className="impact-confirm-root" data-testid="bulk-kind-root">
      <div
        className="impact-confirm-backdrop"
        data-testid="bulk-kind-backdrop"
        aria-hidden="true"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onClickCapture={(e) => e.stopPropagation()}
      />
      <div
        className="impact-confirm-dialog"
        data-testid="bulk-kind-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={PROPERTY_STRINGS.bulkKindTitle(count)}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <h3 className="impact-confirm-dialog__title">{PROPERTY_STRINGS.bulkKindTitle(count)}</h3>
        <p className="impact-confirm-dialog__note">{PROPERTY_STRINGS.bulkKindHint}</p>
        <input
          type="text"
          data-testid="bulk-kind-input"
          aria-label={PROPERTY_STRINGS.bulkKindInputLabel}
          placeholder={PROPERTY_STRINGS.bulkKindInputLabel}
          value={kindLabel}
          onChange={(e) => setKindLabel(e.target.value)}
        />
        <p className="impact-confirm-dialog__note">{PROPERTY_STRINGS.bulkKindEmptyNote}</p>
        {deferred.busy && (
          <p
            className="impact-confirm-dialog__note"
            role="status"
            aria-live="polite"
            data-testid="bulk-kind-progress"
          >
            {PROPERTY_STRINGS.bulkKindCommitting}
          </p>
        )}
        <div className="impact-confirm-dialog__footer">
          <button type="button" data-testid="bulk-kind-cancel" onClick={() => onCancel()}>
            {PROPERTY_STRINGS.bulkKindCancel}
          </button>
          <button
            type="button"
            className="impact-confirm-dialog__confirm"
            data-testid="bulk-kind-confirm"
            disabled={deferred.busy}
            aria-busy={deferred.busy}
            onClick={confirm}
          >
            {PROPERTY_STRINGS.bulkKindConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
