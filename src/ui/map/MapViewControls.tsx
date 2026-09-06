// UI layer (U16 / 地図): 地図セルの中に常設で置く 2 つ（設計書 §B.5 の台帳 #10・#11）。
//
//   #10 ズームと全体表示 … 右下から 16px 内側。層は `pointer-events: none`、
//        **ボタンの矩形だけ** が押下を受ける（K-2 の 3 回の事故はすべて DOM の覆いが
//        原因だったので、覆いを作らない形にする）。
//   #11 縮尺バー … 下端中央から少し左、16px 内側。**押せない**（表示だけ）。
//
// **増分 5 では置かなかった**（司令塔の決定 2026-09-06）。増分 5 の中核は「地図から
// 押せる部品を無くす」ことで、そこへ新しい常設の押せる部品を足すのは向きが逆だった。
// 走査（`e2e/inc5-shell.spec.ts` の 5×5 の格子）が揃ったこの増分で置く。
//
// **押す先はコマンドの登録簿**である（メニュー・鍵盤とまったく同じ 1 本。教訓 5.13）。
// ここで直接カメラを触ると、同じ操作に 2 つ目の実装ができる。
//
// **読むだけでも使える**（拡大・縮小・全体表示は編集ではない）。

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { COMMAND_ID, type CommandRegistry } from '../shell/commands';
import type { SessionStore } from '../state/store';

import { chooseScaleBar } from './scale-bar';

/** 画面に出る言葉（教訓 5.64: 検査に直書きさせない）。 */
export const MAP_VIEW_CONTROL_STRINGS = {
  zoomIn: '地図を拡大',
  zoomOut: '地図を縮小',
  fitAll: '全体表示',
  scaleLabel: '縮尺',
} as const;

export interface MapViewControlsProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** コマンドの登録簿（メニュー・鍵盤と同じ 1 本を押す）。 */
  readonly registry: CommandRegistry;
}

export function MapViewControls<S>(props: MapViewControlsProps<S>): JSX.Element {
  const { store, registry } = props;
  // 60Hz で動く値（ズーム）は **この葉ノードだけ** が購読する（技術方針 2.3）。
  const zoom = useStore(store, (s) => s.camera.zoom);
  const equatorLengthKm = useStore(store, (s) => s.projectSettings.equatorLengthKm);
  // 登録簿は React の外なので、押せるかどうかは押す直前に読む（購読しない）。
  const bar = chooseScaleBar(zoom, equatorLengthKm);

  return (
    <>
      <div className="map-view-controls" data-testid="map-view-controls">
        <button
          type="button"
          className="map-view-controls__button"
          data-testid="map-zoom-in"
          aria-label={MAP_VIEW_CONTROL_STRINGS.zoomIn}
          title={MAP_VIEW_CONTROL_STRINGS.zoomIn}
          onClick={() => registry.dispatch(COMMAND_ID.ViewZoomIn)}
        >
          ＋
        </button>
        <button
          type="button"
          className="map-view-controls__button"
          data-testid="map-zoom-out"
          aria-label={MAP_VIEW_CONTROL_STRINGS.zoomOut}
          title={MAP_VIEW_CONTROL_STRINGS.zoomOut}
          onClick={() => registry.dispatch(COMMAND_ID.ViewZoomOut)}
        >
          −
        </button>
        <button
          type="button"
          className="map-view-controls__button"
          data-testid="map-fit-all"
          aria-label={MAP_VIEW_CONTROL_STRINGS.fitAll}
          title={MAP_VIEW_CONTROL_STRINGS.fitAll}
          onClick={() => registry.dispatch(COMMAND_ID.ViewFitAll)}
        >
          全体
        </button>
      </div>

      {/* #11 縮尺バー。**押せない**（`pointer-events: none`）。読めないズームでは
          バーごと出さない（「—」を描くと物差しとして嘘になる）。 */}
      {bar !== null && (
        <div className="map-scale-bar" data-testid="map-scale-bar" aria-hidden="true">
          <span className="map-scale-bar__label" data-testid="map-scale-bar-label">
            {bar.label}
          </span>
          <span
            className="map-scale-bar__rule"
            style={{ width: `${String(Math.round(bar.pixels))}px` }}
          />
        </div>
      )}
    </>
  );
}
