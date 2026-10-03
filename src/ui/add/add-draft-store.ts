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
   * 上位領域の候補（面のときだけ）。**その年に居る面をそのまま並べる（絞らない）**
   * ―― 離れた場所にある子を持つ上位領域も選べる必要があるため（FR-77）。
   */
  readonly parentCandidates: readonly ParentCandidate[];
  /**
   * 既定の上位領域（決まらなければ null）。**いま描いた形を丸ごと含む面のうち、
   * いちばん内側のもの**が入る。入れ子として通した形が黙って「上位領域なし」で
   * 保存されるのを防ぐ（GPT #4）。
   */
  readonly defaultParentId: FeatureId | null;
  /**
   * 年代の既定に使う「いま見ている年」（G-8 / 設計書 §C.2 の 27）。
   * これまでは `DEFAULT_START_YEAR = 0` の固定で、5080 年で追加しても 0 年になり、
   * **毎回あとから開始年・終了年を打ち直す後始末（実測 17.2 秒＝作業全体の 44%）**が
   * 発生していた。
   */
  readonly currentYear: number;
  /**
   * **上位領域の欄を出すか**（増分 5 の手直し / 司令塔の決定 (5)）。省略すると
   * 道具の種類から決める（面のときだけ出す＝`parentSelectableFor`）。
   *
   * **なぜ口が要るか**: ナイフで切った非継承側と、穴あけで生まれる新しい地物も
   * この「新規の姿」で素性を受けるようになった。どちらも面だが、**上位領域は
   * ドメインが元の地物から引き継ぐ**（FR-44 / FR-45）ので、ここで選ばせると
   * 「選んだのに反映されない欄」になる。道具の種類だけでは決められないので、
   * 押し込む側が明示できるようにしてある。
   */
  readonly showParent?: boolean;
  /** 親領域を選ぶ（null ＝ 親なし／最上位、FR-39）。 */
  readonly onChooseParent: (featureId: FeatureId | null) => void;
  /** 保存（＝素性欄の保存ボタン。`data-testid="add-save"` の付け替え先）。 */
  readonly onSave: (properties: AddProperties) => void;
  /** やめる（下書きを丸ごと捨てる。教訓 5.2）。 */
  readonly onCancel: () => void;
  /**
   * **保存が走っている間の文**（増分 8B の中身 3）。null・省略なら走っていない。
   * 分割の［保存］は編集案の組み立てと整合の検査で数秒かかるので、押した直後に
   * ［保存］をこの文に変えて押せなくする（所属変更の板と同じ進行表示）。
   */
  readonly busyLabel?: string | null;
  /**
   * **欄の上に添える注記**（増分 8B の手直し）。null・省略なら出さない。分割の非継承側は
   * 1 つの素性欄を何片かで共有するので「この名前と種別は 3 片すべてに付きます」と言う。
   */
  readonly note?: string | null;
  /**
   * **打ちかけがあるかの知らせ**（増分 8B の手直し / 反証 2-2）。名前か種別に何か打たれて
   * いれば真。変わったときだけ呼ばれる。道具は Escape で「聞かずにやめてよいか」を
   * **焦点のある欄ではなく中身で**決めるのに使う ―― 名前を打ってから地図を押すと焦点が
   * 欄から外れ、焦点だけを見ていると打ちかけが確認なしに捨てられていた。
   */
  readonly onDirtyChange?: (dirty: boolean) => void;
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
    a.onCancel === b.onCancel &&
    (a.busyLabel ?? null) === (b.busyLabel ?? null) &&
    (a.note ?? null) === (b.note ?? null) &&
    a.onDirtyChange === b.onDirtyChange
  );
}
