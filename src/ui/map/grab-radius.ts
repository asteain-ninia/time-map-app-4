// UI 層（地図）: 頂点・辺の中点・点・線を「掴める距離」（増分 8A の中身 1 / 設計書 §M-11 ①・§E.1 V9）。
//
// **これまで**は `live-hit-test.ts` の `DEFAULT_HIT_RADIUS_PX = 8` 固定だった。設計書は
// 「画面倍率に連動させ、下限を設ける（8px を下回らせない）」と決めている（§M-11 ①）。
// P1 案の「隣までの距離 × 0.45」は実データ（バアカ）で 1.09px まで縮み、狙えなくなるので採らない。
//
// **決めた形**（実装者がその場で決めたもの。進捗 増分8A.md §4）:
//   - 倍率は「世界全体表示（360°×180° がちょうど収まる倍率）の何倍か」で測る。
//   - 16 倍までは 8px（下限）。そこから倍率に比例して広げ、32 倍で 16px（上限）に止める。
//
// **なぜ 16 倍から広げるのか**: 実データの隣の頂点までの距離（中央値）は、世界全体表示で
// 0.40〜0.44px、×4 で 1.6〜1.75px、×16 で 6.4〜7.0px（2026-09-04 実測。設計書 §F.3）。
// 16 倍より手前で広げても **隣が余計に入るだけ**で、狙いやすくはならない（それは候補一覧の
// 仕事である。§E.1 V9 の「実データ密度では候補一覧が既定、拡大は補助」）。16 倍を超えると
// 隣は 8px より遠くなるので、そこから先は広げても隣を巻き込みにくく、的が大きくなるぶん
// 掴みやすい。
//
// **効き目は小さい**（正直に書く）: 既定のズーム上限は 50px/度で、地図が 900px 幅なら
// 世界全体表示はおよそ 2.5px/度なので、届く倍率は 20 倍前後である。つまり既定の設定では
// 半径はほぼ 8〜10px の範囲で動く。ズーム上限を上げたプロジェクトほど効く。
//
// 戻し方: `grabRadiusPx` が常に `GRAB_RADIUS_MIN_PX` を返すようにすれば元の 8px 固定に戻る。

import type { Camera, Viewport } from '../../render';

/** 掴める距離の下限（px）。旧 `DEFAULT_HIT_RADIUS_PX` と同じ値（設計書 §M-11 ①）。 */
export const GRAB_RADIUS_MIN_PX = 8;
/** 掴める距離の上限（px）。 */
export const GRAB_RADIUS_MAX_PX = 16;
/** ここまでの倍率（世界全体表示の何倍か）では下限のまま。 */
export const GRAB_RADIUS_GROW_FROM_RATIO = 16;

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
