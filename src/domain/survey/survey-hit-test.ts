// 測量の線の当たり判定（増分 8C の中身 2・4 / 設計書 §E.1 の V15）。
//
// 1 回の測量は **正距円筒の線（まっすぐ）と大円の線（曲線）の 2 本**を描く。右クリックで
// 線を消すとき、利用者はどちらを押すか分からないので、**どちらに当たっても同じ測量の id を
// 返す**（消えるのは 2 本セット）。判定は「押した点から線分までの画面上の距離 ≤ 8px」。
//
// **描いたものと当たるものを同じにする**（教訓 5.29）: 線の形は描画（`ui/survey/survey-batch`）と
// 同じ `greatCirclePath` / `equirectangularPath` から作る。別の近似を持つと、見えている線を
// 押しても当たらない場所ができる。
//
// **画面の px を世界の度に直すのに描画層を引かない**: 正距円筒の画面変換
// （`render/vtransform.worldToScreen`）は経度・緯度とも 1 度 = `zoom` px の等方な一次変換なので、
// 画面上の距離 = 度での距離 × zoom がそのまま成り立つ。だからこの関数は「1 度が何 px か」
// （＝カメラの zoom）だけを受け取り、許容値を度に直して世界座標の上で測る。純粋なドメインの
// まま、画面の 8px と同じ判定になる。
//
// **世界の東西端**（増分 8C の中身 4）: 線の経度は連続値で持っている（+179° から −179° へ
// 測った線は 179°〜181° に描かれる）。描画は ±360° の複製を並べるので、地図の左端に見えて
// いるのは −181°〜−179° の複製である。押した点の経度に 360° の整数倍を足し引きして、線の
// 経度の範囲に重なる複製ごとに測る。

import type { WorldCoordinate } from '../coordinate';

import { equirectangularPath, greatCirclePath } from './great-circle-path';
import type { SurveyLine } from './survey-state';

/** 線に当たったとみなす、押した点から線分までの画面上の距離の上限（px）。設計書 §E.1 V15。 */
export const SURVEY_LINE_HIT_TOLERANCE_PX = 8;

/** 経度 1 周（度）。複製の間隔。 */
const LONGITUDE_PERIOD_DEG = 360;

/** 1 本の測量線に当たったときの記録（近い順に並べるために距離も持つ）。 */
export interface SurveyLineHit {
  /** 当たった測量の id（2 本のどちらに当たっても同じ）。 */
  readonly lineId: number;
  /** 押した点から、その測量の 2 本の線のうち近いほうまでの距離（画面 px）。 */
  readonly distancePx: number;
}

/**
 * 押した点 `point`（連続値の経度）に当たる測量の線を **近い順**に返す（どれにも当たらなければ
 * 空配列 ―― 教訓 5.18: 空は「当たらなかった」という正しい値）。
 *
 * - 1 つの測量は 2 本の線のどちらに当たっても 1 件として数える（近いほうの距離で並べる）。
 * - 近さが同じなら古い（id の小さい）ほうを先にする（並びが毎回同じになるように）。
 * - **どれか 1 つに絞らない**。交差や重なりで 2 件以上返ったら、呼び出し側（右クリックの
 *   メニュー）がすべてを並べる（設計書 §E.1 V15 の 3「勝手に決めない」）。
 * - `pxPerDegree`（カメラの zoom）が 0 以下・有限でないときは空配列（地図がまだ測られて
 *   いない局面。距離が定義できないので「当たらない」に倒す）。
 */
export function surveyLinesAt(
  lines: readonly SurveyLine[],
  point: WorldCoordinate,
  pxPerDegree: number,
  tolerancePx: number = SURVEY_LINE_HIT_TOLERANCE_PX,
): SurveyLineHit[] {
  if (
    lines.length === 0 ||
    !Number.isFinite(pxPerDegree) ||
    pxPerDegree <= 0 ||
    !Number.isFinite(tolerancePx) ||
    tolerancePx < 0 ||
    !Number.isFinite(point.lon) ||
    !Number.isFinite(point.lat)
  ) {
    return [];
  }
  const toleranceDeg = tolerancePx / pxPerDegree;
  const hits: SurveyLineHit[] = [];
  for (const line of lines) {
    const distDeg = Math.min(
      distanceToPolylineDeg(point, equirectangularPath(line.start, line.end)),
      distanceToPolylineDeg(point, greatCirclePath(line.start, line.end)),
    );
    if (distDeg <= toleranceDeg) {
      hits.push({ lineId: line.id, distancePx: distDeg * pxPerDegree });
    }
  }
  hits.sort((a, b) => a.distancePx - b.distancePx || a.lineId - b.lineId);
  return hits;
}

/**
 * 線の経度の幅で数えた複製の数の上限（病的入力の見張り）。ふつうの線は 1 周（360°）に
 * 収まり、数えるのは 3〜4 個。地図を何周もパンして測った線でもこの数には届かない。
 */
const MAX_REPLICAS = 64;

/**
 * 押した点から折れ線までの最短距離（度）。押した点の経度を 360° ずつずらした複製のうち、
 * **最短になりうるものだけ** を測る ―― 折れ線の経度の範囲に入る複製と、その両外側で
 * いちばん近い 1 個ずつである（増分 8C の手直し / GPT #3）。
 *
 * 範囲の外の複製は、外へ離れるほど折れ線のどの点からも経度の差が大きくなる（緯度の差は
 * 変わらない）ので、両外側のいちばん近い 1 個より近くなることは無い。旧版は許容値で範囲を
 * 広げて複製を数えていたので、倍率がごく小さい（許容値が何千度にもなる）と数が上限を超え、
 * **線の真上を押しても当たらなかった**。数えるのは線の経度の幅だけで決まり、許容値に依らない。
 */
function distanceToPolylineDeg(point: WorldCoordinate, path: readonly WorldCoordinate[]): number {
  if (path.length === 0) return Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of path) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(maxLon)) return Infinity;
  // point.lon + 360k ∈ [minLon, maxLon] を満たす整数 k の範囲を、両外側へ 1 個ずつ広げる。
  const kMin = Math.ceil((minLon - point.lon) / LONGITUDE_PERIOD_DEG) - 1;
  const kMax = Math.floor((maxLon - point.lon) / LONGITUDE_PERIOD_DEG) + 1;
  // 巨大な経度で整数の精度が尽きた（病的入力）ときは測らない。
  if (!Number.isSafeInteger(kMin) || !Number.isSafeInteger(kMax) || kMax - kMin > MAX_REPLICAS) {
    return Infinity;
  }
  let best = Infinity;
  for (let k = kMin; k <= kMax; k += 1) {
    const px = point.lon + k * LONGITUDE_PERIOD_DEG;
    const py = point.lat;
    if (path.length === 1) {
      const only = path[0]!;
      best = Math.min(best, Math.hypot(px - only.lon, py - only.lat));
      continue;
    }
    for (let i = 0; i + 1 < path.length; i += 1) {
      const a = path[i]!;
      const b = path[i + 1]!;
      best = Math.min(best, distanceToSegment(px, py, a.lon, a.lat, b.lon, b.lat));
    }
  }
  return best;
}

/** 点 (px, py) から線分 (ax, ay)–(bx, by) までの距離（同じ単位）。 */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
