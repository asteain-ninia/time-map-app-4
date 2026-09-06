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

/**
 * 次の一手の枠に載せるボタン（増分 4 の手直し E1 / 設計書 §H.5「次の一手をボタンにする」）。
 *
 * **文だけでは次の一手にならないことがある。** 「読むだけなので直せません」は
 * 「では鍵を開ければよい」まで言えて初めて次の一手で、その 1 手を **押せる形**で
 * 置く場所がここまで無かった。確定欄（176px）は道具のものなので、断りの相手には使えない。
 */
export interface OptionBarAction {
  readonly id: string;
  readonly label: string;
  readonly onClick: () => void;
}

/** オプションバーの表示状態のすべて。 */
export interface OptionBarState {
  /** 道具名（112px）。null なら既定の「選ぶ」。 */
  readonly toolName: string | null;
  readonly target: OptionBarTarget;
  /** 次の一手（1fr）。null なら既定の案内文。 */
  readonly nextStep: string | null;
  /** 次の一手の枠に載せるボタン（0 個でよい）。 */
  readonly nextStepActions: readonly OptionBarAction[];
  readonly commit: readonly OptionBarCommitButton[];
  readonly slots: readonly OptionBarSlot[];
}

const NO_TARGET: OptionBarTarget = { stage: null, name: null };

const EMPTY_STATE: OptionBarState = {
  toolName: null,
  target: NO_TARGET,
  nextStep: null,
  nextStepActions: [],
  commit: [],
  slots: [],
};

export type OptionBarListener = (state: OptionBarState) => void;

function slotsEqual(
  a: readonly OptionBarSlot[],
  b: readonly OptionBarSlot[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.id !== b[i]?.id || a[i]?.node !== b[i]?.node) return false;
  }
  return true;
}

