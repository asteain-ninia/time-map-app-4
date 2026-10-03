// UI layer (U20 / shell): 状態行の「直前の結果」枠（設計書 §C.8 / §H.5）。
//
// **成功も失敗も映す、唯一の常設の場所**である。現状のアプリは成功を一度も知らせず
// （C6）、失敗だけが OS の警告ボックス（window.alert）で出ていた（N-21）。ここに置くのは
// 「消えない状態表示」で、§7.4 が非目標としている「数秒で自動消滅するトースト」ではない。
//
// 教訓 5.12「判断用メッセージを無関係な操作で消さない」(引用):「検証拒否・保存失敗など、
// ユーザーが次の判断に使うメッセージは、発生元と無関係なクリックやマウス操作で即時消去
// しない。消す契機は『同種操作の再試行』『明示的な閉じる』『成功した置換操作』など、意味を
// 持つイベントへ限定する。」
//
// 適用: このストアは**自分から消えない**。時間の経過でも、地図のクリックでも、時刻の移動でも
// 消えない。変わるのは (1) 次の結果が来て置き換わったとき (2) 利用者が明示的に閉じたとき
// (3) プロジェクトを開き直したとき の 3 つだけである（設計書 §H.5 の表）。
//
// React の外に置く理由は CursorPositionStore と同じ: 結果を押し込む側（ファイル操作・道具の
// 確定・ドメインの拒否理由）はシェルの外に散らばっているので、React state に置くと押し込みの
// たびにシェル全体が再レンダーする。購読するのは状態行の 1 ノードだけにする。

import type { TimePoint } from '../../domain/time/time-point';

/**
 * 時刻の移動の知らせに続ける文の鍵（{@link StatusMessageStore.stageMoveTrailer}）。粒度の
 * 違う同じ時刻（1500 年と 1500 年 1 月 1 日）を同じ鍵にする。
 */
export function moveTrailerKey(t: TimePoint): string {
  const month = t.granularity === 'year' ? 1 : t.month;
  const day = t.granularity === 'yearMonthDay' ? t.day : 1;
  return `${String(t.year)}-${String(month)}-${String(day)}`;
}

/** 結果の色味。文言そのものは押し込む側が日本語で作る（FR-115）。 */
export const STATUS_TONE = {
  /** 成功（保存できた・所属を変えた など）。 */
  Success: 'success',
  /** 失敗・拒否（ドメインが返した理由をそのまま出す）。 */
  Failure: 'failure',
  /** 進行中（確定が 500ms を超えたとき）。 */
  Progress: 'progress',
  /**
   * 中立（やめた・何も起きなかった）。**成功でも失敗でもない結末**を、成功の色味で
   * 出さないために足した。「保存をやめました。ファイルは変わっていません。」を
   * 緑で出すと「保存できた」と読み違える（実機で読み違えた）。
   */
  Neutral: 'neutral',
} as const;

export type StatusTone = (typeof STATUS_TONE)[keyof typeof STATUS_TONE];

export interface StatusMessage {
  readonly text: string;
  readonly tone: StatusTone;
}

export type StatusMessageListener = (message: StatusMessage | null) => void;

/**
 * 「直前の結果」1 個を持つ極小 pub/sub。**時間では消えない**（教訓 5.12 / K-7）。
 * スナップショットの同一性は保つ（同じ文言・同じ色味を押し込み直しても差し替えない）ので、
 * `useSyncExternalStore` に直接渡せる。
 */
export class StatusMessageStore {
  private message: StatusMessage | null = null;
  private readonly listeners = new Set<StatusMessageListener>();
  /**
   * 時刻の移動の知らせ（「○○年へ移動しました。」）の **後ろに続ける文**（増分 7 の手直し 2 回目 /
   * 設計適合 指摘 3・バグ狩り 2-4）。移動の知らせは時刻レールが描画のあとで出すので、移動と
   * 同時に起きたこと（居なくなった印を外した・その年に錨を作った）を先に出すと、すぐ
   * 上書きされて読めなかった。ここへ控えておき、移動の知らせが 1 つの文にまとめて出す。
   * 鍵はその時刻（別の時刻への知らせには付けない）。
   */
  private trailers: { readonly key: string; readonly text: string }[] = [];

  get(): StatusMessage | null {
    return this.message;
  }

  subscribe(listener: StatusMessageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 成功を出す。 */
  success(text: string): void {
    this.set(text, STATUS_TONE.Success);
  }

  /** 失敗・拒否の理由を出す（「何が起きたか → なぜか → 次に何をするか」の順）。 */
  failure(text: string): void {
    this.set(text, STATUS_TONE.Failure);
  }

  /** 進行中を出す。 */
  progress(text: string): void {
    this.set(text, STATUS_TONE.Progress);
  }

  /** 中立の結末を出す（やめた・何も変わらなかった）。 */
  notice(text: string): void {
    this.set(text, STATUS_TONE.Neutral);
  }

  /** 時刻 `key` への移動の知らせに続ける文を控える。 */
  stageMoveTrailer(key: string, text: string): void {
    if (text === '') return;
    this.trailers.push({ key, text });
  }

  /** 控えを全部捨てる（時刻が動くたびに、前の時刻の控えを残さない）。 */
  clearMoveTrailers(): void {
    this.trailers = [];
  }

  /**
   * 時刻 `key` への移動の知らせに続ける文を取り出す（取り出したら控えは全部捨てる）。
   * 無ければ空文字。
   */
  takeMoveTrailers(key: string): string {
    const text = this.trailers
      .filter((t) => t.key === key)
      .map((t) => t.text)
      .join('');
    this.trailers = [];
    return text;
  }

  set(text: string, tone: StatusTone): void {
    const current = this.message;
    if (current !== null && current.text === text && current.tone === tone) return;
    this.message = { text, tone };
    this.emit();
  }

  /**
   * 消す。**呼んでよいのは 2 つの契機だけ**: 利用者が閉じるボタンを押したとき、
   * プロジェクトを開き直したとき（設計書 §H.5）。無関係な操作から呼ばない（K-7）。
   */
  clear(): void {
    if (this.message === null) return;
    this.message = null;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.message);
  }
}
