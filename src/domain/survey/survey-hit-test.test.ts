// 測量の線の当たり判定（増分 8C の中身 2・3・4 / 設計書 §E.1 V15）。
//
// 固定すること:
//   - 正距円筒の線（まっすぐ）と大円の線（曲線）の **どちらに当たっても同じ id**。
//   - 判定は画面上 8px（`pxPerDegree` で度に直す）。境目の内外。
//   - 交差点では 2 件とも返る（1 つに絞らない）。近い順・同じ近さなら古い順。
//   - **世界の東西端をまたぐ線**: 179°→181° に描かれる線を、地図の左端に見えている
//     複製（−181°〜−179°）の上で押しても当たる。
//   - カメラがまだ測られていない（zoom 0）・線が無いときは空。

import { describe, expect, it } from 'vitest';

import { equirectangularPath, greatCirclePath } from './great-circle-path';
import { SURVEY_LINE_HIT_TOLERANCE_PX, surveyLinesAt } from './survey-hit-test';
import type { SurveyLine } from './survey-state';

const line = (id: number, a: [number, number], b: [number, number]): SurveyLine => ({
  id,
  start: { lon: a[0], lat: a[1] },
  end: { lon: b[0], lat: b[1] },
});

/** 1 度 = 4px（全体表示に近い倍率）。8px = 2 度。 */
const ZOOM = 4;

describe('surveyLinesAt — 2 本の曲線の当たり判定', () => {
  // 高緯度の長い線: 大円の線は極の側へ大きく膨らむので、2 本がはっきり離れる。
  const long = line(1, [-60, 50], [60, 50]);

  it('まっすぐな線（正距円筒）の中ほどを押すと、その測量に当たる', () => {
    const hits = surveyLinesAt([long], { lon: 0, lat: 50 }, ZOOM);
    expect(hits.map((h) => h.lineId)).toEqual([1]);
  });

  it('曲線（大円）の中ほどを押しても、同じ測量に当たる（消えるのは 2 本セット）', () => {
    const gc = greatCirclePath(long.start, long.end);
    const mid = gc[Math.floor(gc.length / 2)]!;
    // 大円の線の中ほどは、まっすぐな線から 8px より十分に離れている（2 本を別々に押せる）。
    expect(Math.abs(mid.lat - 50) * ZOOM).toBeGreaterThan(SURVEY_LINE_HIT_TOLERANCE_PX * 3);
    const hits = surveyLinesAt([long], mid, ZOOM);
    expect(hits.map((h) => h.lineId)).toEqual([1]);
  });

  it('2 本に同時に当たっても 1 件として数える', () => {
    // 端点の近くでは 2 本が重なっている。
    const hits = surveyLinesAt([long], { lon: -60, lat: 50 }, ZOOM);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distancePx).toBeCloseTo(0, 6);
  });

  it('境目: 8px ちょうどは当たり、それより外は当たらない', () => {
    const flat = line(7, [0, 0], [20, 0]);
    // 赤道沿いの線は 2 本とも緯度 0 の上にある。
    expect(surveyLinesAt([flat], { lon: 10, lat: 2 }, ZOOM)).toHaveLength(1); // 2° × 4 = 8px
    expect(surveyLinesAt([flat], { lon: 10, lat: 2.01 }, ZOOM)).toHaveLength(0);
    // 倍率を上げると同じ世界の距離は画面で遠くなる（判定は画面の 8px で行う）。
    expect(surveyLinesAt([flat], { lon: 10, lat: 2 }, ZOOM * 2)).toHaveLength(0);
  });

  it('線分の延長上（端点の外）は端点までの距離で測る', () => {
    const flat = line(7, [0, 0], [20, 0]);
    expect(surveyLinesAt([flat], { lon: 21.9, lat: 0 }, ZOOM)).toHaveLength(1);
    expect(surveyLinesAt([flat], { lon: 22.1, lat: 0 }, ZOOM)).toHaveLength(0);
  });

  it('どれにも当たらなければ空配列', () => {
    expect(surveyLinesAt([long], { lon: 0, lat: -30 }, ZOOM)).toEqual([]);
  });
});

describe('surveyLinesAt — 候補が複数（交差・重なり）', () => {
  it('交差点を押すと 2 つの測量がどちらも返る（1 つに勝手に決めない）', () => {
    const a = line(1, [-10, -10], [10, 10]);
    const b = line(2, [-10, 10], [10, -10]);
    const hits = surveyLinesAt([a, b], { lon: 0, lat: 0 }, ZOOM);
    expect(hits.map((h) => h.lineId).sort()).toEqual([1, 2]);
  });

  it('近い順に並ぶ。同じ近さなら古い（id の小さい）ほうが先', () => {
    const far = line(1, [-10, 1], [10, 1]);
    const near = line(2, [-10, 0.25], [10, 0.25]);
    const hits = surveyLinesAt([far, near], { lon: 0, lat: 0 }, ZOOM);
    expect(hits.map((h) => h.lineId)).toEqual([2, 1]);

    const same1 = line(5, [-10, 0], [10, 0]);
    const same2 = line(3, [-10, 0], [10, 0]);
    expect(surveyLinesAt([same1, same2], { lon: 0, lat: 0 }, ZOOM).map((h) => h.lineId)).toEqual([
      3, 5,
    ]);
  });
});

