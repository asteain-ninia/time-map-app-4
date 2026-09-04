// Domain layer (U05 / geo): **1 辺で経度 180 度以上を渡る辺** の検出（N-51 / 技術方針 §6.8）。
//
// **なぜ 1 か所に置くのか**（増分 3 の手直し A5 / 反証 #4 / GPT #7）。保存形式は
// 「隣り合う頂点は最短方向で繋がっている」と仮定して経度を連続量へ戻すので、**1 辺で
// 180 度以上を渡る形は保存して読み直すと必ず別の形になる**。これは不具合ではなく保存形式の
// 恒久的な表現限界なので、**書く側で止める以外に手が無い**（技術方針 §6.8）。
//
// ところが増分 3 の時点で、この関門は **追加の道具にしか無かった**。編集で頂点を大きく
// 引きずる／ナイフで切る／結合する／穴をあける／リングを足す、のどれを通っても素通りする
// ので、「追加では断られる形が、編集では作れてしまう」という食い違いが残っていた。
// そこで述語をここへ移し、**追加も編集も同じ 1 本を呼ぶ**（教訓 5.29 単一真実源）。
//
// **入力は「連続経度」の列である。** [-180,180) へ畳んだ代表値の列に掛けてはいけない。
// 継ぎ目をまたぐ正しい形（179° → −179°）は代表値では 358° の差に見えるが、読み込み側が
// 最短方向で繋ぐので往復は正しく戻る ―― これを断ると、日付変更線をまたぐ地物が
// 1 つも編集できなくなる。断るべきなのは **利用者が意図した差が 180 度以上のとき**で、
// それが表れるのは「描いている枠／画面の枠に置き直した連続な列」である。
//
// 純粋（I/O・時計・乱数なし）。

import type { WorldCoordinate } from '../coordinate';
import type { GeoMultiPolygon } from '../geometry/types';

/**
 * 1 辺で許される経度差の上限（度）。技術方針 §6.8:「読み込み側は隣り合う頂点の経度差が
 * **180 度を超えたら** ±360 度ずらす」。ちょうど 180 度はどちら回りか決まらないので、
 * **180 度以上を「渡れない」とみなす**（境界を安全側に倒す）。
 */
export const MAX_EDGE_LON_SPAN_DEG = 180;

/**
 * 経度差が {@link MAX_EDGE_LON_SPAN_DEG} 以上の辺の、**始点の添字**を返す。
 *
 * `closed` が真（面のリング）のときは最後の頂点から先頭へ戻る「閉じる辺」も見る（その添字は
 * `coordinates.length - 1`）。線・点は開いた列として見る。
 *
 * 単一の真実源（教訓 5.29）: 追加の確定の関門も、作図中に辺を赤くする描画も、編集・ナイフ・
 * 結合・穴あけ・リング編集の確定の関門も、この 1 本を呼ぶ。「確定は止まるのに赤くならない」
 * ような食い違いが構造的に起きない。
 */
export function longEdgeStartIndexes(
  coordinates: readonly WorldCoordinate[],
  closed: boolean,
): readonly number[] {
  const out: number[] = [];
  const n = coordinates.length;
  if (n < 2) return out;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i += 1) {
    const a = coordinates[i]!;
    const b = coordinates[(i + 1) % n]!;
    if (Math.abs(b.lon - a.lon) >= MAX_EDGE_LON_SPAN_DEG) out.push(i);
  }
  return out;
}

/** その列に長すぎる辺が 1 本でもあるか（数を数えない呼び出し側のための薄い口）。 */
export function hasLongEdge(coordinates: readonly WorldCoordinate[], closed: boolean): boolean {
  return longEdgeStartIndexes(coordinates, closed).length > 0;
}

/**
 * 多角形の集まり（ブーリアン演算の出力など）の中で、長すぎる辺の **本数** を数える。
 * リングは必ず閉じているものとして数える（外周も穴も飛び地も同じ規則）。
 *
 * **渡す多角形は連続経度でなければならない**（`alignMultiPolygon` を通した後の値）。
 * ナイフ・結合・穴あけの出力は代表値へ畳む前がその形なので、確定の直前にそのまま渡せる。
 */
export function countLongEdgesInMultiPolygon(mp: GeoMultiPolygon): number {
  let count = 0;
  for (const polygon of mp) {
    for (const ring of polygon) {
      count += longEdgeStartIndexes(ring, true).length;
    }
  }
  return count;
}
