// UI layer (U20 / shell): 「描きかけを捨てますか」の確認板（設計書 §D.4.1 の 3 /
// §B.5 の台帳 #8）。**5 道具と追加の道具が共有する 1 本の器**である。
//
// --- なぜ 1 本にしたか（増分 5 の手直し 2 回目）------------------------------
//
// 1. **旧版は地図セルの覆いの中に、層を持たない普通の子として出ていた。** 同じ覆いには
//    5 道具の入力ブリッジ（`z-index: 1`）が居るので、**板のボタンの上に入力ブリッジが
//    乗った** ―― 実測で、面 3 点の下書き中にナイフへ持ち替えると、板の［続ける］の
//    座標で `elementFromPoint` が `knife-input-layer` を返し、マウスでは押せなかった。
//    板が出ているあいだの地図クリックも切替先の道具に届き、対象を掴んでしまっていた。
//    **本物のモーダル**（最前面の固定層＋背面を覆う板）にすれば、この型の事故は
//    構造的に起こり得ない（教訓 5.14: 重なる UI は入力を受ける層も同時に設計する）。
// 2. **確定できる点数の下書きは 分ける・輪郭・穴あけ にもある**（設計書 §D.4.1 の表の
//    1 行目）。3 通りに書き分けると必ず割れる（N-27 の「確定ボタンが 6 通りに割れた」と
//    同じ形）。器・文言・答え方を 1 か所に置く。
//
// 板の作り（`*-modal-root` / `*-backdrop` / `*-dialog`）は継承先選択（`knife.css`）と
// 最上位化の確認（`reparent.css`）と **同じ作法**である。`data-testid` だけは道具ごとに
// 別名を持つ（T-1: 役割で維持する ―― 「追加の下書きの確認」と「分断線の下書きの確認」は
// 別の役割で、検査はどちらが出ているかを見分けられる必要がある）。

import { DRAFT_DISCARD_STRINGS } from './strings';

/** 何が起きて聞いているか（文言と、Escape の答え方が変わる＝設計書 §D.4.1 の 4）。 */
export const DISCARD_REASON = {
  /** 利用者自身が Escape で「やめる」と言った。 */
  Escape: 'escape',
  /** 年が動いた。 */
  Time: 'time',
  /** 一覧で別の地物を選んだ。 */
  Select: 'select',
  /** 別の道具へ持ち替えようとした。 */
  Tool: 'tool',
  /** 鍵を「読むだけ」にしようとした。 */
  Lock: 'lock',
} as const;

export type DiscardReason = (typeof DISCARD_REASON)[keyof typeof DISCARD_REASON];

export interface DraftDiscardConfirmProps {
  /** `data-testid` の頭（`<prefix>-confirm` / `-yes` / `-no`）。 */
  readonly idPrefix: string;
  /** 何が起きて聞いているか。 */
  readonly reason: DiscardReason;
  /** 打ちかけの頂点の数（文言に出す）。 */
  readonly vertexCount: number;
  readonly onKeep: () => void;
  readonly onDiscard: () => void;
}

/**
 * 板そのもの。**背面を覆う板を必ず置く** ―― 置かないと、板が出ているあいだの地図
 * クリックが下の入力ブリッジに届く（上の注記 1）。
 */
export function DraftDiscardConfirm(props: DraftDiscardConfirmProps): JSX.Element {
  const { idPrefix, reason, vertexCount, onKeep, onDiscard } = props;
  const titleId = `${idPrefix}-confirm-title`;
  return (
    <div className="draft-discard-modal-root" data-testid={`${idPrefix}-confirm-root`}>
      <div className="draft-discard-backdrop" data-testid={`${idPrefix}-confirm-backdrop`} />
      <div
        className="draft-discard-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={`${idPrefix}-confirm`}
      >
        <h3 className="draft-discard-dialog__title" id={titleId}>
          {DRAFT_DISCARD_STRINGS.title}
        </h3>
        <p className="draft-discard-dialog__body">
          {DRAFT_DISCARD_STRINGS.message(vertexCount, reason)}
        </p>
        <div className="draft-discard-dialog__footer">
          <button type="button" data-testid={`${idPrefix}-no`} onClick={onKeep}>
            {DRAFT_DISCARD_STRINGS.no}
          </button>
          <button type="button" data-testid={`${idPrefix}-yes`} onClick={onDiscard}>
            {DRAFT_DISCARD_STRINGS.yes}
          </button>
        </div>
      </div>
    </div>
  );
}
