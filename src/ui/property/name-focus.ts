// 素性欄の名前欄へ焦点を入れる要求の口（増分 4 / 設計書 §C.5・§E.1 の V4）。
//
// **なぜ要るか**: 作業のまとまり（束）の第 1 手は「束を作った瞬間に、先頭の未処理を
// 選び、カメラを合わせ、**名前欄に焦点を入れる**」である（設計書 §C.5）。焦点を入れる
// 相手は素性欄の中の入力欄で、要求を出すのは一覧である。両者は親子でも兄弟でもないので、
// 器（`SidebarContent`）が細い口を 1 本渡す。
//
// **DOM を名前で探さない。** `document.querySelector('[aria-label="名前"]')` のような
// 探し方は、右クリックの「プロパティを編集」が `getElementById('sidebar-tab-properties')`
// に依存して増分 4 で壊れたのと同じ型の結合である（結合点 #3）。同じ間違いを別の場所で
// 作り直さないために、最初から口を通す。

export type NameFieldFocusListener = () => void;

/** 「名前欄へ焦点を入れてほしい」を伝える極小の pub/sub。状態は持たない。 */
export class NameFieldFocusStore {
  private readonly listeners = new Set<NameFieldFocusListener>();

  subscribe(listener: NameFieldFocusListener): () => void {
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
