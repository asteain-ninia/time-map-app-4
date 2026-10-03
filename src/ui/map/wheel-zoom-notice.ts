// UI 層（地図）: **ホイール** でもズームの上下限を超えた操作を理由つきで断る（増分 8E の手直し /
// G-21。設計適合 S2-5・GPT 重 2）。
//
// 最初の版はボタン・鍵盤・メニュー（`zoomMapRef` を通るもの）だけに理由を出し、ホイールは
// 対象外にしていた（1 回の回転で何ノッチも来るので、状態行が書き換わり続けると考えた）。
// だが地図を拡大縮小するいちばん多い手段はホイールで、上限で黙るのはホイールの利用者が
// いちばん多い。そこで:
//   - **脇の文**（ズームボタンの脇）は、ボタンと同じく断るたびに出す。置き場
//     （`ZoomLimitNoteStore.show`）が同じ文・同じ倍率を間引くので、何ノッチ来ても 1 度しか
//     変わらない。
//   - **状態行** は **1 回の回転（連続したホイール操作のまとまり）につき 1 度だけ** 出す。
//     まとまりは「前のノッチから {@link WHEEL_GESTURE_GAP_MS} ミリ秒以内に次のノッチが来た」
//     で続いているとみなす（断ったノッチだけでなく、動いたノッチもまとまりを続ける）。
//
// 判定と文はボタンと同じ `zoomLimitRefusal` の 1 本を通す（教訓 5.29）。ズームの処理
// （`PointerDispatcher.wheel` のステップとクランプ）は書き換えない ―― ノッチごとに呼ばれる
// 口（`onWheelZoom`）を 1 つ足しただけである（依頼書の制約 3。8A もホイールを触っている）。

import type { ZoomDirection } from './keyboard-zoom';
import {
  zoomLimitRefusal,
  type ZoomLimitNoteStore,
  type ZoomLimitRange,
  type ZoomLimitSettings,
} from './zoom-limit-notice';

/** これより間が空いたら、次のノッチは新しい回転（まとまり）とみなす。 */
export const WHEEL_GESTURE_GAP_MS = 400;

/**
 * 1 回の回転につき 1 度だけ「言ってよい」と答える小さな数え役。時計は差し替えられる
 * （単体試験で回転の区切りを作るため）。
 */
export class WheelGestureGate {
  private lastAt = Number.NEGATIVE_INFINITY;
  private announced = false;

  constructor(private readonly now: () => number) {}

  /**
   * ノッチ 1 つを数える。`refused` は、このノッチを上下限で断ったか。
   * 状態行に出してよい（この回転でまだ出していない断り）なら true。
   */
  notch(refused: boolean): boolean {
    const t = this.now();
    if (t - this.lastAt > WHEEL_GESTURE_GAP_MS) this.announced = false;
    this.lastAt = t;
    if (!refused || this.announced) return false;
    this.announced = true;
    return true;
  }
}

/** {@link createWheelZoomNotice} の入力。 */
export interface WheelZoomNoticeDeps {
  /** 文に出す、利用者が設定した倍率（その時点の値を読む）。 */
  readonly settings: () => ZoomLimitSettings;
  /** ズームボタンの脇の文の置き場（ボタンと同じもの）。 */
  readonly noteStore: ZoomLimitNoteStore;
  /** 状態行へ「できなかった」を出す口。 */
  readonly announce: (status: string) => void;
  /** 時計（既定は `performance.now`）。 */
  readonly now?: () => number;
}

/**
 * ホイールの 1 ノッチごとに呼ぶ口を作る。上下限に着いていてさらに回したノッチなら、
 * 脇の文を出し、その回転でまだなら状態行にも出す。
 */
export function createWheelZoomNotice(
  deps: WheelZoomNoticeDeps,
): (direction: ZoomDirection, zoomBefore: number, range: ZoomLimitRange) => void {
  const gate = new WheelGestureGate(deps.now ?? (() => performance.now()));
  return (direction, zoomBefore, range) => {
    const refusal = zoomLimitRefusal(direction, zoomBefore, range, deps.settings());
    const say = gate.notch(refusal !== null);
    if (refusal === null) return;
    deps.noteStore.show(refusal.side, zoomBefore);
    if (say) deps.announce(refusal.status);
  };
}
