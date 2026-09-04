// Domain layer (U44 / 編集): 動かした頂点の **座標** を「次にその頂点が本当に動く記録」まで
// 前へ引き継ぐ（増分 3 の手直し A1。反証 #1 / GPT #1）。
//
// **なぜ要るのか。** 錨は「その時点の全体の写し」である。だから T より後ろにある錨は、
// T で動かしたはずの頂点の **古い座標** をそのまま持っている。頂点を 2 つの地物が共有して
// いるときにこれが表に出る:
//
// > 0 年で隣り合う 2 国の角（同じ頂点 id）を動かした。ところが片方の国は 1500 年にも錨を
// > 持っている。年を 1500 へ進めると、その錨が持つ **移動前の座標** が効いてしまい、
// > 一緒に動いたはずの国境がまた裂ける。
//
// 同じ `VertexId` が年によって別の場所を指すことになるので、保存し直したときの整合検査も
// 「同じ id なのに座標が違う」と言い出す。利用者から見れば「直したのに、年を進めると戻る」
// であり、増分 3 の中核（境界を共有して一緒に動く）が時間方向で成立していない。
//
// **規則**（所有者の裁定「保存は必ずいま見ている年に効く」から司令塔が導いた決定。
// 増分 2 の属性の引き継ぎ（{@link ../editing/carry-forward}）と同じ考え方であり、
// **所有者が覆せる**）:
//
// > T で頂点 V を「旧座標 → 新座標」に動かしたら、**同じ id を持つ全履歴**の T より後ろの
// > 錨を順に見て、V の座標が **旧座標と等しい間は新座標に書き換え**、**最初に異なる座標を
// > 持つ錨で止める**。止まる位置は頂点ごとに独立に決まる。
//
// つまり「意図しない巻き戻し」だけを消し、「本当に動かした記録」は 1 つも壊さない。
// 書き換えた錨が何本あっても **1 回の操作＝1 つの取り消し単位**である（この module は
// 系列を丸ごと作り替えて返すので、呼び出し側の 1 コマンドに収まる）。
//
// **T の時点に存在しない履歴も見る。** 隣の国が 1500 年から現れる場合、その履歴は 0 年では
// 「居ない」ので、いまの `applyMovedVerticesToHistories` は黙って読み飛ばしていた。だが
// 1500 年の錨は移動前の座標を持っているので、そこで境界が裂ける ―― 反証 #1 が捕まえたのは
// まさにこの経路である。だから走査は「T より後ろの錨を持つ全履歴」を対象にする。
//
// 純粋（I/O・時計・乱数なし）。時刻比較は U02 の `compare` 1 本を通す（教訓 5.16）。

import { createAnchorSnapshot } from '../anchor';
import { withEntrySnapshot, type AnchorEntry, type AnchorSeries } from '../anchor-series';
import { coordinatesEqual, type WorldCoordinate } from '../coordinate';
import type { VertexId } from '../ids';
import type { Calendar } from '../time/calendar';
import { compare } from '../time/normalized';
import type { TimePoint } from '../time/time-point';
import { createVertex, createVertexStore, getVertex, type Vertex } from '../vertex';

/**
 * 引き継ぎの材料 1 件: **移動前の座標**（旧値）と **移動後の頂点**（新値）。
 * 旧値は「T の直前で効いていた体」であり、これと等しい錨だけを書き換える。
 */
export interface MovedVertexCarry {
  readonly id: VertexId;
  readonly before: WorldCoordinate;
  readonly after: WorldCoordinate;
}

/**
 * 移動した頂点の一覧（提案が運ぶ新しい体）と、移動前の体の対応表から、引き継ぎの材料を作る。
 * **旧値が引けない頂点は材料にしない**（比較する相手が無いので、書き換えてよい根拠が無い）。
 * 座標が動いていない頂点も外す（属性だけの保存で系列を触らないのと同じ理由）。
 */
