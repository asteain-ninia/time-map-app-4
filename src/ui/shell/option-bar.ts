// UI layer (U20 / shell): the option bar's content store (設計書 §C.4 / §B.4).
//
// オプションバーは「いま持っている道具の、いまの状況」を 1 行で見せる帯である。中身は
// 道具ごとに違うので、道具の実装（追加・ナイフ・所属変更…）が **押し込む** 形にする。
// この unit は器と API だけを持ち、道具のことは何も知らない。
//
// 設計上の要点 3 つ:
//
//  1. **K-3（上部の帯の寸法を選択状態に依存させない）**: 5 区画のうち 道具名 112px /
//     対象 240px / 確定 176px は固定幅で、中身が空でも枠が残る（`shell.css` の
//     `.option-bar__*`）。したがって「地物を選ぶ」「道具を持ち替える」で帯の高さも
//     地図セルの矩形も動かない。寸法は CSS 側の単一真実源に置き、ここには持たない。
//  2. **React の外に置く**: 道具の状態は 60Hz の入力経路（頂点を打つたびに「頂点 4 個」
//     が変わる）から来る。React state に置くとシェル全体が毎フレーム再レンダーする
//     （技術方針 2.3）。MapSizeStore / CursorPositionStore と同じ極小 pub/sub にして、
//     購読するのは OptionBar の 1 ノードだけにする。
//  3. **スナップショットの同一性を保つ**: 変化が無いときは同じオブジェクトを返す。
//     `useSyncExternalStore` は同一性で再レンダーを決めるので、毎回新しいオブジェクトを
//     作ると無限ループになる。

import type { ReactNode } from 'react';

