// U14 — 「形が同じ時刻断面では幾何の検査を使い回す」ことの回帰テスト (B21)。
//
// checkConsistency は時刻断面ごとに重い幾何の検査 (末端の重なり・まとめ役と子の面・
// 環階層) を走らせる。名前を変えただけの錨でも断面は 1 本増えるので、実データでは
// これが読み込み時間をまるごと支配していた (実測 64 秒)。consistency.ts はスナップ
// ショットの「形」だけを写した鍵を作り、鍵が一致した断面では幾何の結果を使い回す。
//
// この速さは、見落としを作らないことと引き換えであってはならない。ここで固定するのは:
//   1. 形が変わった断面の不整合は、今までどおりその断面で検出される。
//   2. 属性だけ違う錨 (改名) を途中に挟んでも、その先で形が変わったら検出される。
//   3. 使い回した断面の報告に、古い時刻や古い名前が残らない。
//   4. 改名しても報告の中身 (時刻と名前を除く) は変わらない。
//
// 鍵を「常に同じ」に壊すと 1・2 は赤くなる (開発ガイド §5.49 の故意破壊で確認済み)。

import { describe, expect, it } from 'vitest';

import { INCONSISTENCY, checkConsistency, type DomainProject, type FeatureHistory } from './index';
import { CAL, DEFAULT_BASEMAP, DEFAULT_SETTINGS, squareLeaf } from './fixtures';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries } from '../anchor-series';
import { asAnchorId, asFeatureId } from '../ids';
import { timePointYear } from '../time/time-point';
import { createVertexStore } from '../vertex';
import type { Inconsistency } from './consistency';

/** 一つの錨で刻む状態: いつから・どんな四角 (名前と置き場所) か。 */
interface Step {
  readonly fromYear: number;
  readonly name: string;
  readonly ox: number;
  readonly oy: number;
}

/**
 * 一つの地物の履歴を、時代ごとの四角から組み立てる。四角の頂点 id と環 id は地物 id
 * から決まるので、置き場所が同じで名前だけ違う錨は「形がまったく同じ錨」になる。
 */
function squareHistory(featureId: string, steps: readonly Step[]): FeatureHistory {
  const entries = steps.map((step, i) => {
    const square = squareLeaf(featureId, step.name, step.ox, step.oy);
    const anchor = createAnchor(
      asAnchorId(`${featureId}-anc-${String(i)}`),
      createAnchorSnapshot([square.feature], createVertexStore(square.vertices)),
    );
    const next = steps[i + 1];
    return createAnchorEntry(
      anchor,
      timePointYear(step.fromYear),
      next === undefined ? null : timePointYear(next.fromYear),
    );
  });
  return { featureId: asFeatureId(featureId), series: normalizeSeries(entries, CAL) };
}

