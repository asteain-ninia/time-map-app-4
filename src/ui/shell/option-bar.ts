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
  /** 道具の中で一意な識別子（React の key と `data-testid` の末尾になる）。 */
  readonly id: string;
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

/** 設定欄に差し込まれた部品 1 個（吸着 ▾ / 深さ ▾ …）。 */
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
   * 呼び直すと差し替わる。戻り値は取り外し。**取り外しは自分が入れた部品が載っている
   * ときだけ効く**ので、別の道具が同じ id を上書きしたあとに古い解除が走っても、新しい
   * 部品を巻き添えで消さない（教訓 5.2: 一時状態は経路ごとに確実に畳む）。
   */
  registerOptionSlot(id: string, node: ReactNode): () => void {
    const next = this.state.slots.filter((s) => s.id !== id);
    next.push({ id, node });
    this.replace({ slots: next });
    return () => {
      const current = this.state.slots;
      const mine = current.find((s) => s.id === id);
      if (mine === undefined || mine.node !== node) return;
      this.replace({ slots: current.filter((s) => s.id !== id) });
    };
  }

  /** 道具を降りるときの一括クリア（教訓 5.2: 一時的 UI 状態は全経路で破棄する）。 */
  reset(): void {
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
