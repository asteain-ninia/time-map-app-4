// `Command.label` の語彙の混在を、出口 1 か所で解いていることを固定する
// （開発ガイド §5.51 / 現状.md B7 / 設計書 §H.5）。
//
// **実機に「元に戻せます: edit」と出た**のがこの検査の出発点である。型のコメントが
// 「人が読める名前」と言っていても、実際に埋まっている値は内部の英語だった。ここでは
// **実際に埋められている値を全部列挙して**、どれも日本語になることを見る。

import { describe, expect, it } from 'vitest';

import { AFFILIATION_COMMAND_LABEL } from '../../domain/affiliation/index';
import { DELETE_FEATURE_COMMAND_LABEL } from '../../domain/deletion/index';
import { MERGE_COMMAND_LABEL } from '../../domain/merge/index';
import { RECOLOR_COMMAND_LABEL } from '../../domain/coloring/index';

import { commandLabelJa, RESULT_STRINGS } from './command-result';

/**
 * `Command.label` に実際に入る値の **全件**（2026-09-04 時点で 9 か所）。
 * 内訳: UI 側 5 か所が内部の英語、ドメイン側 4 か所が日本語。
 */
const ALL_LABELS: readonly string[] = [
  // UI 側（内部の英語）
  'edit', // consistency-binding.ts 素性の変更
  'delete', // consistency-binding.ts 地物の削除
  'interval', // consistency-binding.ts 存続期間
  'palette', // coloring/palette-command.ts 既定配色
  'unshare', // live-unshare.ts 頂点の共有解除
  // ドメイン側（日本語）
  AFFILIATION_COMMAND_LABEL,
  DELETE_FEATURE_COMMAND_LABEL,
  RECOLOR_COMMAND_LABEL,
  MERGE_COMMAND_LABEL,
];

describe('commandLabelJa（内部の英語を画面に出さない, U-1 / 教訓 5.51）', () => {
  it('実際に埋められている 9 個の label はすべて日本語になる', () => {
    for (const label of ALL_LABELS) {
      const ja = commandLabelJa(label);
      // 英字が 1 文字でも残っていたら、それは内部の値が漏れている。
      expect(ja, `label=${label}`).not.toMatch(/[A-Za-z]/);
    }
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
