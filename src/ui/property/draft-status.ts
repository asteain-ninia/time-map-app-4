// 素性欄が「いま打ちかけを抱えている地物」を外へ知らせる細い口（増分 4 の手直し B11）。
//
// **なぜ要るか**: 一覧のその場編集（F2 / ダブルクリック）は素性欄とまったく同じ
// 保存の 1 本を通る。ところが素性欄がその地物の名前を打ちかけているとき、一覧から
// 別の名前を書き込むと **打ちかけが黙って上書きされる**（素性欄は「対象が変わった」と
// 判定しないので、N-04 の確認も出ない）。
//
// 打ちかけを持っているのは素性欄なので、確認を出す責任も素性欄にある。一覧は
// 「いま打ちかけを抱えているのはこの地物だ」だけを聞いて、**自分では書き込まずに
// 理由を返す**（K-5 の趣旨: 一時状態を黙って失わせない）。
//
// `name-focus.ts` / `ledger-focus.ts` と同じ形の極小 pub/sub である。状態は 1 つだけ
// 持つ（購読者が後から現れても読めるように、これだけは値を保持する）。

import type { FeatureId } from '../../domain/ids';

export type DraftStatusListener = (featureId: FeatureId | null) => void;

/** 「いま打ちかけを抱えている地物」を伝える極小の pub/sub。 */
export class PropertyDraftStatusStore {
  private dirtyFeatureId: FeatureId | null = null;
  private readonly listeners = new Set<DraftStatusListener>();

  /** いま打ちかけを抱えている地物（無ければ null）。 */
  get(): FeatureId | null {
    return this.dirtyFeatureId;
  }

  /** 打ちかけの相手を差し替える。変わらなければ誰にも知らせない。 */
  set(featureId: FeatureId | null): void {
    if (this.dirtyFeatureId === featureId) return;
    this.dirtyFeatureId = featureId;
    for (const l of this.listeners) l(featureId);
  }

  subscribe(listener: DraftStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
