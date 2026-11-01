// U31 deletion — the multi-anchor domain VIEW the delete operation acts on.
//
// FR-41 / 教訓 5.21 require deletion to sweep 全錨 (every history anchor / full
// time-axis state). The concrete root state shape is owned by U03 / later units;
// U31 must not reach into a private representation (技術方針 2.13, spec 依存). So
// this unit defines the minimal STRUCTURAL contract it needs — an ordered list of
// anchors, each a full feature set + the vertex store those features reference
// (exactly U03's {@link AnchorSnapshot}). A host state that holds anchors maps to
// this view; the delete functions are pure over it and return a new view.
//
// This is a layer/unit-crossing contract: fixed here as a shared type and
// exercised by both-side tests so callers and U31 agree by type, not by accident
// (教訓 5.33 / 5.34).

import type { Anchor, AnchorSnapshot } from '../anchor';

/**
 * 錨 1 枚が「その時刻の全系列の束」のどこに居るか（所有者の裁定 2026-09-07 の直し）。
 * `bundle` は {@link DeletionBundling.bundles} の番号、`[from, to)` はその束の地物列の
 * うち **この錨自身の地物**が並んでいる範囲（束はその時刻に効いている各系列の錨の地物を
 * 系列の順に連結したもの）。
 */
export interface DeletionBundleSlot {
  readonly bundle: number;
  readonly from: number;
  readonly to: number;
}

/**
 * 錨を「その時刻の全系列の束」に載せる情報（任意）。束は相異なる開始時刻ごとに 1 つ
 * だけ作り、同じ時刻に始まる錨は同じ束を共有する（束を錨ごとに作ると、実データ
 * 689 系列で数十秒かかった）。`slots[i]` が無い錨（その錨が自分の開始時刻に効いて
 * いない壊れた系列など）は、従来どおり錨 1 枚だけで掃除する。
 */
export interface DeletionBundling {
  /** 時刻ごとの束: その時刻に効いている全系列の錨の地物（系列順に連結）と頂点。 */
  readonly bundles: readonly AnchorSnapshot[];
  /** `anchors` と同じ並び。錨 i が載っている束と範囲。 */
  readonly slots: readonly (DeletionBundleSlot | undefined)[];
  /**
   * 錨 i の区間 [始まり, 実際の終わり) の **途中**にある全系列の境目の時刻ごとの束（増分 7 の
   * 手直し 2 回目 / 反証 #3・GPT #3）。集約地物の錨を連鎖剪定するのは、その錨の区間の
   * **どの時点でも**子が 1 件も居ないときだけにするための材料。必要になったときだけ組む
   * （その錨の集約地物が始まりの時刻で子を失ったときだけ呼ばれる）ので関数で持つ。
   */
  readonly interior?: (anchorIndex: number) => readonly AnchorSnapshot[];
}

/**
 * The deletion view: the ordered anchors (全錨) the operation sweeps. Each anchor
 * carries its own feature set and vertex store ({@link Anchor} / AnchorSnapshot).
 * Pure data; never mutated in place (Immer-style structural sharing on update).
 *
 * `bundling` があると、掃除と連鎖剪定の判定は錨 1 枚ではなく **その錨が始まる時刻の
 * 全系列の束**で行い、書き換えるのは錨自身の地物だけになる。子が自分の系列を持つ
 * 集約地物が、錨 1 枚だけを見ると「下位領域を全部失った」と読まれて消えていたのを
 * 直すため（所有者の裁定 2026-09-07「直す」）。系列の並びから組むのは `bundle.ts` の
 * `deletionStateFromHistories`。
 */
export interface DeletionState {
  readonly anchors: readonly Anchor[];
  readonly bundling?: DeletionBundling;
}

/** Build a deletion view from anchors (and, optionally, their time-slice bundling). */
export function createDeletionState(
  anchors: readonly Anchor[],
  bundling?: DeletionBundling,
): DeletionState {
  return bundling === undefined ? { anchors } : { anchors, bundling };
}