describe('surveyLinesAt — 世界の東西端をまたぐ線（増分 8C の中身 4）', () => {
  // +179° から −179° へ測った線。経度は連続値なので 179°〜181° に描かれる。
  const seam = line(4, [179, 0], [-179, 0]);

  it('描かれている経度（180°）の上で押すと当たる', () => {
    expect(equirectangularPath(seam.start, seam.end).map((p) => p.lon)).toEqual([179, 181]);
    expect(surveyLinesAt([seam], { lon: 180, lat: 0 }, ZOOM).map((h) => h.lineId)).toEqual([4]);
  });

  it('地図の左端に見えている複製（−180° 付近）の上で押しても当たる', () => {
    expect(surveyLinesAt([seam], { lon: -179.5, lat: 0 }, ZOOM).map((h) => h.lineId)).toEqual([
      4,
    ]);
    expect(surveyLinesAt([seam], { lon: -180.5, lat: 0 }, ZOOM).map((h) => h.lineId)).toEqual([
      4,
    ]);
  });

  it('何周ぶん離れた複製の上で押しても当たる（パンし続けたカメラ）', () => {
    expect(surveyLinesAt([seam], { lon: 180 + 720, lat: 0 }, ZOOM)).toHaveLength(1);
    expect(surveyLinesAt([seam], { lon: 180 - 1080, lat: 0 }, ZOOM)).toHaveLength(1);
  });

  it('遠回り（−179° から +179° へ西回り）にはつながっていない', () => {
    // 経度 0 は、この線の 358° の遠回りの途中にあたる。そこは当たらない。
    expect(surveyLinesAt([seam], { lon: 0, lat: 0 }, ZOOM)).toEqual([]);
  });

  it('端をまたぐ大円の曲線の中ほども、左端の複製の上で当たる', () => {
    const highSeam = line(9, [170, 60], [-170, 60]);
    const gc = greatCirclePath(highSeam.start, highSeam.end);
    const mid = gc[Math.floor(gc.length / 2)]!;
    expect(mid.lon).toBeGreaterThan(179); // 連続値で 180° 付近に描かれている
    expect(surveyLinesAt([highSeam], { lon: mid.lon - 360, lat: mid.lat }, ZOOM)).toHaveLength(1);
  });
});

describe('surveyLinesAt — 測れない局面', () => {
  const l = line(1, [0, 0], [10, 0]);

  it('線が無ければ空', () => {
    expect(surveyLinesAt([], { lon: 0, lat: 0 }, ZOOM)).toEqual([]);
  });

  it('カメラがまだ測られていない（zoom 0 / 非有限）ときは空', () => {
    expect(surveyLinesAt([l], { lon: 5, lat: 0 }, 0)).toEqual([]);
    expect(surveyLinesAt([l], { lon: 5, lat: 0 }, Number.NaN)).toEqual([]);
    expect(surveyLinesAt([l], { lon: 5, lat: 0 }, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('押した点が有限でなければ空', () => {
    expect(surveyLinesAt([l], { lon: Number.NaN, lat: 0 }, ZOOM)).toEqual([]);
  });

  it('始点と終点が同じ線（長さ 0）は、その点の周り 8px で当たる', () => {
    const dot = line(2, [5, 5], [5, 5]);
    expect(surveyLinesAt([dot], { lon: 5, lat: 6.5 }, ZOOM)).toHaveLength(1);
    expect(surveyLinesAt([dot], { lon: 5, lat: 7.5 }, ZOOM)).toHaveLength(0);
  });
});

// 増分 8C の手直し（GPT #3）: 旧版は許容値で広げた範囲の複製を数え、数が 4 を超えると
// 「病的入力」として捨てていた。倍率がごく小さいと許容値が何千度にもなり、**線の真上を
// 押しても当たらなかった**。数える複製は線の経度の幅だけで決める。
describe('surveyLinesAt — ごく小さい倍率（許容値が何周ぶんにもなる）', () => {
  const l = line(1, [0, 0], [20, 0]);

  it('倍率 0.001（許容値 8000 度）でも、線の真上（距離 0）を押せば当たる', () => {
    const hits = surveyLinesAt([l], { lon: 10, lat: 0 }, 0.001);
    expect(hits.map((h) => h.lineId)).toEqual([1]);
    expect(hits[0]!.distancePx).toBe(0);
  });

  it('何周ぶん離れた複製の上でも、距離は最も近い複製で測る', () => {
    const hits = surveyLinesAt([l], { lon: 10 + 360 * 7, lat: 0 }, 0.001);
    expect(hits[0]!.distancePx).toBe(0);
  });

  it('線の範囲の外の点は、両外側のいちばん近い複製までの距離で測る', () => {
    // 経度 200 は、線（0〜20）の東端から 180 度、1 周先の複製（360〜380）の西端から 160 度。
    // 近いのは 1 周先の複製のほう（押した点を −360 ずらした −160 から見て線の西端 0 まで 160）。
    const hits = surveyLinesAt([l], { lon: 200, lat: 0 }, 1, 161);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distancePx).toBeCloseTo(160, 6);
  });
});
