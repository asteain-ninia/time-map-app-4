// UI layer (U16 / 地図): 縮尺バーの目盛りを選ぶ純粋ロジック（設計書 §B.5 の台帳 #11）。
//
// 状態行の「1:12,000,000」は **桁を読む**ための表示で、地図の上の縮尺バーは
// **距離を目で測る**ための表示である。同じ値から出すが役目が違うので、分母の定義は
// `shell/status-format.ts` の 1 本を共有し、ここは「何 km を何 px で描くか」だけを決める。
//
// 純粋（framework-free）なので node のテストで固定できる（教訓 5.41）。

/** 目盛りの梯子（1/2/5 × 10^n）。地図の縮尺バーの慣用。 */
const LADDER = [1, 2, 5];

/** バーの長さの目安（px）。この幅に収まる「きりのよい距離」を選ぶ。 */
export const SCALE_BAR_MIN_PX = 60;
export const SCALE_BAR_MAX_PX = 160;

/** 縮尺バー 1 本ぶんの決まり。 */
export interface ScaleBar {
  /** バーの長さ（px）。 */
  readonly pixels: number;
  /** そのバーが表す距離（m）。 */
  readonly metres: number;
  /** 画面に出す文字（「500 km」「200 m」）。 */
  readonly label: string;
}

/**
 * 赤道上の「1 度あたりの m」から縮尺バーを決める。`zoomPxPerDeg` は
 * `render/camera.ts` の定義（CSS ピクセル / 度）。読めない入力では null を返す
 * （数字を捏造しない ―― 呼び出し側はバーごと出さない）。
 */
export function chooseScaleBar(
  zoomPxPerDeg: number,
  equatorLengthKm: number,
): ScaleBar | null {
  if (!Number.isFinite(zoomPxPerDeg) || zoomPxPerDeg <= 0) return null;
  if (!Number.isFinite(equatorLengthKm) || equatorLengthKm <= 0) return null;
  const metresPerDegree = (equatorLengthKm * 1000) / 360;
  const metresPerPixel = metresPerDegree / zoomPxPerDeg;
  if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) return null;

  // 目安の幅に入る「きりのよい距離」を、下から順に探す。
  const roughMetres = metresPerPixel * SCALE_BAR_MAX_PX;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughMetres)));
  for (let m = magnitude * 10; m >= 1e-6; m /= 10) {
    for (let i = LADDER.length - 1; i >= 0; i -= 1) {
      const metres = (LADDER[i] as number) * m;
      const pixels = metres / metresPerPixel;
      if (pixels <= SCALE_BAR_MAX_PX && pixels >= SCALE_BAR_MIN_PX) {
        return { pixels, metres, label: formatDistance(metres) };
      }
    }
  }
  return null;
}

/** 距離の文字（1km 以上は km、それ未満は m）。3 桁区切りはロケールに依らせない。 */
export function formatDistance(metres: number): string {
  if (metres >= 1000) {
    const km = metres / 1000;
    return `${groupDigits(km)} km`;
  }
  return `${groupDigits(metres)} m`;
}

function groupDigits(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const [int, frac] = String(rounded).split('.');
  const grouped = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}
