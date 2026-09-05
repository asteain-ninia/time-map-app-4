// UI layer (U20 / shell): 右パネルの「どの区画に注目させるか」の API（設計書 §I.3 /
// 結合点 #3）。
//
// **これが埋める穴**: 右クリックの「プロパティを編集」は
// `document.getElementById('sidebar-tab-properties')?.click()` を呼んでいた
// （`App.tsx` の `focusPropertyTab`）。タブの DOM が在ることと、押すと切り替わることの
// 両方に依存していて、**排他タブをやめて上下 2 区画にすると成り立たない**。同じ箇所の
// コメント自身が「明示的なタブ状態 API は shell の改修になるので後回し」と認めていた。
//
// 上下 2 区画では「切り替える」ではなく **「その区画へ寄せる」** になる（設計書 §I.3）。
// 区画は両方とも画面に出ているので、やることは 3 つ:
//   1. その区画を先頭までスクロールする
//   2. その区画の見出しに印を付ける（いまどちらを見ればよいかを示す）
//   3. その区画の中の「最初に触ってほしいもの」に焦点を入れる（素性欄なら名前欄）
//
// **React の外に置く**理由は `option-bar.ts` と同じで、押し込む側（合成ルート・右クリック・
// 追加の確定）が React の描画の外から呼ぶからである。極小の pub/sub にして、購読するのは
// Sidebar の 1 ノードだけにする。

/** 右パネルの区画の鍵。`Sidebar` の `SIDEBAR_SECTION` と同じ値を使う。 */
export type SidebarFocusSection = 'list' | 'properties';

/** 注目の要求 1 回ぶん。`nonce` は「同じ区画へ続けて 2 回寄せる」を区別するために要る。 */
export interface SidebarFocusRequest {
  readonly section: SidebarFocusSection;
  /** 要求ごとに 1 ずつ増える。同じ区画への連続要求も別物として届く。 */
  readonly nonce: number;
}

export type SidebarFocusListener = (request: SidebarFocusRequest) => void;

/**
 * 「この区画に注目させてほしい」を伝える極小の pub/sub。
 *
 * **状態は持たない**（最後の要求だけを覚える）。区画そのものの見た目の状態は
 * `Sidebar` が持つ ―― ここが持つと、利用者が見出しを押して注目を移したときに
 * 2 か所へ書くことになり、真実源が割れる。
 */
export class SidebarFocusStore {
  private request: SidebarFocusRequest | null = null;
  private nonce = 0;
  private readonly listeners = new Set<SidebarFocusListener>();

  /** 最後の要求（まだ 1 度も無ければ null）。 */
  get(): SidebarFocusRequest | null {
    return this.request;
  }

  subscribe(listener: SidebarFocusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** その区画へ寄せる。購読者が居なければ何も起きない（要求だけ残る）。 */
  focus(section: SidebarFocusSection): void {
    this.nonce += 1;
    this.request = { section, nonce: this.nonce };
    for (const l of this.listeners) l(this.request);
  }
}
