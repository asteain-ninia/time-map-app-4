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

import { useCallback, useState } from 'react';

import { DELETE_TARGET_KIND, type DeleteTarget } from '../../domain/deletion/index';
import type { FeatureId } from '../../domain/ids';

import { ImpactConfirmDialog } from '../shell/ImpactConfirmDialog';

import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import type { DeleteImpactView } from './delete-impact';
import { PROPERTY_STRINGS } from './messages';

/**
 * ボタンの文言（増分 7 の中身 5）。**「地物を削除」から言い換えた** ―― 素性欄には
 * 「この年に終わったことにする」（入口 A）が別に立ったので、こちらが何をする側なのかを
 * 名乗らないと 2 つが見分けられない（設計書 §A.3 の 2 経路）。
 */
export const DELETE_BUTTON_LABEL = PROPERTY_STRINGS.deleteAllYearsLabel;

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
  /**
   * 編集の権限（教訓 5.13 / K-6）。**この入力が無かったせいで、表示専用モードでも
   * 「地物を削除」だけが押せていた**（N-03）。値を変える入力 10 個は全部 disabled なのに、
   * いちばん取り返しのつかない操作だけが関門を素通りしていた。呼び出し側は
   * `permissions.ts` の `canEdit(mode)` を渡す — ここで独自のモード判定を書かない
   * （部品ごとに判定を書くと、見た目だけ非表示でショートカットや右クリックが残る）。
   * 省略時は true（既存の呼び出しの意味を変えないため）。
   */
  readonly editable?: boolean;
  /**
   * 消す対象の名前（分かるときだけ）。確認ダイアログに「対象: ◯◯」として出る（A8）。
   * 名前を出さない確認は「何を消すのか」が分からないので確認の体をなさない。
   */
  readonly featureName?: string | null;
  /**
   * **消す前に見せる影響の一覧**（設計書 §A.3 / 増分 7 の中身 6）。呼び出し側が
   * `describeDeletionImpact` → `buildDeleteImpactView` で組み立てて渡す。
   *
   * **押した瞬間に解く**（`() => view` の形にしてある）―― 影響は全錨を走査するので、
   * ボタンが画面に居るあいだ毎回計算すると 775 地物で無駄が大きい。
   *
   * 省略した呼び出し側（薄い検査台）では、名前だけを出す従来の確認へ落ちる。
   */
  readonly resolveImpact?: (() => DeleteImpactView) | undefined;
  /**
   * 「板が出ている」と名乗る口（司令塔の決定 (13)）。渡さないと、確認が出ている間に
   * Ctrl+Z / Delete が背後へ抜ける（Fable #1）。
   */
  readonly onModalChange?: (open: boolean) => void;
  /**
   * 板を出す前に断るなら真を返す（読み込みの間。理由は呼ばれた側が状態行へ出す）。板を出してから読み込みが
   * 終わると、新しい書類へ効く。
   */
  readonly refuseOpen?: () => boolean;
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
  const { target, onConfirm, editable = true, featureName = null } = props;
  const featureId = targetFeatureId(target);
  // 対象があること **かつ** 編集できること (FR-85 ＋ 教訓 5.13 / K-6)。
  const enabled = featureId !== null && editable;

  const [confirming, setConfirming] = useState(false);
  // **影響は押した瞬間に 1 度だけ解く**（全錨の走査なので、開いているあいだ再計算しない）。
  const [impact, setImpact] = useState<DeleteImpactView | null>(null);

  const resolveImpact = props.resolveImpact;
  const refuseOpen = props.refuseOpen;
  const openConfirm = useCallback(() => {
    // 権限が無いときは確認ダイアログすら開かない（disabled 属性だけに頼ると、
    // 属性を外せる経路が 1 つでもあれば削除が通ってしまう）。
    if (featureId === null || !editable) return;
    if (refuseOpen?.() === true) return;
    setImpact(resolveImpact === undefined ? null : resolveImpact());
    setConfirming(true);
  }, [featureId, editable, resolveImpact, refuseOpen]);

  const cancel = useCallback(() => {
    // 教訓 5.22 / FR-85: cancel does nothing — no command, no history.
    setConfirming(false);
  }, []);

  const confirm = useCallback(() => {
    // Confirm only fires when a target exists AND editing is permitted (the button
    // was enabled to open). 権限は開くときと確定するときの両方で見る — ダイアログが
    // 開いたまま「読むだけ」へ切り替わっても削除が通らないようにするため。
    if (featureId !== null && editable) onConfirm(featureId);
    setConfirming(false);
  }, [featureId, editable, onConfirm]);

  // 確認ダイアログの器そのものは {@link DeleteConfirmDialog} が持つ（A8）。Delete キーと
  // 右クリックの「削除」も **同じ部品** を出すので、文言・Esc の扱い・フォーカスの罠・
  // ボタンの並びが 3 経路で必ず一致する（教訓 5.6）。

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

      {confirming && impact !== null ? (
        <ImpactConfirmDialog
          testIdPrefix="delete-impact"
          title={impact.title}
          groups={impact.groups}
          blockedReason={impact.blockedReason}
          confirmLabel={impact.confirmLabel}
          cancelLabel={impact.cancelLabel}
          note={impact.note}
          onConfirm={confirm}
          onCancel={cancel}
          {...(props.onModalChange ? { onModalChange: props.onModalChange } : {})}
        />
      ) : null}
      {confirming && impact === null ? (
        <DeleteConfirmDialog
          featureName={featureName}
          onConfirm={confirm}
          onCancel={cancel}
          {...(props.onModalChange ? { onModalChange: props.onModalChange } : {})}
        />
      ) : null}
    </div>
  );
}
