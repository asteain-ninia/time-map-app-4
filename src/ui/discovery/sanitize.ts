// U41 — the search-preprocessing入口 (FR-116 / NFR 5.5, ui layer).
//
// 機能宣言: 検索が説明テキスト（地物の作業メモ, FR-98）を取り込む経路は必ず
// `toSearchableText` を通る。作業メモはプレーンテキストで、書式も HTML も解釈しない
// （FR-98、2026-11-03 の所有者の裁定）ので、ここで記法やタグを取り除くことはしない ――
// 利用者が打った `**` や `<` もそのまま探せる文字である。ここがするのは、照合の邪魔に
// なる空白の揺れと、目に見えない文字の除去だけである。
//
// 純粋: 文字列入力 → 文字列出力。DOM に触れない。
//
// 不可視ゼロ幅コードポイント (`\s` に一致しない U+200B 等) は検索 corpus/クエリに混入
// すると素テキストを汚すため、除去は domain の単一真実源 `stripInvisible` に委譲する
// (教訓 5.30: 文字集合を二重定義しない)。

import { stripInvisible } from '../../domain/text';

/**
 * Reduce a作業メモ (plain text) to a searchable string: invisible zero-width code
 * points are dropped FIRST (they are not `\s`, so `\s+` would otherwise let them
 * survive into the searchable text) via the domain's single invisible-char source
 * (教訓 5.30), then runs of whitespace collapse to single spaces and the ends are
 * trimmed. Every other character — including `*`, `<`, `[` — is kept as typed.
 *
 * This is one-directional: it produces a string for matching only, never for display.
 */
export function toSearchableText(raw: string): string {
  return stripInvisible(raw).replace(/\s+/g, ' ').trim();
}
