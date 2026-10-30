// `Command.label` の語彙の混在を、出口 1 か所で解いていることを固定する
// （開発ガイド §5.51 / 現状.md B7 / 設計書 §H.5）。
//
// **実機に「元に戻せます: edit」と出た**のがこの検査の出発点である。型のコメントが
// 「人が読める名前」と言っていても、実際に埋まっている値は内部の英語だった。
//
// **手書きの一覧では守れない。** 初版はここに 9 個の label を配列で直書きしていたが、
// それでは「新しい確定経路が増えて写像表から漏れた」ことを検出できない（一覧のほうを
// 直し忘れるだけで緑のまま）。そこで **ソースの label 定数を走査する**:
//   - UI 側 … `UI_COMMAND_LABEL` の全件（この定数が唯一の定義箇所で、確定経路は
//     ここから取る。直書きが復活していないことは下の「ソース走査」で見る）
//   - ドメイン側 … 各コマンド module が公開している定数の全件
// どちらも「値の集合」をそのまま流し込むので、片方が増えたらこの検査が自動で広がる。

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AFFILIATION_COMMAND_LABEL } from '../../domain/affiliation/index';
import { DELETE_FEATURE_COMMAND_LABEL } from '../../domain/deletion/index';
import { MERGE_COMMAND_LABEL } from '../../domain/merge/index';
import { RECOLOR_COMMAND_LABEL } from '../../domain/coloring/index';

import { readSourceText } from '../../test-support/read-source-text';
import { commandLabelJa, RESULT_STRINGS, UI_COMMAND_LABEL } from './command-result';

/** ドメイン側が `Command.label` に入れている日本語の定数（全件）。 */
const DOMAIN_LABELS: readonly string[] = [
  AFFILIATION_COMMAND_LABEL,
  DELETE_FEATURE_COMMAND_LABEL,
  RECOLOR_COMMAND_LABEL,
  MERGE_COMMAND_LABEL,
];

/** 実際に `Command.label` に入りうる値の全件（UI 側 ∪ ドメイン側）。 */
const ALL_LABELS: readonly string[] = [...Object.values(UI_COMMAND_LABEL), ...DOMAIN_LABELS];

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, '..');

/** `src/ui` 配下の実装ファイル（テストを除く）を全部列挙する。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

describe('commandLabelJa（内部の英語を画面に出さない, U-1 / 教訓 5.51）', () => {
  it('実際に埋められている label は UI 側もドメイン側も全件が日本語になる', () => {
    expect(ALL_LABELS.length).toBeGreaterThan(0);
    for (const label of ALL_LABELS) {
      const ja = commandLabelJa(label);
      // 英字が 1 文字でも残っていたら、それは内部の値が漏れている。
      expect(ja, `label=${label}`).not.toMatch(/[A-Za-z]/);
      // 「編集」へ落ちていたら、写像表にその label が載っていない（漏れ）。
      expect(ja, `label=${label} が写像表に無い（既定の「編集」へ落ちた）`).not.toBe('編集');
    }
  });

  it('確定経路ごとに違う日本語になる（全部が「素性の変更」にならない）', () => {
    // **これが今回の欠陥そのもの**: 追加・分割・穴あけ・結合・所属変更・素性の変更が
    // 共通の makeCommand を通って揃って 'edit' を入れていたので、面を 1 つ追加しても
    // 状態行に「素性の変更を行いました」と出ていた。
    const perPath = [
      UI_COMMAND_LABEL.Edit,
      UI_COMMAND_LABEL.Add,
      UI_COMMAND_LABEL.Split,
      UI_COMMAND_LABEL.Drill,
      UI_COMMAND_LABEL.Merge,
      UI_COMMAND_LABEL.Affiliation,
    ].map((l) => commandLabelJa(l));
    expect(new Set(perPath).size).toBe(perPath.length);
    expect(commandLabelJa(UI_COMMAND_LABEL.Add)).toBe('地物の追加');
    expect(commandLabelJa(UI_COMMAND_LABEL.Split)).toBe('分割');
  });

  it('ドメイン側の日本語 4 件はそのまま通る', () => {
    expect(commandLabelJa(AFFILIATION_COMMAND_LABEL)).toBe('所属変更');
    expect(commandLabelJa(DELETE_FEATURE_COMMAND_LABEL)).toBe('地物の削除');
    expect(commandLabelJa(RECOLOR_COMMAND_LABEL)).toBe('自動配色');
    expect(commandLabelJa(MERGE_COMMAND_LABEL)).toBe('結合');
  });

  it('表に無い label は「編集」へ落ちる（内部の値を出すくらいなら粗い日本語）', () => {
    expect(commandLabelJa('brand-new-internal-id')).toBe('編集');
    expect(commandLabelJa(null)).toBe('編集');
    expect(commandLabelJa(undefined)).toBe('編集');
  });
});

describe('label の直書きが復活していない（ソース走査）', () => {
  it('src/ui の実装に、内部の英語を直書きしたコマンドの label が 1 つも無い', () => {
    // 直書きすると `UI_COMMAND_LABEL` に載らず、写像表からも漏れて画面には
    // 「編集」としか出なくなる（しかも誰も気づかない）。定数経由だけを許す。
    //
    // 狙うのは **ASCII だけでできた空でない文字列** である。`Command.label` に混ざって
    // いた内部の値（'edit' / 'add' / 'palette' …）はすべてこの形をしている。画面へ出す
    // ための日本語ラベル（`label: 'グリッド'`）や、描画プリミティブの空ラベル
    // （`label: ''`）は別物なので対象外 —— 「内部の識別子が紛れ込んだか」だけを見る。
    const offenders: string[] = [];
    for (const file of sourceFiles(uiRoot)) {
      const text = readSourceText(file);
      for (const [index, line] of text.split('\n').entries()) {
        const isLabelProp = /(^|[^A-Za-z_.])label:\s*'[ -~]+'/.test(line);
        // `createCompositeCommand('edit', […])` の **第 1 引数も label** である。
        // 最初はここを見ておらず、`makeCommand` の中で作る合成コマンドが 'edit' を
        // 直書きしたままだったので、経路ごとに分けたつもりが実機では全部「素性の変更」の
        // ままだった（実アプリで確認）。名前付きの属性だけを見ると取り逃がす。
        const isCompositeArg = /createCompositeCommand\(\s*'[ -~]+'/.test(line);
        if (!isLabelProp && !isCompositeArg) continue;
        offenders.push(`${file.slice(uiRoot.length + 1)}:${index + 1}  ${line.trim()}`);
      }
    }
    expect(offenders, `内部の英語を直書きした label:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('RESULT_STRINGS（何をしたかを過去形で言い切る）', () => {
  it('対象の名前が分かるときは添え、分からなければ操作名だけ', () => {
    expect(RESULT_STRINGS.done('所属変更', '南ケナ州')).toBe('南ケナ州: 所属変更を行いました');
    expect(RESULT_STRINGS.done('所属変更', null)).toBe('所属変更を行いました');
    expect(RESULT_STRINGS.done('所属変更', '')).toBe('所属変更を行いました');
  });

  it('取り消し・やり直しは操作名を出す', () => {
    expect(RESULT_STRINGS.undone('素性の変更')).toBe('元に戻しました: 素性の変更');
    expect(RESULT_STRINGS.redone('素性の変更')).toBe('やり直しました: 素性の変更');
  });

  it('削除だけは「何を消したか」を必ず名指しする', () => {
    expect(RESULT_STRINGS.deleted('南ケナ州')).toBe('南ケナ州を削除しました');
    expect(RESULT_STRINGS.deleted(null)).toBe('削除しました');
  });
});
