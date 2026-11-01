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

  // **選択肢が 1 つだけの行も見る**（2026-10-04、B39 の戻しの再検証 / B91）。重なりの行は「一方を
  // 除外」1 つだけで、上の検査（2 つ以上の行だけ）をすり抜け、何も触らずに押すと描いた地物が
  // 消えていた。1 つだけの行は板がラジオを出さずにその方法を既定で選ぶので、先頭であることに
  // 変わりはない。
  //
  // ただし **記録を残したまま開くと画面や計算が壊れる種類**は、捨てる方法しか置けない。その
  // 種類だけをここに理由つきで名指しで外す（新しく足した種類が黙ってここに入らないように）。
  const DROP_ONLY_BY_NATURE: ReadonlyMap<string, string> = new Map([
    ['missing-vertex-reference', '引く頂点が無い地物は形が解けず、描けない'],
    ['ring-hierarchy-invalid', '輪の入れ子が壊れた形は面積・包含の計算が成り立たない'],
    ['aggregate-sum-mismatch', '捨てるのは集約地物だけで下位領域は最上位として残る（既存の振る舞い）'],
    ['duplicate-owner-history', '同じ地物の歴史が 2 本あると年ごとの姿が決まらない（先頭は残す）'],
  ]);

  it('選択肢が 1 つだけの行も、その方法は捨てる方法でない（形が壊れる種類だけを名指しで除く）', () => {
    let single = 0;
    for (const inc of everyCase()) {
      const options = repairOptionsFor(inc);
      if (options.length !== 1) continue;
      single += 1;
      const key = `${inc.kind}/${inc.detail ?? '(細目なし)'}`;
      // 形状保持規則の違反のうち子を持つ末端以外（形の無い末端など）も形が解けないので捨てるだけ。
      const byNature =
        DROP_ONLY_BY_NATURE.has(inc.kind) ||
        (inc.kind === INCONSISTENCY.ShapePreservation && inc.detail !== SHAPE_DETAIL_LEAF_WITH_CHILDREN);
      if (byNature) continue;
      expect(DROP_IDS.has(options[0]!.id), `${key} の唯一の方法が ${options[0]!.id}`).toBe(false);
    }
    expect(single).toBeGreaterThan(0);
  });

  it('重なりの行は「そのまま残す」が先頭（既定）で、除外は最後', () => {
    for (const kind of [INCONSISTENCY.TerminalExclusion, INCONSISTENCY.AnchorSpatialOverlap]) {
      const ids = repairOptionsFor({ kind, featureIds: [], featureNames: [] }).map((o) => o.id);
      expect(ids).toEqual([REPAIR_OPTION.KeepOverlap, REPAIR_OPTION.DropOverlappingFeature]);
    }
  });
});
