// ベクター背景地図の「焼き直しをいつやるか」の判定 (ui/map, 純粋関数)。
//
// 方針 (ユーザー裁定 2026-08-09「ズーム時に焼き直し・焼き直しは初回のみ・ベクター地図が
// 更新されたときは全破棄」):
//   - 画面より一回り大きい世界矩形をまとめて焼く (バッキングストア)。余白の内側で収まる
//     パン・ズームは焼き直さず、既に焼いた画像をずらして描くだけで済む。
//   - ズームは半オクターブ単位の段階に量子化する。連続的なホイール操作で毎フレーム焼き
//     直さないため、かつ拡大しても段階が変わるまでは同じ画像を使い回せる。
//   - 焼く矩形は段階ごとのグリッドへスナップする。少し動かしただけで鍵が変わるのを防ぎ、
//     行き来しても同じ鍵に戻る (＝焼き直しは実質「その領域の初回のみ」)。
//   - ベクターデータ自体が変わったら鍵の前半 (データ識別子) が変わるので全破棄になる。
//
// ここは「どの矩形をどのピクセル寸法で焼くか」を決める純粋な判定だけを持つ。実際の
// 焼き付けは render 層 (`bakeVectorBaseMap`)、キャンバス生成は合成ルート (host-ports)。

import type { EquirectangularMeta } from '../../domain/basemap/preset';
import type { Camera, Viewport } from '../../render';

/**
 * 画面の外側に余分に焼く割合 (段階基準の画面幅・高さに対する比)。
 *
 * 余白は「スナップによる中心のずれ」を吸収しなければならない。焼く矩形の半幅は
 * `基準幅 × (1 + 2·PADDING) / 2`、中心は最大 `グリッド/2` ずれるので、
 * カメラ中心から確実に覆える半幅は `基準幅 × ((1 + 2·PADDING) − GRID_RATIO) / 2`。
 * これが画面の半幅 (最大で基準幅の半分) 以上である必要がある:
 *   (1 + 2·PADDING) − GRID_RATIO ≥ 1
 * 現在値 (0.3 / 0.4) では 1.6 − 0.4 = 1.2 で、2 割の余裕がある。
 */
export const VECTOR_BAKE_PADDING = 0.3;

/** スナップ格子の粗さ (段階基準の画面幅・高さに対する比)。上の不等式で余白と釣り合う。 */
export const VECTOR_BAKE_GRID_RATIO = 0.4;

/**
 * 焼き付け先の 1 辺の上限 (px) と総画素数の上限。メモリ (4 バイト/画素) と、ブラウザの
 * キャンバス寸法制限に対する安全弁。総画素 1,600 万 = 約 64 MB。
 */
export const MAX_VECTOR_BAKE_PX = 6144;
export const MAX_VECTOR_BAKE_PIXELS = 16_000_000;

/**
 * ズーム段階の細かさ: 1 オクターブあたりの段数 (4 = 1/4 オクターブ刻み)。
 * 細かいほど、段階内での解像度の余り (最大 2^(1/段数) 倍) が小さくなり、焼き付け先が
 * 小さく済む。代わりにズーム時の焼き直し回数が増えるが、1 回 6〜20ms なので影響は小さい。
 */
export const VECTOR_BAKE_ZOOM_STEPS = 4;

/** 一度に焼く領域と、その識別鍵。 */
export interface VectorBakePlan {
  /** 焼く世界矩形 (経度は連続値。±180 を跨いでよい)。 */
  readonly rect: EquirectangularMeta;
  readonly widthPx: number;
  readonly heightPx: number;
  /** 同じ鍵なら焼き直し不要 (データ識別子を含めるのは呼び出し側)。 */
  readonly key: string;
}

/** ズーム段階 (整数)。連続ズームを量子化して焼き直し回数を抑える。 */
export function vectorBakeZoomLevel(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 0;
  return Math.floor(Math.log2(zoom) * VECTOR_BAKE_ZOOM_STEPS);
}

/**
 * 段階の下限ズーム (px/度)。**焼く範囲の広さ**はこちらで決める。
 *
 * 実ズーム以上の値で範囲を決めると、焼く範囲が画面より狭くなり、そこにスナップのずれが
 * 加わって画面端が焼かれない (実機報告「画面端部分の地図表示がかなり消える」の原因)。
 * 段階の下限は必ず実ズーム以下なので、こちらを使えば範囲は必ず画面以上になる。
 */
export function vectorBakeSpanZoomFor(level: number): number {
  return Math.pow(2, level / VECTOR_BAKE_ZOOM_STEPS);
}

