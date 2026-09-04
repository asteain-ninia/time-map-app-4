import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  COMPASS,
  DECIMAL_PLACES,
  INVALID_VALUE_TEXT,
  formatCoordinate,
  formatLatDecimal,
  formatLatDms,
  formatLonDecimal,
  formatLonDms,
  representativeLon,
  toDmsParts,
} from './coords-format';

describe('representativeLon (single source: U04 wrapLonDeg)', () => {
  it('folds out-of-range continuous longitudes into [-180, 180)', () => {
    expect(representativeLon(540)).toBeCloseTo(180 - 360, 9); // 540 -> -180
    expect(representativeLon(-540)).toBeCloseTo(-180, 9);
    expect(representativeLon(190)).toBeCloseTo(-170, 9);
    expect(representativeLon(0)).toBe(0);
  });

  it('+180 folds to -180 (boundary convention fixed once)', () => {
    expect(representativeLon(180)).toBe(-180);
    expect(representativeLon(-180)).toBe(-180);
  });
});

describe('formatLatDecimal / formatLonDecimal (FR-16 十進 + 方位)', () => {
  it('uses 北緯/南緯 and east/west words with fixed decimal places', () => {
    expect(formatLatDecimal(35.6894)).toBe(`${COMPASS.north} 35.689400°`);
    expect(formatLatDecimal(-35.6894)).toBe(`${COMPASS.south} 35.689400°`);
    expect(formatLonDecimal(139.75)).toBe(`${COMPASS.east} 139.750000°`);
    expect(formatLonDecimal(-139.75)).toBe(`${COMPASS.west} 139.750000°`);
  });

  it('treats exactly 0 as the positive hemisphere label (stable convention)', () => {
    expect(formatLatDecimal(0)).toBe(`${COMPASS.north} 0.000000°`);
    expect(formatLonDecimal(0)).toBe(`${COMPASS.east} 0.000000°`);
  });

  it('folds out-of-range longitude before display', () => {
    // +200° folds to -160° -> 西経 160.000000°
    expect(formatLonDecimal(200)).toBe(`${COMPASS.west} 160.000000°`);
  });

  it('returns a placeholder for non-finite input (FR-117)', () => {
    expect(formatLatDecimal(NaN)).toBe(INVALID_VALUE_TEXT);
    expect(formatLonDecimal(Infinity)).toBe(INVALID_VALUE_TEXT);
  });
});

describe('toDmsParts (分秒の繰り上がり / 丸め境界)', () => {
  it('decomposes a representative value', () => {
    const p = toDmsParts(35 + 41 / 60 + 21.84 / 3600);
    expect(p.degrees).toBe(35);
    expect(p.minutes).toBe(41);
    expect(p.seconds).toBeCloseTo(21.84, 2);
  });

  it('carries rounded seconds into minutes and minutes into degrees', () => {
    // 35.99999999° -> should round up to 36°0′0.00″, not 35°59′60.00″.
    const p = toDmsParts(35.999999999);
    expect(p.degrees).toBe(36);
    expect(p.minutes).toBe(0);
    expect(p.seconds).toBeCloseTo(0, 2);
  });

  it('keeps seconds strictly below 60 and minutes below 60', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 179.999999, noNaN: true }), (mag) => {
        const p = toDmsParts(mag);
        expect(p.seconds).toBeGreaterThanOrEqual(0);
        expect(p.seconds).toBeLessThan(60);
        expect(p.minutes).toBeGreaterThanOrEqual(0);
        expect(p.minutes).toBeLessThan(60);
        expect(Number.isInteger(p.degrees)).toBe(true);
      }),
    );
  });
});

describe('formatLatDms / formatLonDms (FR-16 度分秒 + 方位)', () => {
  it('formats with Japanese compass words', () => {
    expect(formatLatDms(35 + 41 / 60 + 21.84 / 3600)).toBe(`${COMPASS.north} 35°41′21.84″`);
    expect(formatLonDms(139 + 45 / 60)).toBe(`${COMPASS.east} 139°45′0.00″`);
    expect(formatLatDms(-(10 + 30 / 60))).toBe(`${COMPASS.south} 10°30′0.00″`);
  });

  it('returns a placeholder for non-finite input (FR-117)', () => {
    expect(formatLatDms(NaN)).toBe(INVALID_VALUE_TEXT);
    expect(formatLonDms(NaN)).toBe(INVALID_VALUE_TEXT);
  });
});

