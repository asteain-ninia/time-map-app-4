// UI layer (U31 / FR-85): the "地物を削除" button + confirmation dialog.
//
// FR-85: プロパティタブに「地物を削除」ボタンを常設し、アクティブ地物または頂点選択
// コンテキストの地物がある場合のみ有効化する。押下時は確認ダイアログを提示し、確定時のみ
// 履歴記録を伴う削除処理を行う。
//
// Layer rules (技術方針 2.3 / 2.5): React drives the press → confirm → confirm path.
// The component is PRESENTATIONAL + callback-driven — it never touches domain state.
// The delete TARGET is resolved by U31's pure {@link resolveDeleteTarget} (active
// feature first, else single-owner vertex context — 教訓 5.4) from selection state
// the host passes in; the button is enabled ONLY when the target is a feature.
//
// 確定までの非破壊 (教訓 5.22): nothing happens until the user confirms; cancel does
// nothing (no command, no history). On confirm the component calls `onConfirm` with
// the target feature id; the HOST issues the U31 delete command and pushes ONE undo
// unit (教訓 5.24: the host's confirm handler guards no-op). The component does not
// push history itself.

import { useCallback, useEffect, useRef, useState } from 'react';

import { useModalKeydown } from '../a11y/index';
import {
  DELETE_TARGET_KIND,
  type DeleteTarget,
  MSG_DELETE_CONFIRM_BODY,
  MSG_DELETE_CONFIRM_TITLE,
} from '../../domain/deletion/index';
import type { FeatureId } from '../../domain/ids';

export const DELETE_BUTTON_LABEL = '地物を削除';

export interface DeleteFeatureButtonProps {
  /**
   * The resolved delete target (U31 `resolveDeleteTarget`). The button is enabled
   * iff this is a feature target (ActiveFeature / ContextFeature); `None` disables
   * it (FR-85: 対象ある時のみ有効). The host computes this from U22 selection so
   * the source of truth stays in U22 / U31 (no re-derivation here).
   */
  readonly target: DeleteTarget;
  /**
   * Called ONLY when the user confirms the dialog, with the target feature id.
   * The host issues the U31 delete command + pushes one undo unit (FR-73 / 85).
   */
  readonly onConfirm: (featureId: FeatureId) => void;
}

/** Read the feature id out of a feature-bearing target, else null (None → null). */
function targetFeatureId(target: DeleteTarget): FeatureId | null {
  switch (target.kind) {
    case DELETE_TARGET_KIND.ActiveFeature:
    case DELETE_TARGET_KIND.ContextFeature:
      return target.featureId;
    case DELETE_TARGET_KIND.None:
      return null;
    default: {
      const _never: never = target;
      return _never;
    }
  }
}

export function DeleteFeatureButton(props: DeleteFeatureButtonProps): JSX.Element {
  const { target, onConfirm } = props;
  const featureId = targetFeatureId(target);
  const enabled = featureId !== null;

  const [confirming, setConfirming] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const openConfirm = useCallback(() => {
    if (featureId !== null) setConfirming(true);
  }, [featureId]);

  const cancel = useCallback(() => {
    // 教訓 5.22 / FR-85: cancel does nothing — no command, no history.
    setConfirming(false);
  }, []);

  const confirm = useCallback(() => {
    // Confirm only fires when a target exists (button was enabled to open).
    if (featureId !== null) onConfirm(featureId);
    setConfirming(false);
  }, [featureId, onConfirm]);

  // Esc cancels and Tab / Shift+Tab cycle inside the dialog (背面へ抜けない) — the
  // shared trap (教訓 5.13 / 5.14), consistent with the app's other role=dialog modals
  // (bughunt review #5: this confirmation lacked Esc / focus-on-mount / Tab トラップ).
  const onKeyDown = useModalKeydown(dialogRef, cancel);

  // Focus the dialog when it opens so Esc / Tab are captured (教訓 5.14).
  useEffect(() => {
    if (confirming) dialogRef.current?.focus();
  }, [confirming]);

  return (
    <div className="delete-feature" data-testid="delete-feature">
      <button
        type="button"
        aria-label={DELETE_BUTTON_LABEL}
        disabled={!enabled}
        onClick={openConfirm}
      >
        {DELETE_BUTTON_LABEL}
      </button>

      {confirming ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={MSG_DELETE_CONFIRM_TITLE}
          className="delete-confirm"
          tabIndex={-1}
          ref={dialogRef}
          onKeyDown={onKeyDown}
        >
          <p>{MSG_DELETE_CONFIRM_BODY}</p>
          <div className="delete-confirm-actions">
            <button type="button" aria-label="削除を確定" onClick={confirm}>
              削除
            </button>
            <button type="button" aria-label="削除をキャンセル" onClick={cancel}>
              キャンセル
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