function actionsEqual(
  a: readonly OptionBarAction[],
  b: readonly OptionBarAction[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.id !== b[i]?.id || a[i]?.label !== b[i]?.label || a[i]?.onClick !== b[i]?.onClick) {
      return false;
    }
  }
  return true;
}

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
   * **帯の「代」**（増分 5 の手直し 2 回目）。{@link claim} と {@link reset} で 1 つ増える。
   *
   * **なぜ要るか**: 押し込む側は「自分が入れたものを、自分が降りるときに戻す」という
   * 対称な書き方をしている（教訓 5.68）。ところが手順のある 5 道具は、`activeTool` が
   * 外れたあと **effect の中で** 自分の状態を畳む（`resetForSwitch()` → `setState`）ので、
   * 後片付けが **1 コミット遅れて**走る。その 1 コミットのあいだに、同じ持ち替えで
   * 次の持ち主（`ToolOptionBar` / `SurveyOptionBar`）が帯を持ち直して押し込みを済ませて
   * いるため、遅れて走った後片付けが **次の持ち主の押し込みを踏み消す**（実測: 5 道具 →
   * 選ぶ／頂点／動かす／測る の 20 通りで、対象欄が「（選んでいません）」で固まった）。
   *
   * 教訓 5.68 の「印」はコントローラのローカルなので、**いま誰が帯を持っているか**を
   * 知らない ―― だから印だけでは塞げない。印を **器の側**に置き、
   * 「押し込んだときの代と、後片付けのときの代が同じなら効かせる」にすると、
   * 持ち直しをまたいだ後片付けは必ず空振りする。
   *
   * 代が変わる契機は「誰かが帯を持ち直した／空へ戻した」ときだけなので、その場合は
   * どのみち中身が空になっている ―― **効かせないことで消し残る中身は無い**。
   */
  private generation = 0;

  /**
   * 「代」が変わったことの報せ先（{@link subscribeOwner}）。**中身の購読とは別に持つ**
   * ―― 中身の購読（{@link subscribe}）はスナップショットの同一性で再レンダーを決めるので、
   * `reset()` が「既に空だった」と判断して同一性を保った場合に通知が飛ばない。押し込む側が
   * 知りたいのは「**器が誰かに持ち直された**」ことそのものである。
   */
  private readonly ownerListeners = new Set<() => void>();

  /**
   * **対象欄を最後に書いた人の印**（手直し 3 回目）。空へ戻すのは
   * 「**自分が最後に書いた人のときだけ**」にするために要る。
   *
   * **なぜ「代」では足りないか**: 代は「器が持ち直されたか」しか見ていない。押し込む側が
   * 代の変化で **押し直す**ようになった（手直し 3 回目の 2）結果、押し直した側は新しい代を
   * 覚えるので、そのあと降りたときの後片付けが **もう古くない** ―― 次の持ち主が入れた
   * 中身をまた踏み消す（実測: 分ける → 選ぶ で対象欄が空になった）。**誰が書いたか**で
   * 見れば、あいだに別の人が書いた時点で後片付けは空振りする。印の考え方は
   * {@link registerOptionSlot} の `slotTokens` と同じである。
   */
  private targetWriter: unknown = null;

  /** 次の一手と確定欄を最後に書いた人の印（この 2 つは同じ呼び出し側が対で書く）。 */
  private chromeWriter: unknown = null;

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

  /**
   * 設定欄の **並び順キー**。id ごとに「初めて登録されたとき 1 回だけ」単調増加の番号を
   * 配り、`state.slots` は常にこの番号の小さい順に並べて公開する。
   *
   * **なぜ「載っている配列の中でその場で差し替える」だけでは足りないか**（増分 3 で
   * 直したつもりが直っていなかった粗）: 同じ effect の依存が変わったとき、React は
   * 「（古い登録の）後片付け → （新しい登録の）再実行」の順に走らせる。中身を更新して
   * 登録し直すのはまさにこの経路である。だから登録し直す瞬間には、
   * 古い後片付けが**先に**そのスロットを外し終えている。新しい登録から見ると配列に
   * その id は載っていないので、「その場で差し替える」分岐は一度も通らず、必ず末尾へ
   * 回る。結果、吸着の許容値を変えるたびに「吸着 ▾」が「1 つ戻す」の右へ飛ぶ。
   * id ごとの番号を store 側が覚えていれば、いったん外れても同じ場所へ戻る。
   *
   * したがって **取り外し（unregister）では番号を捨てない**。捨てると、戻ってきた id が
   * 新しい番号をもらって末尾へ行き、同じ症状に戻る。捨てるのは道具を降りる
   * {@link reset} のときだけ（次の道具の設定欄は、その道具が入れた順に並ぶ）。
   *
   * 番号は描画にも `store.get()` の同一性にも関係しない内部の値なので、`slotTokens` と
   * 同じく {@link OptionBarSlot} には入れない。
   */
  private readonly slotOrder = new Map<string, number>();

  /** 次に配る並び順キー。単調増加させ、{@link reset} で 0 へ戻す。 */
  private nextSlotOrder = 0;

  /**
   * **道具に属さない** 設定欄の部品（増分 4 の「表示 ▾」）。
   *
   * `registerOptionSlot` の部品は道具のものなので、次の道具が {@link claim} した
   * 瞬間に全部落ちる。ところが **表示の設定は道具に属さない** ―― 読むだけのときも、
   * 道具を持っていないときも、面を描いている最中も同じように使える必要がある
   * （設計書 §B.1 のワイヤーフレームも「吸着▾ 深さ▾」を同時に出している）。
   * そこで道具の部品とは別の器に持ち、{@link claim} / {@link reset} で落ちないようにする。
   *
   * 並びは **道具の部品のうしろ**。道具ごとに変わるものが左、いつも同じものが右に
   * 来るほうが、道具を持ち替えたときに目が迷わない。
   */
  private readonly persistentSlots = new Map<string, ReactNode>();

  /** 常設スロットの並び順（登録した順）。`reset` でも捨てない。 */
  private readonly persistentOrder = new Map<string, number>();

  private nextPersistentOrder = 0;

  /** 常設スロットの登録の印（`slotTokens` と同じ理由で node 同一性では見ない）。 */
  private readonly persistentTokens = new Map<string, symbol>();

  get(): OptionBarState {
    return this.state;
  }

  /**
   * いまの「代」を読む（{@link generation} の注記）。押し込む側は押し込む直前に読み、
   * 後片付けでもう一度読んで **一致するときだけ**空へ戻すこと。
   */
  epoch(): number {
    return this.generation;
  }

  /**
   * 「代」の変化を購読する（戻り値は解除）。
   *
   * **押し込む側はこれを見て押し直す**（手直し 3 回目）。器は持ち直されると中身を空へ
   * 戻すので、押し込んだ側が黙っていると **帯が空のまま固まる** ―― 実測で、下書きを
   * 持ったまま「選ぶ」や鍵へ行って板の［続ける］を選ぶと、道具も点も残っているのに
   * 対象欄が「（選んでいません）」のまま戻らなかった（1.5 秒待っても、1 点足しても）。
   * 押し込みの effect が代を依存に持てば、持ち直しのたびに押し直しが走る。
   */
  subscribeOwner(listener: () => void): () => void {
    this.ownerListeners.add(listener);
    return () => {
      this.ownerListeners.delete(listener);
    };
  }

  /** 代を 1 つ進めて、押し込む側へ報せる。 */
  private bumpGeneration(): void {
    this.generation += 1;
    for (const l of this.ownerListeners) l();
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
  setTarget(stage: string | null, name: string | null, writer: unknown = null): void {
    // **書いた人を必ず塗り替える**（値が同じでも）。別の人が同じ値を書いた瞬間に、
    // 前の人の後片付けは空振りになるのが正しい。
    this.targetWriter = writer;
    const current = this.state.target;
    if (current.stage === stage && current.name === name) return;
    this.replace({ target: { stage, name } });
  }

  /**
   * **自分が最後に書いた対象欄だけ**を空へ戻す（{@link targetWriter}）。あいだに別の人が
   * 書いていたら何もしない ―― 降りた道具の後片付けが次の持ち主を踏み消さないための関門。
   */
  clearTargetIfMine(writer: unknown): void {
    if (this.targetWriter !== writer) return;
    this.setTarget(null, null);
  }

  /**
   * 次の一手（1fr の区画）。拒否理由もここへ出す（設計書 §H.5）。
   *
   * `actions` を渡すと、文の右に **押せるボタン**が並ぶ（増分 4 の手直し E1）。
   * 省略すると空になる ―― 前の断りのボタンが次の断りに残らないようにするためで、
   * 「消す契機を意味のあるイベントに限る」（教訓 5.12）と矛盾しない（文が変われば
   * ボタンも変わるのが正しい）。
   */
  setNextStep(
    nextStep: string | null,
    actions: readonly OptionBarAction[] = [],
    writer: unknown = null,
  ): void {
    this.chromeWriter = writer;
    if (this.state.nextStep === nextStep && actionsEqual(this.state.nextStepActions, actions)) {
      return;
    }
    this.replace({ nextStep, nextStepActions: [...actions] });
  }

  /** 確定欄（176px）のボタン列。空配列で「確定の要らない道具」になる。 */
  setCommit(commit: readonly OptionBarCommitButton[], writer: unknown = null): void {
    this.chromeWriter = writer;
    if (commitEqual(this.state.commit, commit)) return;
    this.replace({ commit: [...commit] });
  }

  /**
   * **自分が最後に書いた次の一手・確定欄だけ**を空へ戻す（{@link chromeWriter}）。
   * 理由は {@link clearTargetIfMine} と同じ。
   */
  clearChromeIfMine(writer: unknown): void {
    if (this.chromeWriter !== writer) return;
    this.setNextStep(null);
    this.setCommit([]);
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
   * **並び順は「id ごとの並び順キー」で決める**（{@link slotOrder}）。配列の中でその場で
   * 差し替える形では直らない ―― 登録し直す瞬間には古い後片付けが先に走っていて、
   * 配列にその id は載っていないからである（詳しくは `slotOrder` の注記）。
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
    // 並び順キーは **id につき 1 回だけ** 配る。2 回目以降（＝中身の更新）は最初の
    // 番号をそのまま使うので、いったん外れてから戻ってきても元の場所へ戻る。
    if (!this.slotOrder.has(id)) {
      this.slotOrder.set(id, this.nextSlotOrder);
      this.nextSlotOrder += 1;
    }

    const unregister = (): void => {
      // 自分の登録が今も載っているときだけ外す（印の同一性で見る）。
      if (this.slotTokens.get(id) !== token) return;
      this.slotTokens.delete(id);
      // 並び順キーはここでは **捨てない**。捨てると、中身の更新（外す → 入れ直す）の
      // たびに新しい番号をもらって末尾へ回り、部品が左右へ飛ぶ。
      const current = this.state.slots;
      const remaining = current.filter((s) => s.id !== id);
      // reset() 等で既に消えていたら状態は動かさない（同一性を保つ）。
      if (remaining.length === current.length) return;
      this.replace({ slots: remaining });
    };

    const at = this.state.slots.findIndex((s) => s.id === id);
    if (at >= 0 && this.state.slots[at]?.node === node) return unregister;

    // **並び順は id ごとの番号で決める**。差し替えのたびに末尾へ回すと、設定欄の部品が
    // 中身の更新のたびに左右へ飛ぶ（例: 「吸着 ▾」が許容値を変えるたびに「1 つ戻す」の
    // 右へ移動する）。
    const next = [...this.state.slots];
    if (at >= 0) next[at] = { id, node };
    else next.push({ id, node });
    next.sort((a, b) => this.slotOrderOf(a.id) - this.slotOrderOf(b.id));
    this.replace({ slots: next });
    return unregister;
  }

  /**
   * 並び順キーを読む。番号が無い id は末尾へ回す（`registerOptionSlot` が必ず先に
   * 配るので通らないはずの道だが、番号の有無で並びが不定にならないよう固定しておく）。
   */
  private slotOrderOf(id: string): number {
    return this.slotOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * **道具に属さない** 部品を設定欄へ差し込む（増分 4 の「表示 ▾」）。
   *
   * {@link registerOptionSlot} との違いは 1 つだけで、**道具が帯を持ち直しても
   * （{@link claim} / {@link reset}）落ちない**ことである。表示の設定は道具の状態では
   * ないので、道具を持ち替えたら消える、では使えない。
   *
   * 取り外しは自分の登録が載っているときだけ効く（印の同一性で見る）。位置の作法
   * （`position: fixed` / `[hidden]` の打ち消し / バックドロップを置かない）は
   * {@link registerOptionSlot} と同じである。
   */
  registerPersistentSlot(id: string, node: ReactNode): () => void {
    const token = Symbol(id);
    this.persistentTokens.set(id, token);
    if (!this.persistentOrder.has(id)) {
      this.persistentOrder.set(id, this.nextPersistentOrder);
      this.nextPersistentOrder += 1;
    }
    const unregister = (): void => {
      if (this.persistentTokens.get(id) !== token) return;
      this.persistentTokens.delete(id);
      if (!this.persistentSlots.has(id)) return;
      this.persistentSlots.delete(id);
      this.republishSlots();
    };
    if (this.persistentSlots.get(id) === node) return unregister;
    this.persistentSlots.set(id, node);
    this.republishSlots();
    return unregister;
  }

  /**
   * 公開する `slots` を組み直す（道具の部品 → 常設の部品の順）。**道具の部品の並びは
   * `state.slots` が正**なので、そこから常設ぶんを取り除いてから足し直す。
   */
  private republishSlots(): void {
    const persistentIds = new Set(this.persistentSlots.keys());
    const toolSlots = this.state.slots.filter((s) => !persistentIds.has(s.id));
    const persistent = [...this.persistentSlots.entries()]
      .map(([id, node]) => ({ id, node }))
      .sort((a, b) => this.persistentOrderOf(a.id) - this.persistentOrderOf(b.id));
    this.replace({ slots: [...toolSlots, ...persistent] });
  }

  private persistentOrderOf(id: string): number {
    return this.persistentOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
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
    this.bumpGeneration();
    return () => {
      if (this.owner !== owner) return; // 既に別の道具が持っている ⇒ 何もしない。
      this.owner = null;
      this.reset();
      this.bumpGeneration();
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
    // 書いた人の印も捨てる。残すと、reset のあとに遅れて走った後片付けが
    // 「自分が最後に書いた」と誤判定しうる（`slotTokens` と同じ理由）。
    this.targetWriter = null;
    this.chromeWriter = null;
    this.slotTokens.clear();
    // 並び順キーも捨てる。道具が替われば設定欄の顔ぶれも替わるので、前の道具が使った
    // 番号を引きずると、次の道具の部品が「前の道具での順番」で並んでしまう。
    this.slotOrder.clear();
    this.nextSlotOrder = 0;
    // **常設の部品（表示 ▾）は落とさない。** 道具に属さないものを道具の都合で消すと、
    // 道具を持ち替えるたびに表示の設定が画面から消える。
    const persistent = [...this.persistentSlots.entries()]
      .map(([id, node]) => ({ id, node }))
      .sort((a, b) => this.persistentOrderOf(a.id) - this.persistentOrderOf(b.id));
    const next: OptionBarState = { ...EMPTY_STATE, slots: persistent };
    if (
      this.state.toolName === next.toolName &&
      this.state.target === EMPTY_STATE.target &&
      this.state.nextStep === next.nextStep &&
      this.state.commit.length === 0 &&
      slotsEqual(this.state.slots, next.slots)
    ) {
      return;
    }
    this.state = next;
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
