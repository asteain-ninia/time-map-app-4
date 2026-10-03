// UI 層（地図）: 頂点の印が上限のせいで出ていないときの「理由」と［拡大］（増分 8A の中身 3 /
// 設計書 §E.1 V9・§H.5「次の一手をボタンにする」/ FR-110）。
//
// **これが埋める穴**: 選んだ地物の頂点が視野内に上限（既定 2,000）より多いと、頂点の印は
// 1 つも描かれない（FR-110 の性能の関門）。全体表示のまま「ヴィオニア大陸付近の領域01」
// （2,230 頂点）を選ぶとそうなるが、**理由も次の一手も出ていなかった**ので、利用者には
// 「頂点の道具が壊れている」としか見えない。
//
// - 理由はオプションバーの「次の一手」に出す（断りと同じ枠＝設計書 §H.5。新しい置き場を
//   作らない）。文は設計書 §E.1 V9 のとおり。
// - ［拡大］は **印が出るところまで**拡大する。視野の真ん中で拡大すると地物が画面の外へ
//   出て「視野内 0 個 ≤ 上限」で黙って止まりうる（印は出ないのに理由が消える）ので、
//   **画面の真ん中にいちばん近い、その地物の頂点**を動かない点にして拡大する。その頂点は
//   拡大しても画面の同じ所に居続けるので、視野内の数は 1 個より下がらない。
// - 1 押しで 1 段ではなく、出るまで段を重ねる（1 段＝鍵盤の Ctrl+= と同じ倍率。最大 30 段。
//   ズームの上限に当たったらそこで止める）。

import type { FeatureId } from '../../domain/ids';
import { computeHandles } from '../../domain/editing/handles';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import {
  worldToScreen,
  wrapTurnsForLonSpan,
  zoomStepAtCursor,
  type Camera,
  type ScreenPoint,
  type Viewport,
  type ZoomRange,
} from '../../render';
import type { DisplayControlInput } from '../../render/display-pipeline';

import { resolveDisplayFor } from './display-resolution-cache';
import { keyboardZoomFactor, viewportCentre } from './keyboard-zoom';
import { HANDLE_CAP_STRINGS } from './strings';

/** 画面に出る言葉（教訓 5.64）。文は設計書 §E.1 V9 のとおり。 */
export { HANDLE_CAP_STRINGS };

/** 「2,230」の形（桁区切り）。 */
const NUMBER_FORMAT = new Intl.NumberFormat('ja-JP');

/**
 * 次の一手の文。上限が 0 のとき・ズームの上限まで寄っているときは拡大を勧めない
 * （どちらも拡大しても印は出ない）。
 */
export function handleCapText(counted: number, cap: number, atMaxZoom = false): string {
  const c = NUMBER_FORMAT.format(counted);
  if (cap <= 0) return HANDLE_CAP_STRINGS.reasonCapZero(c);
  const k = NUMBER_FORMAT.format(cap);
  return atMaxZoom ? HANDLE_CAP_STRINGS.reasonAtMaxZoom(c, k) : HANDLE_CAP_STRINGS.reason(c, k);
}

/**
 * まだ拡大できるか（増分 8A の手直し・設計適合 2-4）。判定は［拡大］が段を重ねるときと
 * 同じ 1 本（{@link zoomUntilHandlesShow} の「次の段で倍率が上がるか」）を画面の真ん中で問う。
 */
export function canZoomInFurther(
  camera: Camera,
  viewport: Viewport,
  range: ZoomRange | undefined,
): boolean {
  const next = zoomStepAtCursor(
    camera,
    viewport,
    viewportCentre(viewport),
    keyboardZoomFactor('in'),
    range,
  );
  return next.zoom > camera.zoom;
}

/** ［拡大］で重ねる段の上限（1 段 ≒ 1.33 倍なので、30 段で 5,000 倍を超える）。 */
export const HANDLE_CAP_MAX_ZOOM_STEPS = 30;

/**
 * 地物の頂点のうち、**画面の真ん中にいちばん近いもの**の画面座標（±360° の複製も数える）。
 * 地物が無い・頂点が 1 つも画面に無ければ画面の真ん中を返す。
 */
export function featureAnchorNearCentre(
  root: DomainProject,
  time: TimePoint,
  displayControl: DisplayControlInput,
  featureId: FeatureId,
  view: { readonly camera: Camera; readonly viewport: Viewport },
): ScreenPoint {
  const centre = viewportCentre(view.viewport);
  const resolution = resolveDisplayFor(root, time, displayControl);
  const feature =
    resolution.areaFeaturesById.get(featureId) ??
    resolution.features.find((f) => f.id === featureId);
  if (feature === undefined) return centre;
  const turns = wrapTurnsForLonSpan(-180, 180, view.camera, view.viewport);
  const w = view.viewport.widthCss;
  const h = view.viewport.heightCss;
  let best: ScreenPoint | null = null;
  let bestD = Infinity;
  for (const handle of computeHandles(feature, resolution.vertices).vertices) {
    for (const turn of turns) {
      const s = worldToScreen(
        { lon: handle.position.lon + 360 * turn, lat: handle.position.lat },
        view.camera,
        view.viewport,
      );
      if (s.x < 0 || s.x > w || s.y < 0 || s.y > h) continue;
      const d = (s.x - centre.x) ** 2 + (s.y - centre.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
  }
  return best ?? centre;
}

/**
 * 印が出るところまで拡大したカメラを返す（書き込みは呼び出し側が 1 回だけ行う）。
 * `stillCapped` はそのカメラで「まだ上限を超えているか」を答える。`anchor` は動かない点。
 */
export function zoomUntilHandlesShow(input: {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly range: ZoomRange | undefined;
  readonly anchor: ScreenPoint;
  readonly stillCapped: (camera: Camera) => boolean;
  readonly maxSteps?: number;
}): Camera {
  const factor = keyboardZoomFactor('in');
  const max = input.maxSteps ?? HANDLE_CAP_MAX_ZOOM_STEPS;
  let cam = input.camera;
  for (let i = 0; i < max; i += 1) {
    if (!input.stillCapped(cam)) break;
    const next = zoomStepAtCursor(cam, input.viewport, input.anchor, factor, input.range);
    // ズームの上限に当たった（もう寄れない）ならそこで止める。
    if (!(next.zoom > cam.zoom)) break;
    cam = next;
  }
  return cam;
}