describe('日付変更線ちょうど（経度 ±180°）には東西を付けない', () => {
  // 実機の状態行に **「北緯 70.131028° 西経 180.000000°」** と出ていたのが出発点。
  // 経度 180 度は東半球と西半球の境そのもので、東西どちらの語を当てても嘘になる。
  // 折りたたみ（representativeLon）が +180 を -180 へ寄せるので、符号だけを見る書き方
  // では必ず「西」に倒れていた。
  it('180 / -180 は方位語なしの数値だけになる（十進）', () => {
    expect(formatLonDecimal(180)).toBe('180.000000°');
    expect(formatLonDecimal(-180)).toBe('180.000000°');
    // 無限スクロールで回り込んで届いた連続値（+360k）も、折りたたんだ先が境なら同じ。
    expect(formatLonDecimal(540)).toBe('180.000000°');
  });

  it('境のすぐ手前は、これまでどおり東西が付く（外すのは境だけ）', () => {
    expect(formatLonDecimal(179.999999)).toBe(`${COMPASS.east} 179.999999°`);
    expect(formatLonDecimal(-179.999999)).toBe(`${COMPASS.west} 179.999999°`);
  });

  it('0 度（本初子午線）は従来どおり東経のまま（既存の取り決めを変えない）', () => {
    expect(formatLonDecimal(0)).toBe(`${COMPASS.east} 0.000000°`);
    expect(formatLonDms(0)).toBe(`${COMPASS.east} 0°0′0.00″`);
  });

  it('度分秒の側も、画面に出る数字が 180° になるときは方位語を付けない', () => {
    expect(formatLonDms(180)).toBe('180°0′0.00″');
    expect(formatLonDms(-180)).toBe('180°0′0.00″');
    // **判定は「表示する桁へ丸めたあとの値」で行う。** 度分秒は秒を 2 桁で丸めるので、
    // 179.999999° は繰り上がって 180°0′0.00″ と表示される ―― 見えている数字が 180 なのに
    // 「東経」と書いてある状態を作らないため、ここも方位語なしになる。十進のほうは
    // 179.999999° と表示されるので東経が付く（**それぞれが自分の出す数字に対して正しい**）。
    expect(formatLonDms(179.999999)).toBe('180°0′0.00″');
    expect(formatLonDms(-179.999999)).toBe('180°0′0.00″');
    // 丸めても 180 に届かない値は、当然これまでどおり東西が付く。
    expect(formatLonDms(179.9999)).toBe(`${COMPASS.east} 179°59′59.64″`);
    expect(formatLonDms(-179.9999)).toBe(`${COMPASS.west} 179°59′59.64″`);
  });
});

describe('formatCoordinate (FR-16 度分秒 AND 十進 both)', () => {
  it('produces all four strings', () => {
    const d = formatCoordinate({ lon: 139.75, lat: 35.6894 });
    expect(d.latDecimal).toContain(COMPASS.north);
    expect(d.lonDecimal).toContain(COMPASS.east);
    expect(d.latDms).toContain('″');
    expect(d.lonDms).toContain('″');
  });
});

describe('DMS <-> decimal round-trip (誤差内, AC-4)', () => {
  it('decompose then recompose returns the original decimal magnitude', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 179.999, noNaN: true }), (mag) => {
        const p = toDmsParts(mag);
        const recomposed = p.degrees + p.minutes / 60 + p.seconds / 3600;
        // The DMS form rounds seconds to 2dp -> tolerance ~ 0.01″ = 1/360000°.
        expect(recomposed).toBeCloseTo(mag, 4);
      }),
    );
  });
});

describe('±360k longitude wrap-invariance of the representative form (AC-2)', () => {
  it('display is unchanged when the clicked longitude carries whole turns', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -179.5, max: 179.5, noNaN: true }),
        fc.integer({ min: -3, max: 3 }),
        (lon, k) => {
          expect(formatLonDecimal(lon + 360 * k)).toBe(formatLonDecimal(lon));
          expect(formatLonDms(lon + 360 * k)).toBe(formatLonDms(lon));
        },
      ),
    );
  });
});

it('DECIMAL_PLACES is the documented precision', () => {
  expect(DECIMAL_PLACES).toBe(6);
});
