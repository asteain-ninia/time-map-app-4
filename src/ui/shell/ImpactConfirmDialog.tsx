// UI layer (U20 / shell): **消す前に何が起きるかを見せる、方針中立の器**
//（設計書 §A.3 / §N-3 / 増分 7 の中身 6・7）。
//
// **これが直すもの**: 消す操作の確認は「よろしいですか？」しか言わなかった。所有者の
// 裁定は「削除＝その地物の錨をすべて削除し、子は最上位へ昇格。**消す前に影響を見せる**」
// なので、何が一緒に消えて、誰がどこへ移るのかを **文で**出してから確定する。
//
// **方針中立**（設計書 §A.3 の「UI 契約」）: この器は数え上げた結果を並べるだけで、
// 「掃除して消す」「参照があれば断る」のどちらの方針かを知らない。断る方針に転んだら
// {@link ImpactConfirmDialogProps.blockedReason} を渡せば、実行ボタンが灰色になって
// 理由が脇に出る ―― **画面を作り直さずに済む。**
//
// **同じ器を 4 か所で使う**（N-05 の 3 件がまとめて片付く。増分 7 の中身 7）:
//   地物を全部の年から消す／錨を消す／輪郭（穴・飛び地）を消す／複数の頂点を消す。
// とくに「最後の外周を消すと面ごと消える」は、この器の一覧に **事前の文**として出す。

import { useCallback, useEffect, useRef } from 'react';

import { useModalKeydown } from '../a11y/index';

/** 影響の一覧の 1 群（見出しと、その中の行）。行が 0 本なら群ごと出さない。 */
export interface ImpactGroup {
  readonly testId: string;
  readonly heading: string;
  readonly lines: readonly string[];
}

export interface ImpactConfirmDialogProps {
  /** `data-testid` の前置き（呼び出し側ごとに違う）。 */
  readonly testIdPrefix: string;
  /** 板の見出し（「『デーレ共和国』を全部の年から消します」）。 */
  readonly title: string;
  /** 影響の一覧。 */
  readonly groups: readonly ImpactGroup[];
  /**
   * 実行できない理由（あれば実行ボタンを無効にして脇に出す）。`null` なら実行できる。
   * **方針が「参照があれば断る」へ転んだときの受け口**でもある（設計書 §A.3 の 3）。
   */
  readonly blockedReason?: string | null;
  /** 実行ボタンの文言（何が起きるかを言い切る）。 */
  readonly confirmLabel: string;
  /** 取りやめの文言。 */
  readonly cancelLabel: string;
  /** 脇に出す注記（「※ Ctrl+Z で戻せます」）。 */
  readonly note?: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ImpactConfirmDialog(props: ImpactConfirmDialogProps): JSX.Element {
  const {
    testIdPrefix,
    title,
    groups,
    blockedReason = null,
    confirmLabel,
    cancelLabel,
    note = null,
    onConfirm,
    onCancel,
  } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const cancel = useCallback(() => onCancel(), [onCancel]);
  // Esc で閉じ、Tab は板の中を回る（背面へ抜けない）。ほかの板と同じ共有の罠。
  const onKeyDown = useModalKeydown(dialogRef, cancel);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const shown = groups.filter((g) => g.lines.length > 0);

  return (
    <div className="impact-confirm-root" data-testid={`${testIdPrefix}-root`}>
      {/* 背面を覆って入力を止める（教訓 5.14）。 */}
      <div
        className="impact-confirm-backdrop"
        data-testid={`${testIdPrefix}-backdrop`}
        aria-hidden="true"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onClickCapture={(e) => e.stopPropagation()}
      />
      <div
        className="impact-confirm-dialog"
        data-testid={testIdPrefix}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <h3 className="impact-confirm-dialog__title" data-testid={`${testIdPrefix}-title`}>
          {title}
        </h3>

        {shown.map((group) => (
          <section
            key={group.testId}
            className="impact-confirm-dialog__group"
            data-testid={`${testIdPrefix}-${group.testId}`}
          >
            <h4 className="impact-confirm-dialog__heading">{group.heading}</h4>
            <ul className="impact-confirm-dialog__lines">
              {group.lines.map((line, i) => (
                <li key={`${String(i)}-${line}`}>{line}</li>
              ))}
            </ul>
          </section>
        ))}

        {blockedReason !== null && (
          <p
            className="impact-confirm-dialog__blocked"
            role="alert"
            data-testid={`${testIdPrefix}-blocked`}
          >
            {blockedReason}
          </p>
        )}

        <div className="impact-confirm-dialog__footer">
          <button
            type="button"
            className="impact-confirm-dialog__cancel"
            data-testid={`${testIdPrefix}-cancel`}
            onClick={cancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="impact-confirm-dialog__confirm"
            data-testid={`${testIdPrefix}-confirm`}
            disabled={blockedReason !== null}
            onClick={() => onConfirm()}
          >
            {confirmLabel}
          </button>
        </div>
        {note !== null && (
          <p className="impact-confirm-dialog__note" data-testid={`${testIdPrefix}-note`}>
            {note}
          </p>
        )}
      </div>
    </div>
  );
}
