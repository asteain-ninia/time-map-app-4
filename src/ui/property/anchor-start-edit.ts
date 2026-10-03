// 「この錨の開始年を変える」の要求の口（設計書 §I.3 の時刻レールの右クリック。
// 増分 7 の手直し 項目 6）。
//
// **開始年を変える操作は素性欄の錨表の「存続期間」の欄が既に持っている**（U09 `changeStart`）。
// レールの右クリックは新しい操作を作らず、その欄を開いて開始の欄へ焦点を置くだけにする。
// 要求を出すのは時刻レール、受けるのは素性欄で、両者は親子でも兄弟でもないので、
// 名前欄の焦点（`name-focus.ts`）と同じ形の細い口を 1 本渡す。**DOM を名前で探さない**
// （結合点 #3 と同じ型の結合を作らない）。

import type { AnchorId } from '../../domain/ids';

export type AnchorStartEditListener = (anchorId: AnchorId) => void;

/** 「この錨の開始年の欄を開いて焦点を置いてほしい」を伝える極小の pub/sub。 */
export class AnchorStartEditStore {
  private readonly listeners = new Set<AnchorStartEditListener>();

  subscribe(listener: AnchorStartEditListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 要求する。購読者（素性欄）が居なければ何も起きない。 */
  request(anchorId: AnchorId): void {
    for (const l of this.listeners) l(anchorId);
  }
}
