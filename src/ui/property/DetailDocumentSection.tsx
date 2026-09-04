// UI layer (U32 / property panel): the 詳細文書 editor section (FR-98 後段).
//
// The EDIT surface for a feature's detail document lives in the SIDEBAR property
// panel (設計批評の採択); the floating DetailPanel stays VIEW-ONLY. The section
// shows a 閲覧 (sanitized preview = the EXISTING MarkdownView — no second render
// path, FR-116) / 編集 (raw Markdown textarea) toggle.
//
// **保存ボタンはここには無い**（増分 2 / N-46）。以前は素性欄の中に「押さないと
// 保存されない」場所が 2 つあり（基本情報の保存と、詳細文書の別の保存）、同じ画面に
// 「押した瞬間に確定」する存続期間の操作まで同居していた。設計書 §C.6 の「保存の対象」
// は **名前・種別ラベル・見た目・詳細文書の 4 つ**と決めたので、下書きはパネルが 1 つ
// 持ち、**素性欄の下端の 1 本の保存列**で確定する（1 回の押下＝1 つの取り消し単位）。
//
// Disciplines:
//   - ONE editable gate for the whole section (教訓 5.13): view mode shows the
//     sanitized preview only — no dead textarea.
//   - 下書きの作り直し（教訓 5.2）と、打ちかけを捨てるときの確認（N-04）はパネルの責任。
//   - 長すぎる下書きの拒否（FR-98）はパネルの保存経路が {@link planDetailDocumentEdit}
//     で行う（WRITE ガードの単一真実源, 教訓 5.29）。

import { useState } from 'react';

import type { Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';

import type { AssetResolver } from './contracts';
import { MarkdownView } from './MarkdownView';
import { PROPERTY_STRINGS } from './messages';

export interface DetailDocumentSectionProps {
  /** The feature whose詳細文書 is shown/edited (the resolved edit target). */
  readonly feature: Feature;
  /** Whole-section edit gate (教訓 5.13). False = sanitized preview only. */
  readonly editable: boolean;
  /** 表示・編集する下書きの生 Markdown（親が持つ。単一真実源）。 */
  readonly draft: string;
  /** 下書きの書き換えを親へ返す。 */
  readonly onDraftChange: (next: string) => void;
  /** Resolves ZIP-internal image references for the preview (FR-02). */
  readonly assetResolver: AssetResolver;
  /** Object-reference (feature:) link clicks in the preview (U22). */
  readonly onSelectFeature?: (featureId: FeatureId) => void;
}

export function DetailDocumentSection(props: DetailDocumentSectionProps): JSX.Element {
  const { feature, editable, draft, onDraftChange, assetResolver, onSelectFeature } = props;

  // 閲覧／編集の切替だけがこのセクションの一時状態。**編集対象が変わったら捨てる**
  // （教訓 5.2）— パネルが地物×錨で key を付け直して remount するので、ここに
  // 同期の仕掛けは要らない。
  const [editing, setEditing] = useState(false);

  // The committed baseline ('' for absent — the textarea's canonical empty form).
  const baseline = feature.detailDocument ?? '';
  const showEditor = editable && editing;

  return (
    /* 増分 2 の手直し D2 / 設計書 §C.6: 節は畳める。初期は折りたたみで、畳んだままでも
       中身の量が読めるように見出しに字数を添える（「▸ 詳細文書（0 字）」）。 */
    <details className="detail-document" data-testid="detail-document-section">
      <summary data-testid="detail-document-summary">
        {PROPERTY_STRINGS.detailDocumentTitleWithLength(draft.length)}
      </summary>

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
    </details>
  );
}