/** 確定欄（176px）に並ぶボタン 1 個。中身は道具が決める。 */
export interface OptionBarCommitButton {
  /** 道具の中で一意な識別子（React の key と、既定の `data-testid` の末尾になる）。 */
  readonly id: string;
  /**
   * `data-testid` をそのまま指定する（既定は `option-bar-commit-<id>`）。
   *
   * **役割が同じ testid を持ち越すための口である**（T-1「`data-testid` は役割で維持し、
   * 改名しない」）。追加の道具の確定ボタンは地図の上からこの帯へ引っ越したが、役割は
   * 「作図を確定する」のままなので `add-complete` を持ち越す。**新しい道具は指定せず、
   * 既定の名前を使うこと**（testid を無闇に増やさない）。
   */
  readonly testId?: string;
  /** 画面に出る日本語のラベル（U-8: 見えるラベルを付ける。FR-115）。 */
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

/**
 * 対象欄（240px）の中身。`stage` は「手順 1/3」のような段階表示で、段階を持たない
 * 道具は null（設計書 §C.4。「3 件中 2 件」と誤読されないよう「手順」の 2 文字を含めた
 * 文字列を道具側が渡す）。`name` が null なら「（選んでいません）」が薄く出る。
 */
export interface OptionBarTarget {
  readonly stage: string | null;
  readonly name: string | null;
}

/**
 * 設定欄に差し込まれた部品 1 個（吸着 ▾ / 深さ ▾ …）。
 *
 * **登録の印（トークン）はここには入れない。** 取り外しの所有権判定に使う印は
 * {@link OptionBarStore} の内部（`slotTokens`）だけが持つ。ここへ足すと
 * `store.get().slots` に混ざって外へ漏れ、描画（`OptionBar.tsx`）が読む形と
 * テストが比べる形（`toEqual`）の両方に影響してしまう。印は描画に一切関係しない。
 */
export interface OptionBarSlot {
  readonly id: string;
  readonly node: ReactNode;
}

/** オプションバーの表示状態のすべて。 */
export interface OptionBarState {
  /** 道具名（112px）。null なら既定の「選ぶ」。 */
  readonly toolName: string | null;
  readonly target: OptionBarTarget;
  /** 次の一手（1fr）。null なら既定の案内文。 */
  readonly nextStep: string | null;
  readonly commit: readonly OptionBarCommitButton[];
  readonly slots: readonly OptionBarSlot[];
}

const NO_TARGET: OptionBarTarget = { stage: null, name: null };

const EMPTY_STATE: OptionBarState = {
  toolName: null,
  target: NO_TARGET,
  nextStep: null,
  commit: [],
  slots: [],
};

export type OptionBarListener = (state: OptionBarState) => void;

function commitEqual(
  a: readonly OptionBarCommitButton[],
  b: readonly OptionBarCommitButton[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.testId !== y.testId ||
      x.label !== y.label ||
      x.onClick !== y.onClick ||
      (x.disabled ?? false) !== (y.disabled ?? false)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * オプションバーの内容を持つ極小 pub/sub。道具が押し込み、OptionBar 1 ノードだけが
 * 購読する。**変化しなかった呼び出しでは通知もスナップショットの差し替えもしない**
 * ので、毎フレーム同じ値を押し込んでも React は動かない。
 */
export class OptionBarStore {
  private state: OptionBarState = EMPTY_STATE;
  private readonly listeners = new Set<OptionBarListener>();

  /**
   * いま帯を持っている道具の印（{@link claim}）。増分 1 の申し送り
   * 「`reset()` を誰がいつ呼ぶかが未定。呼ぶ責任の所在を決めずに道具側から押し込み始めると、
   * 道具をまたいで古い中身が残る」への答えである。
   *
   * **決めた規則は 3 行**:
   *   1. 帯は **1 つの道具だけが持つ**。持ったらその瞬間に中身は空へ戻る。
   *   2. 手放しは **自分が持っているときだけ**効く（あとから別の道具が持っていたら空振り）。
   *   3. 押し込み（4 本の API）は持ち主かどうかを見ない ―― 見ると「持っていないのに
   *      押し込んだ」が黙って消えて原因を追えなくなる。押し込む側が持つ、が規約である。
   *
   * 2 の理由は {@link registerOptionSlot} の印と同じ（React の effect は「後片付け →
   * 再実行」の順に走るとは限らないので、遅れて走った古い後片付けが生きている登録を
   * 消してしまう）。
   */
  private owner: unknown = null;

  /**
   * 設定欄の「いま載っている登録」の印。id ごとに **登録 1 回につき 1 個の Symbol** を
   * 発行して覚えておき、取り外しはこの印が一致するときだけ効かせる（{@link registerOptionSlot}）。
   *
   * **なぜ「差し込んだ node と同じか」で判定してはいけないか**: React の effect は
   * 「後片付け → 再実行」の順に走るとは限らない。同じ id・**同じ node インスタンス**で
   * 登録し直したあとに、前の登録の後片付けが遅れて走ることがある。node で比べると
   * 「自分が入れたものが載っている」と誤判定して、生きている新しい登録を消してしまう。
   * 印なら登録ごとに必ず別物なので、遅れて走った古い後片付けは必ず空振りする。
   */
  private readonly slotTokens = new Map<string, symbol>();

  get(): OptionBarState {
    return this.state;
  }

  /** 購読する。戻り値は解除。（現在値は `get` で取る＝スナップショットは 1 経路。） */
  subscribe(listener: OptionBarListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 道具名（112px の区画）。null で既定へ戻す。 */
  setToolName(toolName: string | null): void {
    if (this.state.toolName === toolName) return;
    this.replace({ toolName });
  }

  /**
   * 対象欄（240px）。`stage` は「手順 1/3」のような段階表示、`name` は対象の名前。
   * どちらも null にできる（0 件でも枠は残る＝K-3）。
   */
  setTarget(stage: string | null, name: string | null): void {
    const current = this.state.target;
    if (current.stage === stage && current.name === name) return;
    this.replace({ target: { stage, name } });
  }

  /** 次の一手（1fr の区画）。拒否理由もここへ出す（設計書 §H.5）。 */
  setNextStep(nextStep: string | null): void {
    if (this.state.nextStep === nextStep) return;
    this.replace({ nextStep });
  }

  /** 確定欄（176px）のボタン列。空配列で「確定の要らない道具」になる。 */
  setCommit(commit: readonly OptionBarCommitButton[]): void {
    if (commitEqual(this.state.commit, commit)) return;
    this.replace({ commit: [...commit] });
  }

  /**
   * 設定欄へポップオーバー等の部品を差し込む（吸着 ▾ / 深さ ▾ / 表示 ▾）。同じ `id` で
   * 呼び直すと差し替わる。戻り値は取り外し。**取り外しは「この呼び出しで入れた登録」が
   * 載っているときだけ効く**ので、別の道具が同じ id を上書きしたあとに古い解除が走っても、
   * 新しい部品を巻き添えで消さない（教訓 5.2: 一時状態は経路ごとに確実に畳む）。
   *
   * 所有権は {@link slotTokens} の印で見る。**差し込んだ node の同一性では見ない** —
   * 同じ id・同じ node インスタンスで登録し直したときに、遅れて走った古い後片付けが
   * 生きている登録を消してしまうため（詳しくは `slotTokens` の注記）。
   *
   * また **変化が無ければ何もしない**（同じ id に同じ node が既に載っているとき）。
   * ここで無条件に `replace` すると、押し込むたびに購読者（OptionBar）が再レンダーし、
   * 描画中に呼ぶ経路では無限ループになる。印だけは新しいものへ差し替えるが、印は
   * 描画にも `store.get()` の同一性にも影響しないので、スナップショットは据え置かれる。
   *
   * **帯からはみ出す部品（ポップオーバー・ドロップダウン）は `position: fixed` にして、
   * アンカー要素の矩形から座標を計算すること。** オプションバーの帯は `overflow: hidden`
   * なので、`position: absolute` で下へ伸ばすと切れる。作法は `src/ui/shell/Tooltip.tsx`
   * と同じ（開いた瞬間にアンカーの `getBoundingClientRect()` から窓の座標を出し、窓の端に
   * 寄せる）。
   */
  registerOptionSlot(id: string, node: ReactNode): () => void {
    const token = Symbol(id);
    this.slotTokens.set(id, token);

    const unregister = (): void => {
      // 自分の登録が今も載っているときだけ外す（印の同一性で見る）。
      if (this.slotTokens.get(id) !== token) return;
      this.slotTokens.delete(id);
      const current = this.state.slots;
      const remaining = current.filter((s) => s.id !== id);
      // reset() 等で既に消えていたら状態は動かさない（同一性を保つ）。
      if (remaining.length === current.length) return;
      this.replace({ slots: remaining });
    };

    const existing = this.state.slots.find((s) => s.id === id);
    if (existing !== undefined && existing.node === node) return unregister;

    const next = this.state.slots.filter((s) => s.id !== id);
    next.push({ id, node });
    this.replace({ slots: next });
    return unregister;
  }

  /**
   * 帯を「持つ」。道具が構えられたときに 1 回呼ぶ。**持った瞬間に中身は空へ戻る**ので、
   * 前の道具が残した道具名・対象・次の一手が持ち越されることはない（教訓 5.2）。
   *
   * 戻り値は手放す関数で、**自分がまだ持っているときだけ**空へ戻す。道具の effect の
   * 後片付けにそのまま置ける。
   *
   * @param owner 呼び出しごとに別物になる印（`Symbol()` など）を渡す。
   */
  claim(owner: object): () => void {
    this.owner = owner;
    this.reset();
    return () => {
      if (this.owner !== owner) return; // 既に別の道具が持っている ⇒ 何もしない。
      this.owner = null;
      this.reset();
    };
  }

  /** いま誰かが帯を持っているか（検査用。描画には使わない）。 */
  hasOwner(): boolean {
    return this.owner !== null;
  }

  /** 道具を降りるときの一括クリア（教訓 5.2: 一時的 UI 状態は全経路で破棄する）。 */
  reset(): void {
    // 印も一緒に捨てる。残すと、reset のあとに遅れて走った古い後片付けが
    // 「自分のものが載っている」と誤判定しうる。
    this.slotTokens.clear();
    if (this.state === EMPTY_STATE) return;
    this.state = EMPTY_STATE;
    this.emit();
  }

  private replace(patch: Partial<OptionBarState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}
