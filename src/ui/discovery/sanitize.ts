// U41 — the search-preprocessing sanitize入口 (FR-116 / NFR 5.5, ui layer).
//
// 機能宣言: マークダウン詳細文書 (FR-98) 等の外部由来テキストは無害化してから表示・検索に
// 用いる。検索対象はレンダリング前の原文ではなく「サニタイズ済みの素テキスト」とし、
// マークダウン記法を素テキストとして扱う (スコープ §1/2). サニタイズ機構本体 (HTML
// レンダラ+DOMPurify) は依存ユニット (U32 markdown.ts) が持つので、本モジュールはそれを
// 「必ず通す」横断規約の検索側入口だけを担う (過少共有の戒め, 教訓 5.30: 本体を二重に
// 作らない)。
//
// 適用 (技術方針 2.11 / R8): 検索が説明テキストを取り込む経路は必ず `toSearchableText`
// を通る。HTML 化された詳細文書 (依存ユニットがサニタイズ済みで渡す) からタグを取り除いて
// 素テキスト化し、検索インデックスへ未サニタイズの HTML が流入しない。
//
// 純粋: 文字列入力 → 文字列出力。DOM に触れない (タグ除去は正規表現でなく文字走査ベース
// の単純除去なので jsdom 不要で Vitest 単体テスト可能)。

/**
 * Reduce arbitrary text (a Markdown source OR already-sanitized HTML produced by
 * the dependency renderer) to a PLAIN searchable string:
 *   - strip HTML tags (`<...>`) — the rendered/sanitized document is HTML, and
 *     search must not match on tag names or attribute values;
 *   - strip a conservative set of Markdown markup characters so a search for the
 *     word matches whether or not it was wrapped in `**` / `_` / `` ` `` etc.;
 *   - collapse whitespace to single spaces and trim.
 *
 * This is intentionally lossy and one-directional: it produces a素テキスト for
 * matching only, never for display (display goes through U32's renderer).
 */
export function toSearchableText(raw: string): string {
  return collapseWhitespace(stripMarkdownMarkup(stripHtmlTags(raw)));
}

/** Remove HTML tags by scanning for `<...>` spans (no DOM, no regex backtracking). */
function stripHtmlTags(input: string): string {
  let out = '';
  let inTag = false;
  for (const ch of input) {
    if (ch === '<') {
      inTag = true;
      continue;
    }
    if (ch === '>') {
      inTag = false;
      out += ' ';
      continue;
    }
    if (!inTag) out += ch;
  }
  return out;
}

/** Markup characters stripped so word matches survive Markdown emphasis/format. */
const MARKUP_CHARS = new Set<string>([
  '*', '_', '`', '#', '>', '~', '[', ']', '(', ')', '!',
]);

/** Remove standalone Markdown markup characters (keeps the words between them). */
function stripMarkdownMarkup(input: string): string {
  let out = '';
  for (const ch of input) {
    out += MARKUP_CHARS.has(ch) ? ' ' : ch;
  }
  return out;
}

/** Collapse runs of whitespace to a single space and trim the ends. */
function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
