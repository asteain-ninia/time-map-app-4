// UI layer (U32 / property panel): the 作業メモ editor section (FR-98).
//
// **作業メモはプレーンテキストである**（FR-98、2026-11-03 の所有者の裁定）。書式の解釈・
// 画像の埋め込み・文書内リンクは行わないので、プレビューも閲覧／編集の切替も持たない。
// 編集できるときは文字の入力欄を 1 つ置き、読むだけのときは打った文字をそのまま
// （改行も含めて）文字として出す。HTML として挿入する経路は無い（React の文字の
// 子要素だけで出す）。保存形式の欄の名前は `detailDocument` のままで、中身の意味だけが
// 作業メモに変わった（保存形式は互換を作らない方針なので、欄の名前は変えずに済ませた）。
//
// The EDIT surface lives in the SIDEBAR property panel; the floating DetailPanel
// stays VIEW-ONLY.
//
// **保存ボタンはここには無い**（増分 2 / N-46）。以前は素性欄の中に「押さないと
// 保存されない」場所が 2 つあり（基本情報の保存と、作業メモの別の保存）、同じ画面に
// 「押した瞬間に確定」する存続期間の操作まで同居していた。下書きはパネルが 1 つ
// 持ち、**素性欄の下端の 1 本の保存列**で確定する（1 回の押下＝1 つの取り消し単位）。
//
// Disciplines:
//   - ONE editable gate for the whole section (教訓 5.13): view mode shows the
//     committed text only — no dead textarea.
//   - 下書きの作り直し（教訓 5.2）と、打ちかけを捨てるときの確認（N-04）はパネルの責任。
//   - 長すぎる下書きの拒否（FR-98）はパネルの保存経路が {@link planDetailDocumentEdit}
//     で行う（WRITE ガードの単一真実源, 教訓 5.29）。

import type { Feature } from '../../domain/feature';

import { PROPERTY_STRINGS } from './messages';

export interface DetailDocumentSectionProps {
  /** The feature whose作業メモ is shown/edited (the resolved edit target). */
  readonly feature: Feature;
  /** Whole-section edit gate (教訓 5.13). False = committed text only. */
  readonly editable: boolean;
  /** 表示・編集する下書きの作業メモ（親が持つ。単一真実源）。 */
  readonly draft: string;
  /** 下書きの書き換えを親へ返す。 */
  readonly onDraftChange: (next: string) => void;
}

export function DetailDocumentSection(props: DetailDocumentSectionProps): JSX.Element {
  const { feature, editable, draft, onDraftChange } = props;

  // The committed baseline ('' for absent — the textarea's canonical empty form).
  const baseline = feature.detailDocument ?? '';

  return (
    /* 増分 2 の手直し D2 / 設計書 §C.6: 節は畳める。初期は折りたたみで、畳んだままでも
       中身の量が読めるように見出しに字数を添える（「▸ 作業メモ（0 字）」）。 */
    <details className="detail-document" data-testid="detail-document-section">
      <summary data-testid="detail-document-summary">
        {PROPERTY_STRINGS.detailDocumentTitleWithLength(draft.length)}
      </summary>

      {editable ? (
        <>
          <textarea
            data-testid="detail-doc-textarea"
            aria-label={PROPERTY_STRINGS.detailDocTextareaLabel}
            value={draft}
            rows={8}
            onChange={(e) => onDraftChange(e.target.value)}
          />
          <p className="detail-document__hint" data-testid="detail-doc-save-hint">
            {PROPERTY_STRINGS.detailDocSaveHint}
          </p>
        </>
      ) : baseline.length > 0 ? (
        <p className="detail-document__text" data-testid="detail-doc-text">
          {baseline}
        </p>
      ) : (
        <p className="detail-document__empty" data-testid="detail-doc-empty">
          {PROPERTY_STRINGS.detailDocEmpty}
        </p>
      )}
    </details>
  );
}