/**
 * 段階の上限ズーム (px/度)。**焼き付け解像度**はこちらで決める。
 * 実ズーム以上なので、画面 1 画素に対して焼いた画像が 1 画素以上を持ち、ぼやけない。
 */
export function vectorBakeZoomFor(level: number): number {
  return Math.pow(2, (level + 1) / VECTOR_BAKE_ZOOM_STEPS);
}

/**
 * 現在のカメラ・ビューポートに対して「どの矩形をどの寸法で焼くか」を決める。
 *
 * 経度方向は世界一周ぶん (360°) を超えないよう抑える: それ以上は同じ絵の繰り返しで、
 * 描画側がシーム複製 (FR-07) で並べてくれるため焼く意味がない。緯度方向は ±90 で頭打ち。
 * 退化したビューポート/カメラ (未計測の 0×0 など) では世界全体を最低解像度で焼く。
 */
export function planVectorBake(camera: Camera, viewport: Viewport): VectorBakePlan {
  const degenerate =
    !Number.isFinite(viewport.widthCss) ||
    !Number.isFinite(viewport.heightCss) ||
    viewport.widthCss <= 0 ||
    viewport.heightCss <= 0 ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0 ||
    !Number.isFinite(camera.centerLon) ||
    !Number.isFinite(camera.centerLat);
  if (degenerate) {
    const rect: EquirectangularMeta = {
      lonWest: -180,
      lonEast: 180,
      latNorth: 90,
      latSouth: -90,
    };
    return { rect, widthPx: 2048, heightPx: 1024, key: 'world:0' };
  }

  const level = vectorBakeZoomLevel(camera.zoom);
  const spanZoom = vectorBakeSpanZoomFor(level); // ≤ 実ズーム → 基準幅は画面以上
  const resZoom = vectorBakeZoomFor(level); // ≥ 実ズーム → 解像度は画面以上

  // 覆う度数は段階の**下限**ズームから決める。実ズームから決めると同じ段階の中でも
  // 矩形と画素寸法が動いて鍵が変わり毎回焼き直してしまい、上限ズームから決めると
  // 画面より狭くなって端が欠ける (どちらも単体テストで検出済み)。
  const padFactor = 1 + VECTOR_BAKE_PADDING * 2;
  const baseLonSpan = viewport.widthCss / spanZoom;
  const baseLatSpan = viewport.heightCss / spanZoom;
  const lonSpan = Math.min(360, baseLonSpan * padFactor);
  const latSpan = Math.min(180, baseLatSpan * padFactor);

  // 段階ごとのグリッドへスナップ — 少し動かしただけでは鍵が変わらない。粗さは余白と
  // 釣り合わせる (VECTOR_BAKE_PADDING の説明の不等式)。
  const gridLon = baseLonSpan * VECTOR_BAKE_GRID_RATIO;
  const gridLat = baseLatSpan * VECTOR_BAKE_GRID_RATIO;
  const cx = Math.round(camera.centerLon / gridLon) * gridLon;
  const cy = Math.round(camera.centerLat / gridLat) * gridLat;

  let latNorth = cy + latSpan / 2;
  let latSouth = cy - latSpan / 2;
  // 緯度は世界の外へはみ出さないよう平行移動してから切り詰める
  if (latNorth > 90) {
    latSouth -= latNorth - 90;
    latNorth = 90;
  }
  if (latSouth < -90) {
    latNorth += -90 - latSouth;
    latSouth = -90;
  }
  latNorth = Math.min(90, latNorth);
  latSouth = Math.max(-90, latSouth);

  const rect: EquirectangularMeta = {
    lonWest: cx - lonSpan / 2,
    lonEast: cx + lonSpan / 2,
    latNorth,
    latSouth,
  };

  // ピクセル寸法 = 度数 × 段階解像度 (1 辺と総画素数の両方で頭打ち)
  const rawW = (rect.lonEast - rect.lonWest) * resZoom;
  const rawH = (rect.latNorth - rect.latSouth) * resZoom;
  const shrink = Math.min(
    1,
    MAX_VECTOR_BAKE_PX / Math.max(rawW, rawH, 1),
    Math.sqrt(MAX_VECTOR_BAKE_PIXELS / Math.max(rawW * rawH, 1)),
  );
  const widthPx = Math.max(1, Math.round(rawW * shrink));
  const heightPx = Math.max(1, Math.round(rawH * shrink));

  return {
    rect,
    widthPx,
    heightPx,
    key: `${level}:${cx.toFixed(4)}:${cy.toFixed(4)}:${widthPx}x${heightPx}`,
  };
}
