// UI 層（地図の入力）: 頂点や面を引いている最中の年の扱いを、地図の押下の層から宿主へ知らせる口。
//
// 引いたものは押した年に記録する。押下の状態を持つのは地図の入力の層（`PointerDispatcher`）で、
// 再生と状態行を持つのは宿主（`App`）なので、間をこの形でつなぐ。年を止める本体は
// `mount/input.ts` の関門（`store.setCurrentTime` の入口。描く 4 道具と同じ場所）。

import type { TimePoint } from '../../domain/time/time-point';
import type { TimeChangeSource } from '../state/store';

/** 引いていたものを記録せずに取り消した理由（止められずに年や書類が変わった）。 */
export const DRAG_CANCEL_CAUSE = {
  /** 設定で表示年の範囲が変わり、年が補正された。 */
  Time: 'time',
  /** ファイルを開いた・新規にした。 */
  Project: 'project',
  /** 取り消しなどで書類の中身が変わった。 */
  Document: 'document',
  /** 確認の板や作業の板、メニューが開いた（覆いの裏で離されても記録しない）。 */
  Board: 'board',
  /** 窓の焦点が外れた・窓が隠れた（別の窓で離されると、離した知らせは届かない）。 */
  WindowLeft: 'window-left',
  /** 離した知らせが届かないまま、ボタンを離したあとの移動か次の押下が来た。 */
  LostRelease: 'lost-release',
} as const;

export type DragCancelCause = (typeof DRAG_CANCEL_CAUSE)[keyof typeof DRAG_CANCEL_CAUSE];

export interface DragYearHost {
  /** 頂点・辺・面を掴んだ（再生中なら止める）。 */
  pressBegan(): void;
  /** 引いている最中に年を動かす操作が来て、止めた。 */
  timeMoveRefused(source: TimeChangeSource): void;
  /** 引いていたものを記録せずに取り消した。`time` はいまの年。 */
  cancelled(cause: DragCancelCause, time: TimePoint): void;
}