export function movedVertexCarries(
  movedVertices: readonly Vertex[],
  beforeBodies: ReadonlyMap<VertexId, WorldCoordinate>,
): readonly MovedVertexCarry[] {
  const out: MovedVertexCarry[] = [];
  for (const v of movedVertices) {
    const before = beforeBodies.get(v.id);
    if (before === undefined) continue;
    if (coordinatesEqual(before, v.coordinate)) continue;
    out.push({ id: v.id, before, after: v.coordinate });
  }
  return out;
}

/**
 * 引き継ぎの歩き方（{@link vertexCarryForwardTargets} と {@link applyVertexCarryForward}
 * が **同じ 1 つ**を使う、教訓 5.29）。`visit` には書き換える錨と、その錨で書き換える
 * 頂点の一覧を渡す。
 */
function walkVertexCarryForward(
  entries: readonly AnchorEntry[],
  baseTime: TimePoint,
  carries: readonly MovedVertexCarry[],
  calendar: Calendar,
  visit: (entry: AnchorEntry, applicable: readonly MovedVertexCarry[]) => void,
): void {
  if (carries.length === 0) return;
  const carrying = new Map<VertexId, MovedVertexCarry>(carries.map((c) => [c.id, c]));

  for (const entry of entries) {
    // 「T より後ろ」だけ。T ちょうどの錨は移動そのものが書いている。
    if (compare(entry.start, baseTime, calendar) <= 0) continue;
    const store = entry.anchor.snapshot.vertices;
    const applicable: MovedVertexCarry[] = [];
    for (const carry of [...carrying.values()]) {
      const held = getVertex(store, carry.id);
      if (held === undefined) {
        // この錨はもうその頂点を持っていない。**黙って飛ばさず、その頂点はここで打ち切る**
        // （飛ばすと、いったん参照が切れて再び現れた頂点の座標を勝手に書き換えてしまう）。
        carrying.delete(carry.id);
        continue;
      }
      if (coordinatesEqual(held.coordinate, carry.before)) {
        applicable.push(carry);
        continue;
      }
      // **ここでその頂点が本当に動いている。** 意図しない巻き戻しではなく記録された歴史
      // なので、この頂点の引き継ぎはここで終わり。
      carrying.delete(carry.id);
    }
    if (applicable.length > 0) visit(entry, applicable);
    if (carrying.size === 0) return;
  }
}

/**
 * その移動が **書き換える先の錨** を古い順に返す（画面が「どこまで効いたか」を言うための
 * 材料）。空なら「この移動はこの年より後ろに触らない」。
 */
export function vertexCarryForwardTargets(
  entries: readonly AnchorEntry[],
  baseTime: TimePoint,
  carries: readonly MovedVertexCarry[],
  calendar: Calendar,
): readonly AnchorEntry[] {
  const out: AnchorEntry[] = [];
  walkVertexCarryForward(entries, baseTime, carries, calendar, (entry) => {
    out.push(entry);
  });
  return out;
}

/**
 * 引き継ぎを実際に適用した系列を返す（入力は変えない）。書き換えが 1 本も無ければ
 * **入力をそのまま返す**（同一性を保つので、呼び出し側の memo が無駄に外れない）。
 *
 * 書き換えるのは **その錨の頂点表の体だけ**である。地物の並び・開始/終了・錨 ID は動かさない
 * （引き継ぎは「その錨が持つ写しの中の座標」だけを直す）。
 */
export function applyVertexCarryForward(
  series: AnchorSeries,
  baseTime: TimePoint,
  carries: readonly MovedVertexCarry[],
  calendar: Calendar,
): AnchorSeries {
  const rewrites = new Map<AnchorEntry, readonly MovedVertexCarry[]>();
  walkVertexCarryForward(series.entries, baseTime, carries, calendar, (entry, applicable) => {
    rewrites.set(entry, applicable);
  });
  if (rewrites.size === 0) return series;

  const entries = series.entries.map((entry) => {
    const applicable = rewrites.get(entry);
    if (applicable === undefined) return entry;
    const snapshot = entry.anchor.snapshot;
    const store = createVertexStore([
      ...snapshot.vertices.byId.values(),
      ...applicable.map((c) => createVertex(c.id, c.after)),
    ]);
    return withEntrySnapshot(entry, createAnchorSnapshot(snapshot.features, store));
  });
  return { entries };
}
