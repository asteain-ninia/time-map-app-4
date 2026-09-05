// 「選択したものは必ず地図に見える」（増分 4 の中身 9 / 設計書 §D.6 / C10）。純粋。
//
// **これが直すもの**: 一覧から選ぶと **カメラは飛ぶのに地図には何も描かれない**
// （現状分析 C10 / 報告 11 §4）。深さ 0 の表示では、深さ 1 の州は親のまとめ役へ
// 畳まれる（FR-42）ので、選んでも自分の形は 1 本も描かれない。回避策は「階層深度を
// +1 する」だったが、実行すると選択の強調が消え、州 1 件を見るのに **8 手**かかった。
//
// **規則は 2 つ**（設計書 §D.6）:
//   1. 選択中の地物と、その親までの道筋は、表示条件に関わらず **必ず描く**
//   3. 必ず描く 1 件（と道筋）は、**本来の深さから導出した重ね順をそのまま保ったまま、
//      描画列の最後（＝いちばん上）にまとめて重ねる**（FR-113 の導出規則は変えない）
//
// **②「深さを自動で上げる」は採らなかった**（計画外の判断。理由は完了報告に書く）。
// 受け入れ条件が「**深さ 0 のままでも**地図にその州が描かれ、状態行に文が出る」なので、
// 深さそのものを動かすと条件と食い違う。深さを動かすと地図の全部の地物の見え方が
// 変わる（畳まれていた兄弟が一斉に開く）ので、1 件を見たいだけの操作の副作用として
// 大きすぎる、という判断でもある。**状態行の文はそのまま出す。**

import { walkToRoot, type Forest } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';

/**
 * 必ず描く集合 ＝ 選択中の地物と、根までの道筋。選んでいなければ空。
 *
 * 道筋を入れるのは、子だけを描くと **どの国の中にあるのか分からない**からである
 * （設計書 §D.6 の「親までの道筋」）。循環していても止まる（教訓 5.28）。
 */
export function alwaysDrawnIds(
  forest: Forest,
  selectedId: FeatureId | null,
): ReadonlySet<FeatureId> {
  if (selectedId === null) return EMPTY;
  // 面情報の森に居ないとき（点情報・線情報）は、自分 1 件だけを必ず描く集合にする。
  // 点と線は FR-42 の畳み込みを受けないので道筋は要らないが、重ね順を上げる規則
  // （下の {@link raiseAlwaysDrawn}）はそのまま効かせたい。
  if (!forest.byId.has(selectedId)) return new Set([selectedId]);
  const walk = walkToRoot(forest, selectedId);
  return new Set(walk.cyclic ? walk.cycle : walk.chain);
}

const EMPTY: ReadonlySet<FeatureId> = new Set();

/**
 * 描画列を組み直す: **必ず描く集合に入っているものだけを、順序を保ったまま末尾へ**
 * 移す（設計書 §D.6 の重ね順の 1 行決め）。
 *
 * **道筋の中どうしの前後関係は導出どおり**（元の並びのまま）で、道筋と他の地物の
 * 前後関係だけが「道筋が上」になる。こうすると FR-113 の導出規則そのものは変えずに
 * 済み、「選んだものが他の面に隠れて見えない」も同時に消える。
 *
 * **何も移すものが無ければ同じ配列をそのまま返す**（描画の memo を無駄に外さない）。
 */
export function raiseAlwaysDrawn<T extends { readonly id: string }>(
  drawn: readonly T[],
  alwaysDrawn: ReadonlySet<FeatureId>,
  idOf: (item: T) => FeatureId,
): readonly T[] {
  if (alwaysDrawn.size === 0) return drawn;
  const rest: T[] = [];
  const raised: T[] = [];
  for (const item of drawn) {
    if (alwaysDrawn.has(idOf(item))) raised.push(item);
    else rest.push(item);
  }
  if (raised.length === 0) return drawn;
  return [...rest, ...raised];
}

/**
 * 「必ず描く」が実際に働いたときの、状態行に出す文（設計書 §D.6 の規則 2 / §H.5）。
 *
 * 働いていない（その地物が普通に描かれている）ときは null。**黙って特別扱いしない**
 * のがここの要点で、旧版は「一覧から選ぶとカメラは飛ぶのに地図には何も描かれない」
 * が **何も言わずに** 起きていた（C10 / 報告 11 §4）。
 *
 * @param drawnIds いま描かれている地物の id（FR-42 の畳み込みを通したあとの集合）
 * @param depth その地物の導出された深さ（引けなければ null）
 */
export function describeForcedDraw(
  drawnIds: ReadonlySet<FeatureId>,
  featureId: FeatureId,
  depth: number | null,
  describe: (depth: number | null) => string,
): string | null {
  if (drawnIds.has(featureId)) return null;
  return describe(depth);
}
