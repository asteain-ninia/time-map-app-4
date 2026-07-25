// キーボードズーム (表示 → 拡大 / 縮小, Ctrl+= / Ctrl+-) の算出.
//
// ズーム算出は **ホイールと同じ一本道** = U17 の `zoomStepAtCursor`（倍率ステップ＋
// FR-10 クランプ）。この単位が足すのは2点だけ:
//   1. アンカーがカーソルではなく **ビューポート中心**（キーボード操作にカーソルは無い。
//      中心固定なので押し続けても視点が流れない）。
//   2. 1押下 = ホイール {@link KEYBOARD_ZOOM_NOTCHES} ノッチ分の倍率（独自の倍率定数を
//      作らず、ホイールの1ノッチ倍率の整数乗にする — 単一真実源）。
//
// 対比: Electron 既定メニューの zoomIn/zoomOut ロールは **ページ** ズーム（CSS px 尺度
// そのものを変える）で、FR-16 の座標対応と地図ズームの真実源を壊す。アプリは同じ chord を
// 地図ズームへ向ける（app-menu.ts が既定メニューを外すことで初めて chord が届く）。

import { WHEEL_ZOOM_FACTOR } from './PointerDispatcher';
import {
  zoomStepAtCursor,
  type Camera,
  type ScreenPoint,
  type Viewport,
  type ZoomRange,
} from '../../render';

/** 1押下が相当するホイールノッチ数（1ノッチだと体感が細かすぎるため 3 ノッチ）。 */
export const KEYBOARD_ZOOM_NOTCHES = 3;

export type ZoomDirection = 'in' | 'out';

/** 1押下ぶんの倍率。`in` と `out` は互いに逆数（往復すると元の倍率へ戻る）。 */
export function keyboardZoomFactor(direction: ZoomDirection): number {
  const notches = direction === 'in' ? KEYBOARD_ZOOM_NOTCHES : -KEYBOARD_ZOOM_NOTCHES;
  return Math.pow(WHEEL_ZOOM_FACTOR, notches);
}

/** ズームのアンカー = ビューポートの CSS px 中心。未計測(0×0)でも有限値を返す。 */
export function viewportCentre(viewport: Viewport): ScreenPoint {
  return { x: viewport.widthCss / 2, y: viewport.heightCss / 2 };
}

/**
 * キーボード1押下ぶんズームした新しいカメラ。中心の世界座標は不変（`zoomStepAtCursor` の
 * アンカー不変条件）で、`range` を渡せば FR-10 クランプが効く。純粋関数。
 */
export function keyboardZoomCamera(
  camera: Camera,
  viewport: Viewport,
  direction: ZoomDirection,
  range?: ZoomRange,
): Camera {
  return zoomStepAtCursor(
    camera,
    viewport,
    viewportCentre(viewport),
    keyboardZoomFactor(direction),
    range,
  );
}
