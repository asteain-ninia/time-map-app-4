// UI layer (U35 / conflict): 重なりの 2 件を **地図と同じ色で** 見分ける色見本の色（増分 8E）。
//
// 設計書 §E.1 の V13 ③は「行に色見本と名前が出る」。名前が空の面どうしは呼び名が同じ
// 「名前のない面（1200年に作成）」になりうるので、**名前だけでは 2 件を見分けられない**。
// そこで地図の上で塗られている色（通常表示色）を行に添える。重なっている 2 件は、配色した
// ときに隣どうしだったなら自動配色で違う色になっている（四色の配色の規則）ので、**たいていは**
// 色で見分けられる。
//
// ただし **いつも違う色とは限らない**（増分 8E の手直し。設計適合 S2-4・GPT 重 2）:
//   - 離れていて同じ色だった 2 面を、頂点のドラッグで重ねたとき
//   - 手動配色で同じ色を選んでいたとき
//   - 追加の道具の確定前の面（色は既定色のまま。確定すると自動配色で別の色になる）
// そこで、2 つの色見本が同じか近いとき（{@link swatchesIndistinguishable}）は、行・ラジオ・
// 地図の下見の 3 か所に **番号札（①②）** を添えて見分ける（8B の「番号札」と同じ考え方）。
//
// 色は解決の対象にしている **試しの状態**（`trialState`）の、重なりの年の姿から読む
// （ミニマップと同じ状態を見る。教訓 5.29）。見つからなければ undefined（色見本を出さない）。

import type { Conflict, ConflictTime } from '../../domain/consistency/index';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { featuresAt } from '../live-lookup';

/** 重なりの時刻の代表（点ならその時刻、範囲なら始まり）。 */
function representativeTime(time: ConflictTime): TimePoint {
  return time.kind === 'point' ? time.at : time.from;
}

/** 重なりの片方の、地図での塗りの色（`#rrggbb`）。見つからなければ undefined。 */
export function participantFillColor(
  conflict: Conflict,
  featureId: FeatureId,
  trialState: DomainProject,
): string | undefined {
  const at = representativeTime(conflict.time);
  return featuresAt(trialState, at).find((f) => f.id === featureId)?.color.fillColor;
}

/** 重なりの 2 件に添える番号札（重なりの a が ①、b が ②）。 */
export const PARTICIPANT_TAGS = ['①', '②'] as const;

/**
 * 2 つの色見本が「近い」とみなす距離（RGB の各成分 0〜255 の直線距離）。
 * 48 は、同じ色相で明るさが 1 段ちがう程度（例 #2e7d32 と #388e3c は約 30）を「近い」に
 * 入れ、四色の配色が使う色どうし（色相が違う）は入れない幅として選んだ。
 */
export const SWATCH_NEAR_DISTANCE = 48;

function parseHex(color: string): readonly [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (m === null) return undefined;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * 2 つの色見本で 2 件を **見分けられない** か。どちらかの色が無い・読めない、同じ色、
 * または {@link SWATCH_NEAR_DISTANCE} より近い色なら true（番号札を添える）。
 */
export function swatchesIndistinguishable(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (a === undefined || b === undefined) return true;
  const pa = parseHex(a);
  const pb = parseHex(b);
  // 読めない書き方の色は比べられないので、見分けられないとみなす（安全側）。
  if (pa === undefined || pb === undefined) return true;
  const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
  return d < SWATCH_NEAR_DISTANCE;
}
