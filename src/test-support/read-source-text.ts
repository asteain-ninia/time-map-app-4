// テストが「実装のソースそのもの」を生テキストとして読むときの唯一の入口。
//
// **なぜ改行を揃えるのか**: この作業ツリーは git の `core.autocrlf=true` で、チェックアウトの
// 仕方によって同じファイルが CRLF になったり LF になったりする（実際に shell.css は LF、
// knife.css は CRLF で置かれている）。改行の違いは git の差分には現れないので、CSS の
// 複数行セレクタを文字列で探す契約テスト（`shell/shell-layout.test.ts` の
// `.option-bar__tool,\n.option-bar__target,…` など）が「規則が見つからない」で落ちると、
// 原因が実装の側にあるようにしか見えない。読み込む側で 1 回だけ改行を LF に揃え、
// テストの合否を改行の流儀から切り離す（同じ正規化を各テストに書き写さない）。

import { readFileSync } from 'node:fs';

/** ファイルを UTF-8 で読み、改行を LF に揃えて返す。 */
export function readSourceText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}
