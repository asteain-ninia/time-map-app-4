// UI layer (U35 / conflict): 重なりの 2 件を **地図と同じ色で** 見分ける色見本の色（増分 8E）。
//
// 設計書 §E.1 の V13 ③は「行に色見本と名前が出る」。名前が空の面どうしは呼び名が同じ
// 「名前のない面（1200年に作成）」になりうるので、**名前だけでは 2 件を見分けられない**。
// そこで地図の上で塗られている色（通常表示色）を行に添える。重なっている 2 件は隣どうし
// なので、自動配色なら必ず違う色になっている（四色の配色の規則）。
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
