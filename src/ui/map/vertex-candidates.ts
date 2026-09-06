// UI layer (U16 / 地図): 頂点の候補一覧の状態（設計書 §B.5 の台帳 #12 / V9）。
//
// **なぜ要るか**（§F.3 の実測）: 実データでは隣の頂点までの画面上の距離の中央値が
// **世界全体表示で 0.40〜0.44px**、×4 で 1.6〜1.75px、×16 で 6.4〜7.0px しかない。
// 掴める距離は 8px なので、拡大しない限り **必ず隣も入る** ―― いちばん近い 1 つを
// 黙って掴む形だと「どれを掴んだのか分からないまま形が動く」。**候補が 2 つ以上ある
// ときは一覧を出して選ばせる。**
//
// React の外に置く理由は `CursorPositionStore` と同じ: 押し込むのは pointerdown の
// 経路（React の外）で、購読するのは一覧の 1 ノードだけである。

import type { FeatureId, VertexId } from '../../domain/ids';

/** 一覧に出す候補 1 つ。 */
export interface VertexCandidateRow {
  readonly featureId: FeatureId;
  readonly vertexId: VertexId;
  /** 持ち主の表示名（引けなければ空文字）。 */
  readonly featureName: string;
  /** クリック位置からの画面上の距離（px）。 */
  readonly distancePx: number;
}

/** 一覧そのもの（出ていないときは null）。 */
export interface VertexCandidateState {
  /** 地図セルの左上からの位置（px）。一覧はこの右下 8px に出す。 */
  readonly x: number;
  readonly y: number;
  readonly rows: readonly VertexCandidateRow[];
}

export type VertexCandidateListener = (state: VertexCandidateState | null) => void;

/** 一覧 1 個を持つ極小 pub/sub。スナップショットの同一性は保つ。 */
export class VertexCandidateStore {
  private state: VertexCandidateState | null = null;
  private readonly listeners = new Set<VertexCandidateListener>();

  get(): VertexCandidateState | null {
    return this.state;
  }

  subscribe(listener: VertexCandidateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(state: VertexCandidateState): void {
    this.state = state;
    this.emit();
  }

  /**
   * 畳む。**Escape と地図の他所のクリックで必ず消える**（§B.5 の台帳 #12 の条件）ので、
   * 呼び出し側はその 2 つの経路から必ずここを通す。
   */
  clear(): void {
    if (this.state === null) return;
    this.state = null;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}

/** 一覧を出すのは候補が 2 つ以上あるときだけ（1 つならそのまま掴めばよい）。 */
export const VERTEX_CANDIDATE_MIN = 2;
