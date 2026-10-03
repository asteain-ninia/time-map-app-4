// UI 層（地図）: 矩形選択の枠（増分 8A の中身 4 / 現状分析 N-07 / FR-80）。
//
// **これが埋める穴**: 空いた所から左ドラッグすると頂点を矩形で選べる（FR-80。`live-selection-port`
// が解放の瞬間に U22 の reducer へ渡す）が、**ドラッグ中に枠が一切描かれていなかった**
// （描く層そのものが無かった）。どこまでを囲んでいるのかが見えないまま離すことになる。
//
// 形: 選択の口（SelectionPort）を包み、**空いた所の押下**から始まったドラッグのあいだだけ
// 「押した点と今の点」を一時状態に持つ。描画側はそれを読んで、編集ハンドルの層に枠を足す。
//
// - 枠は **世界座標の矩形**として描く。正距円筒図法なので経緯度の矩形は画面の矩形と同じで、
//   しかも U22 の矩形選択（`verticesInRectangle`）が判定に使うのは **まさにこの経緯度の矩形**
//   である ―― 見えている枠と、選ばれる範囲が一致する（教訓 5.29）。
// - 出すのはクリック／ドラッグのしきい値を越えてから（ディスパッチャと同じ 1 本＝教訓 5.30）。
//   しきい値の内側の揺れでは枠を描かない（解放してもクリックとして扱われるので）。
// - 解放・取り消し・道具の持ち替え（ディスパッチャが `cancel` を呼ぶ）のどれでも必ず消す
//   （教訓 5.2）。
// - canvas に描くので DOM の部品ではなく、K-2 の台帳の対象外（設計書 §B.5 の注記）。

import { HIT_KIND, type HitResult } from '../../domain/selection';
import {
  screenToWorld,
  type Camera,
  type DrawPrimitive,
  type ScreenPoint,
  type Viewport,
} from '../../render';

import { exceedsDragThreshold } from './dispatch';
import type { PointerModifiers, SelectionPort } from './ports';

/** ドラッグ中の矩形（地図の入力層の左上からの画面座標）。 */
export interface RubberBand {
  readonly from: ScreenPoint;
  readonly to: ScreenPoint;
}

/** 枠の見た目。線は画面上で一定の太さ（FR-17）。 */
export const RUBBER_BAND_STYLE = {
  stroke: '#1565c0',
  widthPx: 1.5,
  dashPx: [5, 3] as readonly number[],
  fill: 'rgba(21, 101, 192, 0.08)',
} as const;

/**
 * 選択の口を包み、空いた所からのドラッグの間だけ矩形を `onChange` へ流す。
 * `onChange(null)` は「枠を消す」。元の口の振る舞いは 1 つも変えない（呼ぶ順も同じ）。
 */
export function withRubberBand(
  port: SelectionPort,
  onChange: (band: RubberBand | null) => void,
): SelectionPort {
  let origin: ScreenPoint | null = null;
  let shown = false;
  const clear = (): void => {
    origin = null;
    if (!shown) return;
    shown = false;
    onChange(null);
  };
  return {
    start(hit: HitResult, point: ScreenPoint, modifiers: PointerModifiers): void {
      clear();
      // 矩形になるのは **空いた所の押下**だけ（頂点・本体・辺の押下のドラッグは
      // 編集ドラッグの持ち物で、選択の口は何も選ばない＝`live-selection-port` の規則）。
      if (hit.kind === HIT_KIND.Empty) origin = point;
      port.start(hit, point, modifiers);
    },
    move(point: ScreenPoint): void {
      port.move(point);
      if (origin === null) return;
      if (!shown && !exceedsDragThreshold(origin.x, origin.y, point.x, point.y)) return;
      shown = true;
      onChange({ from: origin, to: point });
    },
    end(point: ScreenPoint, wasDrag: boolean): void {
      clear();
      port.end(point, wasDrag);
    },
    cancel(): void {
      clear();
      port.cancel();
    },
  };
}

/**
 * 編集ハンドルの層の getter を包み、枠を **いちばん上**に足す（ハンドルより上 ―― 囲んでいる
 * 範囲が掴む的に隠れないように）。枠は道具の状態に依らず、ドラッグ中だけ描かれる。
 */
export function withRubberBandLayer(
  band: () => RubberBand | null | undefined,
  inner: (view: {
    readonly camera: Camera;
    readonly viewport: Viewport;
  }) => readonly DrawPrimitive[],
): (view: { readonly camera: Camera; readonly viewport: Viewport }) => readonly DrawPrimitive[] {
  return (view) => {
    const base = inner(view);
    const extra = rubberBandPrimitives(band(), view);
    return extra.length === 0 ? base : [...base, ...extra];
  };
}

/**
 * 枠の描画命令（世界座標）。薄い塗りと破線の縁の 2 つ。`band` が無ければ空。
 * 変換はレンダラの逆変換そのもの（当たり判定・矩形選択と同じ 1 本＝教訓 5.29）。
 */
export function rubberBandPrimitives(
  band: RubberBand | null | undefined,
  view: { readonly camera: Camera; readonly viewport: Viewport },
): DrawPrimitive[] {
  if (band === null || band === undefined) return [];
  const a = screenToWorld(band.from, view.camera, view.viewport);
  const b = screenToWorld(band.to, view.camera, view.viewport);
  const ring = [
    { lon: a.lon, lat: a.lat },
    { lon: b.lon, lat: a.lat },
    { lon: b.lon, lat: b.lat },
    { lon: a.lon, lat: b.lat },
  ];
  return [
    { kind: 'polygon', ring, fill: RUBBER_BAND_STYLE.fill },
    {
      kind: 'line',
      points: [...ring, ring[0]!],
      widthPx: RUBBER_BAND_STYLE.widthPx,
      stroke: RUBBER_BAND_STYLE.stroke,
      dashPx: RUBBER_BAND_STYLE.dashPx,
    },
  ];
}
