// UI 層（地図）: 頂点の候補一覧の行と、地図の上の頂点を結びつける（増分 8A の手直し・設計適合 2-3）。
//
// **これが埋める穴**: 一覧の行は「頂点 #31797（61.49°S 3.64°W）」と距離しか言わないので、
// 密な所では **地図のどの点がその行か** が分からない。距離の近い順の先頭を選ぶなら、それは
// ドラッグで最寄りを掴むのと同じ結果になる。そこで行に乗っている（焦点がある）間、その頂点を
// 地図の上で輪で囲む。
//
// - 輪は画面の上で一定の大きさ（FR-17）。正距円筒図法なので、経緯度の円は画面の円である。
// - 描くのは線の命令（`line`）だけ。頂点の印（`handle` の `vertex`）にすると、頂点の印の数を
//   数える観測（`getVertexHandlePositions`）が 1 つ増えて見えてしまう。
// - canvas に描くので DOM の部品ではなく、K-2 の台帳の対象外（矩形選択の枠と同じ）。

import type { WorldCoordinate } from '../../domain/coordinate';
import type { Camera, DrawPrimitive, Viewport } from '../../render';

/** 輪の見た目。 */
export const CANDIDATE_HOVER_STYLE = {
  stroke: '#e65100',
  widthPx: 2,
  radiusPx: 11,
  segments: 24,
} as const;

/** 輪の描画命令（行に乗っていなければ空）。 */
export function candidateHoverPrimitives(
  hover: WorldCoordinate | null | undefined,
  view: { readonly camera: Camera; readonly viewport: Viewport },
): DrawPrimitive[] {
  if (hover === null || hover === undefined) return [];
  const zoom = view.camera.zoom;
  if (!Number.isFinite(zoom) || zoom <= 0) return [];
  const r = CANDIDATE_HOVER_STYLE.radiusPx / zoom; // 度
  const n = CANDIDATE_HOVER_STYLE.segments;
  const points: { lon: number; lat: number }[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = (2 * Math.PI * i) / n;
    points.push({ lon: hover.lon + r * Math.cos(t), lat: hover.lat + r * Math.sin(t) });
  }
  return [
    {
      kind: 'line',
      points,
      widthPx: CANDIDATE_HOVER_STYLE.widthPx,
      stroke: CANDIDATE_HOVER_STYLE.stroke,
    },
  ];
}

/** 編集ハンドルの層の getter を包み、輪を **いちばん上** に足す。 */
export function withCandidateHoverLayer(
  hover: () => WorldCoordinate | null | undefined,
  inner: (view: {
    readonly camera: Camera;
    readonly viewport: Viewport;
  }) => readonly DrawPrimitive[],
): (view: { readonly camera: Camera; readonly viewport: Viewport }) => readonly DrawPrimitive[] {
  return (view) => {
    const base = inner(view);
    const extra = candidateHoverPrimitives(hover(), view);
    return extra.length === 0 ? base : [...base, ...extra];
  };
}
