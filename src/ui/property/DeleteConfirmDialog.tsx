// UI layer (U31 / FR-85): 地物を削除するときの確認ダイアログ **1 個**（A8）。
//
// **これまで削除の確認は素性欄のボタンにしか無かった。** Delete キーと右クリックの
// 「削除」は同じ「地物の全錨削除」を **確認なしで即座に** 実行し、しかも画面には何も
// 出なかった（消えたことに気づかないまま作業が進む）。所有者の裁定は「消す前に何が
// 起きるかを必ず見せる」なので、3 経路とも同じ文言・同じ形の確認を通す。
//
// この部品は**器だけ**を持つ。何を消すか・消したあと何をするかは呼び出し側が決める
// （素性欄のボタンは自分の対象、Delete キーと右クリックは App の削除漏斗）。同じ部品を
// 使うことで、文言・Esc の扱い・フォーカスの罠・ボタンの並びが 3 経路で一致する
// （教訓 5.6: 同じ種類の判断は同じ形で聞く）。
//
// 影響の一覧（何が道連れになるか・子はどこへ行くか）の本格版は増分 7 で入る。ここでは
// 「対象の名前を出す」までにとどめる——名前すら出ていなかったのが今の状態である。

import { useCallback, useEffect, useRef } from 'react';

import { useModalKeydown, useModalRegistration } from '../a11y/index';
import { MSG_DELETE_CONFIRM_BODY, MSG_DELETE_CONFIRM_TITLE } from '../../domain/deletion/index';

export interface DeleteConfirmDialogProps {
  /**
   * 消す対象の名前（分かるときだけ）。null / 未指定なら名前の行を出さない。
   * 「どれを消そうとしているのか」が確認の本体なので、分かる経路では必ず渡す。
   */
  readonly featureName?: string | null;
  /** 「削除」を押した。 */
  readonly onConfirm: () => void;
  /** 「キャンセル」・Esc・背景の閉じる。**安全側**（何もしない）。 */
  readonly onCancel: () => void;
  /** 「板が出ている」と名乗る口（司令塔の決定 (13)）。 */
  readonly onModalChange?: (open: boolean) => void;
}

export function DeleteConfirmDialog(props: DeleteConfirmDialogProps): JSX.Element {
  const { featureName = null, onConfirm, onCancel, onModalChange } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 出ている間は自分で名乗る（決定 (13)）。
  useModalRegistration(onModalChange, true);

  const cancel = useCallback(() => onCancel(), [onCancel]);
  // Esc cancels and Tab / Shift+Tab cycle inside the dialog (背面へ抜けない) — the
  // shared trap (教訓 5.13 / 5.14), consistent with the app's other role=dialog modals.
  const onKeyDown = useModalKeydown(dialogRef, cancel);

  // Focus the dialog when it opens so Esc / Tab are captured (教訓 5.14).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={MSG_DELETE_CONFIRM_TITLE}
      className="delete-confirm"
      data-testid="delete-confirm"
      tabIndex={-1}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <p>{MSG_DELETE_CONFIRM_BODY}</p>
      {featureName !== null && featureName !== '' && (
        <p className="delete-confirm__target" data-testid="delete-confirm-target">
          対象: {featureName}
        </p>
      )}
      <div className="delete-confirm-actions">
        <button type="button" aria-label="削除を確定" onClick={onConfirm}>
          削除
        </button>
        <button type="button" aria-label="削除をキャンセル" onClick={cancel}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
