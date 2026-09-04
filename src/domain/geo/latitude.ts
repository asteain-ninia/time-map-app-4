// Domain layer (U05 / geo): **世界の緯度の範囲**（増分 3 の手直し A6。バグ狩り #3）。
//
// 経度は周期的なので折り返す（`./longitude`）が、**緯度は周期的ではない** ―― 北極の上にも
// 南極の下にも場所は無い。ところが画面→世界の逆変換は緯度を切り詰めないので、地図セルの
// 上端（全体表示では緯度 120 度に相当することがある）を押すと、**北緯 120 度の頂点**が
// そのまま置けてしまう。実際にバグ狩りで「極の外」という名前の四角形（緯度 103〜118 度、
// 面積 1,475 万 km²）が作れた。
//
// おかしいのは、**状態行は同じ場所で座標を「—」と出している**ことである
// （`ui/shell/cursor-position.ts` が「北緯 120 度は場所ではない」として非表示にする）。
// 「座標が読めない場所なのにクリックは通る」という食い違いを、この 1 本で閉じる。
//
// 切り詰め（clamp）ではなく **断る** のは、切り詰めると利用者が押した場所と違う所に点が
// 置かれるからである（黙って別の形になる。教訓 5.22 の趣旨）。カメラの中心緯度だけは
// 切り詰めてよい（見え方の話で、記録には残らない）ので、そちらは `render/camera.ts` の
// `clampLat` が引き続き担当する ―― **境界の値はこの module が持つ 1 組だけ**である。
//
// 純粋（I/O・時計・乱数なし）。

/** 世界の緯度の下限・上限（度）。南極 −90 / 北極 +90 を含む。 */
export const WORLD_LAT_MIN_DEG = -90;
export const WORLD_LAT_MAX_DEG = 90;

/**
 * その緯度が世界の中にあるか（±90 度ちょうどは **中**）。有限でない値は外とみなす。
 */
export function isWorldLatitude(lat: number): boolean {
  return Number.isFinite(lat) && lat >= WORLD_LAT_MIN_DEG && lat <= WORLD_LAT_MAX_DEG;
}

/**
 * 緯度を世界の範囲へ切り詰める（**見え方のためだけ**に使う。記録する座標には使わない）。
 * `render/camera.ts` の `clampLat` はこれを呼ぶ ―― 境界の値の定義は 1 か所だけである。
 */
export function clampWorldLat(lat: number): number {
  if (lat < WORLD_LAT_MIN_DEG) return WORLD_LAT_MIN_DEG;
  if (lat > WORLD_LAT_MAX_DEG) return WORLD_LAT_MAX_DEG;
  return lat;
}
