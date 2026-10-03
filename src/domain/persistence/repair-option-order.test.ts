// 修復の選択肢の並び（U14「先頭が既定」）。修復ダイアログはどの行も最初の方法を選んだ
// 状態から始める（増分 8D）ので、選択肢が 2 つ以上ある行の先頭が「捨てる」方法だと、
// 何も触らずに［修復して開く］を押しただけで地物や歴史が消える。所有者の裁定
// 「削除以外でデータが勝手に消えるのは良くない」に合わせ、捨てる方法（`Drop*`）は
// 最後の手段として後ろに置く。ここでは不整合の種類と、選択肢を分ける細目の全部の
// 組み合わせを回して、その並びを固定する。
import { describe, expect, it } from 'vitest';
import { HIERARCHY_VIOLATION } from '../hierarchy/validate';
import { INCONSISTENCY, SHAPE_DETAIL_LEAF_WITH_CHILDREN, type Inconsistency } from './consistency';
import { REPAIR_OPTION, repairOptionsFor, type RepairOptionId } from './repair';

const DROP_IDS: ReadonlySet<RepairOptionId> = new Set(
  (Object.keys(REPAIR_OPTION) as (keyof typeof REPAIR_OPTION)[])
    .filter((key) => key.startsWith('Drop'))
    .map((key) => REPAIR_OPTION[key]),
);

const DETAILS: readonly (string | undefined)[] = [
  undefined,
  ...Object.values(HIERARCHY_VIOLATION),
  SHAPE_DETAIL_LEAF_WITH_CHILDREN,
];

function everyCase(): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const kind of Object.values(INCONSISTENCY)) {
    for (const detail of DETAILS) {
      out.push({
        kind,
        featureIds: [],
        featureNames: [],
        ...(detail === undefined ? {} : { detail }),
      });
    }
  }
  return out;
}

describe('修復の選択肢の並び', () => {
  it('捨てる方法の一覧は空でない（検査が空回りしない）', () => {
    expect(DROP_IDS.size).toBeGreaterThan(0);
  });

  it('選択肢が 2 つ以上ある行の先頭は、捨てる方法（Drop*）でない', () => {
    let multi = 0;
    for (const inc of everyCase()) {
      const options = repairOptionsFor(inc);
      if (options.length < 2) continue;
      multi += 1;
      expect(
        DROP_IDS.has(options[0]!.id),
        `${inc.kind} / ${inc.detail ?? '(細目なし)'} の先頭が ${options[0]!.id}`,
      ).toBe(false);
    }
    // 2 つ以上の行が 1 つも無いなら、この検査は何も見ていない。
    expect(multi).toBeGreaterThan(0);
  });
});
