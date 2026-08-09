// ベクター背景地図のラスタライズ (焼き付け) — render 層。
//
// 役割は「検証済みのベクター背景地図 (domain/basemap/vector) を、指定した世界矩形ぶんだけ
// 指定ピクセル寸法のキャンバスへ焼く」こと。焼いた結果は `CanvasImageSource` として既存の
// ベースマップ描画経路 (`buildBaseMapPrimitive` → `drawBaseMap`) にそのまま乗るので、
// シーム跨ぎの複製 (FR-07) もヒットテスト非対象 (FR-06) も従来と同じ扱いになる。
//
// PURITY / TESTABILITY: 実 Canvas ではなく最小限のインタフェース {@link VectorBakeTarget} に
// 対して命令を出すだけなので、偽コンテキストで単体検証できる (NFR 5.8 / 教訓 5.41)。
// Path2D の生成はブラウザ依存なので呼び出し側 (ui) が用意した不透明なパス値を受け取る。

import type { EquirectangularMeta } from '../domain/basemap/preset';
import type { VectorBaseMap } from '../domain/basemap/vector';

/**
 * 焼き付け先が満たすべき最小のインタフェース (Canvas 2D の部分集合)。
 *
 * `fillStyle` は実 Canvas 側がグラデーション等も受ける union 型なので、こちらは
 * 「CSS 色文字列を書ければよい」という書き込み側の要求だけを表す (実 Canvas も偽実装も
 * この形に代入できる)。
 */
export interface VectorBakeTarget {
  /** 塗り色 (CSS 色)。 */
  fillStyle: string | CanvasGradient | CanvasPattern;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  /** 不透明なパス値 (ブラウザでは Path2D) を塗る。 */
  fill(path: unknown): void;
}

/** 塗り色ごとにまとめた、生成済みパス値の束 (Path2D は使い回すと速い)。 */
export interface PreparedVectorLayer {
  readonly fill: string;
  readonly paths: readonly unknown[];
}

/** 焼き付けに使う準備済みデータ (パス生成は 1 度きり)。 */
export interface PreparedVectorBaseMap {
  readonly map: VectorBaseMap;
  readonly layers: readonly PreparedVectorLayer[];
}

/**
 * ベクター背景地図の各パスを Path2D 等の不透明値へ 1 度だけ変換して束ねる。
 * `createPath` はブラウザでは `(d) => new Path2D(d)`。
 */
export function prepareVectorBaseMap(
  map: VectorBaseMap,
  createPath: (d: string) => unknown,
): PreparedVectorBaseMap {
  return {
    map,
    layers: map.layers.map((layer) => ({
      fill: layer.fill,
      paths: layer.paths.map((d) => createPath(d)),
    })),
  };
}

/**
 * SVG ユーザー座標 → 焼き付け先ピクセル座標 のアフィン変換。
 *
 * `viewBox` の矩形が世界矩形 (経度 −180..180 / 緯度 90..−90) に線形対応する、という
 * 1 つの規約だけから導かれる (両者とも正距円筒なので変換は純粋なスケール+平行移動)。
 * 退化した入力 (幅 0 の矩形など) では恒等変換を返し、呼び出し側が落ちないようにする。
 */
export function vectorBakeTransform(
  map: VectorBaseMap,
  rect: EquirectangularMeta,
  widthPx: number,
  heightPx: number,
): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
  const lonSpan = rect.lonEast - rect.lonWest;
  const latSpan = rect.latNorth - rect.latSouth;
  const vb = map.viewBox;
  if (
    !Number.isFinite(lonSpan) ||
    !Number.isFinite(latSpan) ||
    lonSpan === 0 ||
    latSpan === 0 ||
    widthPx <= 0 ||
    heightPx <= 0
  ) {
    return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  }
  // 経度: lon = (svgX − vb.x) / vb.width × 360 − 180
  //       px  = (lon − rect.lonWest) / lonSpan × widthPx
  const scaleX = (360 * widthPx) / (vb.width * lonSpan);
  const offsetX = (((-vb.x * 360) / vb.width - 180 - rect.lonWest) * widthPx) / lonSpan;
  // 緯度: lat = 90 − (svgY − vb.y) / vb.height × 180
  //       py  = (rect.latNorth − lat) / latSpan × heightPx
  const scaleY = (180 * heightPx) / (vb.height * latSpan);
  const offsetY = ((rect.latNorth - 90 - (vb.y * 180) / vb.height) * heightPx) / latSpan;
  return { scaleX, scaleY, offsetX, offsetY };
}

/**
 * `rect` が覆う世界矩形ぶんを `widthPx × heightPx` の焼き付け先へ描く。
 *
 * 手順は「下地 (海) を全面に塗る → レイヤー順にパスを塗る」だけ。画面外のパスはブラウザ側で
 * 捨てられるため、拡大するほど安くなる (実測: 世界全体 19.8ms / 10倍ズーム 5.6ms)。
 */
export function bakeVectorBaseMap(
  target: VectorBakeTarget,
  prepared: PreparedVectorBaseMap,
  rect: EquirectangularMeta,
  widthPx: number,
  heightPx: number,
): void {
  // 下地 (海)。変換を恒等に戻してから全面を塗る。
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.fillStyle = prepared.map.background;
  target.fillRect(0, 0, widthPx, heightPx);

  const t = vectorBakeTransform(prepared.map, rect, widthPx, heightPx);
  target.setTransform(t.scaleX, 0, 0, t.scaleY, t.offsetX, t.offsetY);
  for (const layer of prepared.layers) {
    target.fillStyle = layer.fill;
    for (const path of layer.paths) target.fill(path);
  }
  // 呼び出し側が続けて描く場合に備えて変換を戻す。
  target.setTransform(1, 0, 0, 1, 0, 0);
}
