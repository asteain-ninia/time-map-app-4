// UI 層（地図）: 頂点・辺の中点・点・線を「掴める距離」（増分 8A の中身 1 / 設計書 §M-11 ①・§E.1 V9）。
//
// **これまで**は `live-hit-test.ts` の `DEFAULT_HIT_RADIUS_PX = 8` 固定だった。設計書は
// 「画面倍率に連動させ、下限を設ける（8px を下回らせない）」と決めている（§M-11 ①）。
// P1 案の「隣までの距離 × 0.45」は実データ（バアカ）で 1.09px まで縮み、狙えなくなるので採らない。
//
// **決めた形**（実装者がその場で決めたもの。進捗 増分8A.md §4。手直しで数を改めた）:
//   - 倍率は「世界全体表示（360°×180° がちょうど収まる倍率）の何倍か」で測る。
//   - 64 倍までは 8px（下限）。そこから倍率に比例して広げ、128 倍で 16px（上限）に止める。
//
// **既定のズーム範囲では 8px のまま**（増分 8A の手直し・設計適合 2-1）。当初は 16 倍から
// 広げていたが、実データの隣の頂点までの距離（中央値）は倍率にほぼ比例する（世界全体表示で
// 0.40〜0.44px、×16 で 6.4〜7.0px。設計書 §F.3）ので、16 倍から先で半径も比例させると
// 「半径 ÷ 隣までの距離」が約 1.2 のまま変わらず、**どこまで寄っても隣が掴める距離に残り**、
// 頂点をクリックするたびに候補一覧が出ていた（バアカでズームの上限まで寄って半径 9.87px、
// 隣まで 8.69px）。8px 固定なら寄れば隣は外れ、一覧なしで直接クリックできる。
//
// 64 倍にした理由: 既定のズームの上限は 50px/度（`DEFAULT_ZOOM_RANGE.maxZoom`）。世界全体表示の
// 倍率は min(地図の幅/360, 地図の高さ/180) なので、50px/度が 64 倍を超えるのは地図の幅が
// 281px より狭いときだけである（窓の最小幅は 800px）。ズームの上限を上げたプロジェクトでだけ
// 広がる。設計書 §M-11 ① の「倍率に連動させ、下限 8px を下回らせない」の本旨は縮めないこと
// （P1 案の「隣までの距離 × 0.45」が 1.09px まで縮んだことへの答え）なので、これで満たす。
//
// 戻し方: `GRAB_RADIUS_GROW_FROM_RATIO` を 16 に戻せば手直し前の曲線（32 倍で 16px）。
// `grabRadiusPx` が常に `GRAB_RADIUS_MIN_PX` を返すようにすれば元の 8px 固定に戻る。

import type { Camera, Viewport } from '../../render';

/** 掴める距離の下限（px）。旧 `DEFAULT_HIT_RADIUS_PX` と同じ値（設計書 §M-11 ①）。 */
export const GRAB_RADIUS_MIN_PX = 8;
/** 掴める距離の上限（px）。 */
export const GRAB_RADIUS_MAX_PX = 16;
/** ここまでの倍率（世界全体表示の何倍か）では下限のまま。既定のズーム範囲はこの内側。 */
export const GRAB_RADIUS_GROW_FROM_RATIO = 64;

/**
 * 世界全体表示の倍率（CSS px / 度）。360°×180° がちょうど収まる値で、ビューポートの
 * 大きさだけで決まる（プロジェクトのズーム範囲の設定は見ない ―― 設定を変えると
 * 掴める距離が変わる、を作らない）。測れていない（0 以下・非有限）ときは 0。
 */
export function worldFitZoom(viewport: Viewport): number {
  const w = viewport.widthCss;
  const h = viewport.heightCss;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return Math.min(w / 360, h / 180);
}

/**
 * いまの画面での掴める距離（CSS px）。下限 {@link GRAB_RADIUS_MIN_PX}、
 * 上限 {@link GRAB_RADIUS_MAX_PX}。カメラやビューポートが測れていないときは下限を返す。
 */
export function grabRadiusPx(camera: Camera, viewport: Viewport): number {
  const fit = worldFitZoom(viewport);
  const zoom = camera.zoom;
  if (fit <= 0 || !Number.isFinite(zoom) || zoom <= 0) return GRAB_RADIUS_MIN_PX;
  const ratio = zoom / fit;
  const grown = (GRAB_RADIUS_MIN_PX * ratio) / GRAB_RADIUS_GROW_FROM_RATIO;
  return Math.min(GRAB_RADIUS_MAX_PX, Math.max(GRAB_RADIUS_MIN_PX, grown));
}
