// 地物一覧の絞り込み欄へ焦点を入れる要求の口（増分 4 / E-6 / 設計書 §I.2 の Ctrl+F）。
//
// **「地物を検索」を一覧の絞り込みへ統合した**（E-6）。旧: 独立した検索モーダルが開き、
// 母集団が一覧とは別に組まれていた（N-41）。新: メニューの「地物を検索」（Ctrl+F）は
// **この口を呼んで一覧の絞り込み欄へ焦点を入れるだけ**になり、探す・見る・直すが
// 1 本の母集団で閉じる。
//
// `property/name-focus.ts` と同じ形の極小 pub/sub である。**DOM を名前で探さない**
// のが要点で、`document.querySelector` で入力欄を掴む形は、右クリックの
// 「プロパティを編集」が `getElementById('sidebar-tab-properties')` に依存して
// 増分 4 で壊れたのとまったく同じ結合になる（結合点 #3）。

export type LedgerFilterFocusListener = () => void;

/** 「一覧の絞り込み欄へ焦点を入れてほしい」を伝える極小の pub/sub。状態は持たない。 */
export class LedgerFilterFocusStore {
  private readonly listeners = new Set<LedgerFilterFocusListener>();

  subscribe(listener: LedgerFilterFocusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 焦点を要求する。購読者が居なければ何も起きない（黙って落ちる）。 */
  focus(): void {
    for (const l of this.listeners) l();
  }
}
