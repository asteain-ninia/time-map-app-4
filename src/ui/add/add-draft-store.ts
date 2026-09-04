// UI layer (U23): 「形を確定したあとの新規地物の入力」を右パネルへ渡す極小 pub/sub。
//
// **なぜ要るのか**（N-15 / G-8 / 設計書 §C.2 の 27）:
//
// 追加の確定後に出る入力フォームは、これまで **地図の真ん中**に浮いていた
// （実測 rect 375,259,431×134）。**いま描いた形をフォームが覆う**ので、名前を入れながら
// 形を確かめられない。設計書はこれを「独立した追加フォームを出すのをやめ、確定後は
// **素性欄が『新規の姿』で開く**」と決めた。素性欄は右パネルなので地図を覆わない。
//
// ところが道具（`AddToolController`）は地図セルの覆い（`mapOverlay`）の中に、素性欄は
// サイドバーの中に居て、React の木の上では兄弟ですらない。**下書きの中身を親まで持ち上げる
// と、頂点を打つたびにシェル全体が再レンダーする**（技術方針 2.3）。そこで
// `OptionBarStore` / `CursorPositionStore` と同じ極小 pub/sub を 1 本置き、道具が
// 「いま入力を待っている」ことだけを押し込み、素性欄の側がそれを購読する。
//
// **持つのは「入力を待っているか」だけ**である。名前や種別ラベルの下書きはフォームの中
// （React の state）に閉じている。ここへ入れると 1 文字打つたびに購読者が再レンダーする。

import type { AddProperties, AddToolKind, ParentCandidate } from '../../domain/add/index';
import type { FeatureId } from '../../domain/ids';

/** 道具が「形を確定したので素性を入れてほしい」と言っている状態。 */
export interface AddDraftPrompt {
  /** どの道具の確定か（面のときだけ親領域を聞く＝FR-77）。 */
  readonly tool: AddToolKind;
  /**
   * 上位領域の候補（面のときだけ）。**いま描いた形を丸ごと含む面**に絞ってある
   * （増分 3 の手直し B2 / FR-77）。
   */
  readonly parentCandidates: readonly ParentCandidate[];
  /**
   * 候補が 1 つに決まるときの既定（決まらなければ null）。入れ子として通した形が
   * 黙って「上位領域なし」で保存されるのを防ぐ（GPT #4）。
   */
  readonly defaultParentId: FeatureId | null;
  /**
   * 年代の既定に使う「いま見ている年」（G-8 / 設計書 §C.2 の 27）。
   * これまでは `DEFAULT_START_YEAR = 0` の固定で、5080 年で追加しても 0 年になり、
   * **毎回あとから開始年・終了年を打ち直す後始末（実測 17.2 秒＝作業全体の 44%）**が
   * 発生していた。
   */
  readonly currentYear: number;
  /** 親領域を選ぶ（null ＝ 親なし／最上位、FR-39）。 */
  readonly onChooseParent: (featureId: FeatureId | null) => void;
  /** 保存（＝素性欄の保存ボタン。`data-testid="add-save"` の付け替え先）。 */
  readonly onSave: (properties: AddProperties) => void;
  /** やめる（下書きを丸ごと捨てる。教訓 5.2）。 */
  readonly onCancel: () => void;
}

export type AddDraftListener = (prompt: AddDraftPrompt | null) => void;

/**
 * 入力待ちを 1 つだけ持つ極小 pub/sub。**変化が無ければ通知しない**（同じ値を毎レンダー
 * 押し込んでも購読者は動かない ―― `useSyncExternalStore` は同一性で再レンダーを決める）。
 */
export class AddDraftStore {
  private prompt: AddDraftPrompt | null = null;
  private readonly listeners = new Set<AddDraftListener>();

  get(): AddDraftPrompt | null {
    return this.prompt;
  }

  subscribe(listener: AddDraftListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 入力待ちを差し替える（`null` で「待っていない」へ戻す）。**中身が同じなら何もしない**
   * ので、道具が毎レンダー同じ値を押し込んでも購読者は再レンダーしない。
   */
  set(next: AddDraftPrompt | null): void {
    if (samePrompt(this.prompt, next)) return;
    this.prompt = next;
    for (const l of this.listeners) l(this.prompt);
  }
}

function samePrompt(a: AddDraftPrompt | null, b: AddDraftPrompt | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.tool === b.tool &&
    a.currentYear === b.currentYear &&
    a.defaultParentId === b.defaultParentId &&
    a.parentCandidates === b.parentCandidates &&
    a.onChooseParent === b.onChooseParent &&
    a.onSave === b.onSave &&
    a.onCancel === b.onCancel
  );
}