function project(histories: readonly FeatureHistory[]): DomainProject {
  return { histories, settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
}

/** ある年の断面で報告された、末端どうしの重なり。 */
function overlapsAtYear(inconsistencies: readonly Inconsistency[], year: number): Inconsistency[] {
  return inconsistencies.filter(
    (i) => i.kind === INCONSISTENCY.TerminalExclusion && i.atTime?.year === year,
  );
}

/** 地物 A は動かない。座標 (0,0) の一辺 10 の四角。 */
const STILL_A: Step = { fromYear: 0, name: 'A国', ox: 0, oy: 0 };
/** B が離れて建っている位置 (A と重ならない)。 */
const APART = { ox: 40, oy: 0 };
/** B が A に食い込む位置 (x が 5..10 で重なる)。 */
const ON_TOP = { ox: 5, oy: 0 };

describe('整合性チェック — 形が変わった断面の不整合は使い回しに埋もれない (B21)', () => {
  it('前の年は正常でも、頂点を動かして重なりを作った年ではその年の重なりが出る', () => {
    // 0 年: A(0,0) と B(40,0) は離れている。100 年: B が A に食い込む。
    const before = checkConsistency(
      project([
        squareHistory('leaf-a', [STILL_A]),
        squareHistory('leaf-b', [
          { fromYear: 0, name: 'B国', ...APART },
          { fromYear: 100, name: 'B国', ...ON_TOP },
        ]),
      ]),
      CAL,
    );

    expect(overlapsAtYear(before.inconsistencies, 0)).toHaveLength(0);
    const moved = overlapsAtYear(before.inconsistencies, 100);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.featureIds).toEqual(
      expect.arrayContaining([asFeatureId('leaf-a'), asFeatureId('leaf-b')]),
    );
    // 同じ重なりは (g) 異なる地物の同時刻状態の競合としても、100 年の断面だけに出る。
    const sameTime = before.inconsistencies.filter(
      (i) => i.kind === INCONSISTENCY.AnchorSpatialOverlap,
    );
    expect(sameTime).toHaveLength(1);
    expect(sameTime[0]?.atTime?.year).toBe(100);
  });

  it('名前だけ変えた錨を途中に挟んでも、その先で形が変わったら検出される', () => {
    // 0 年 離れている → 100 年 改名だけ (形は 0 年と同一 = 使い回しが効く断面) →
    // 200 年 A に食い込む。100 年の断面で結果を使い回しても 200 年は取りこぼさない。
    const report = checkConsistency(
      project([
        squareHistory('leaf-a', [STILL_A]),
        squareHistory('leaf-b', [
          { fromYear: 0, name: 'B国', ...APART },
          { fromYear: 100, name: 'B王国', ...APART },
          { fromYear: 200, name: 'B王国', ...ON_TOP },
        ]),
      ]),
      CAL,
    );

    expect(overlapsAtYear(report.inconsistencies, 0)).toHaveLength(0);
    expect(overlapsAtYear(report.inconsistencies, 100)).toHaveLength(0);
    const moved = overlapsAtYear(report.inconsistencies, 200);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.featureNames).toEqual(expect.arrayContaining(['A国', 'B王国']));
  });

  it('使い回した断面の報告には、その断面の時刻と今の名前が載る', () => {
    // 最初から重なったまま、100 年で改名だけする。100 年の断面は 0 年と形が同じなので
    // 幾何の結果を使い回すが、報告は 100 年・新しい名前で組み立て直されねばならない。
    const report = checkConsistency(
      project([
        squareHistory('leaf-a', [STILL_A]),
        squareHistory('leaf-b', [
          { fromYear: 0, name: 'B国', ...ON_TOP },
          { fromYear: 100, name: 'B王国', ...ON_TOP },
        ]),
      ]),
      CAL,
    );

    const at0 = overlapsAtYear(report.inconsistencies, 0);
    const at100 = overlapsAtYear(report.inconsistencies, 100);
    expect(at0).toHaveLength(1);
    expect(at100).toHaveLength(1);
    expect(at0[0]?.featureNames).toEqual(expect.arrayContaining(['A国', 'B国']));
    // 使い回した側に古い名前 (B国) や古い時刻 (0 年) が残っていないこと。
    expect(at100[0]?.featureNames).toEqual(expect.arrayContaining(['A国', 'B王国']));
    expect(at100[0]?.featureNames).not.toContain('B国');
    expect(at100[0]?.atTime?.year).toBe(100);
  });

  it('改名を挟んでも、報告の中身は時刻と名前のほかは変わらない', () => {
    // 同じ形の並びに、改名だけの錨を 3 つ足す。断面は 1 本から 4 本に増えるが、
    // 増えた断面はどれも同じ内容 (同じ種類・同じ地物・同じ detail) を返すはず。
    const single = checkConsistency(
      project([
        squareHistory('leaf-a', [STILL_A]),
        squareHistory('leaf-b', [{ fromYear: 0, name: 'B国', ...ON_TOP }]),
      ]),
      CAL,
    );
    const renamed = checkConsistency(
      project([
        squareHistory('leaf-a', [STILL_A]),
        squareHistory('leaf-b', [
          { fromYear: 0, name: 'B国', ...ON_TOP },
          { fromYear: 100, name: 'B王国', ...ON_TOP },
          { fromYear: 200, name: 'B帝国', ...ON_TOP },
          { fromYear: 300, name: 'B共和国', ...ON_TOP },
        ]),
      ]),
      CAL,
    );

    const shape = (i: Inconsistency) => ({ kind: i.kind, ids: [...i.featureIds], detail: i.detail });
    const perYear = (report: { inconsistencies: readonly Inconsistency[] }, year: number) =>
      report.inconsistencies.filter((i) => i.atTime?.year === year).map(shape);

    expect(perYear(single, 0)).not.toHaveLength(0);
    for (const year of [0, 100, 200, 300]) {
      expect(perYear(renamed, year)).toEqual(perYear(single, 0));
    }
  });
});
