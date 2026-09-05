// 一覧（台帳）へ外から指図を送る細い口（増分 4 の手直し B8）。
//
// **なぜ要るか**: 「前の未処理へ」「次の未処理へ」「その場で改名」は、鍵盤の
// ショートカットとメニューからも届かなければならない（設計書 §I.2）。ところが
// ショートカットの登録簿（`CommandRegistry`）を持っているのは合成ルートで、実際に
// 動かすのは一覧の中身である。両者は親子でも兄弟でもないので、`ledger-focus.ts` と
// まったく同じ形の極小 pub/sub を 1 本渡す。
//
// **DOM を名前で探さない。** `document.querySelector('[data-testid="bundle-next"]')?.click()`
// のような書き方は、右クリックの「プロパティを編集」が `getElementById` に依存して
// 増分 4 で壊れたのと同じ結合である（結合点 #3）。

/** 一覧に頼める指図の種類（分岐識別子は定数を経由する、教訓 5.19）。 */
export const LEDGER_COMMAND = {
  /** 作業のまとまりの ◀ 前へ。 */
  BundlePrev: 'bundlePrev',
  /** 作業のまとまりの 次へ ▶。 */
  BundleNext: 'bundleNext',
  /** 選んでいる地物を一覧の行でその場改名する（F2）。 */
  Rename: 'rename',
} as const;

export type LedgerCommand = (typeof LEDGER_COMMAND)[keyof typeof LEDGER_COMMAND];

export type LedgerCommandListener = (command: LedgerCommand) => void;

/** 「一覧にこれをやってほしい」を伝える極小の pub/sub。状態は持たない。 */
export class LedgerCommandStore {
  private readonly listeners = new Set<LedgerCommandListener>();

  subscribe(listener: LedgerCommandListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 指図を送る。購読者が居なければ何も起きない（黙って落ちる）。 */
  send(command: LedgerCommand): void {
    for (const l of this.listeners) l(command);
  }
}
