// ベクター背景地図 (FR-03 / FR-04 の地図資産のベクター表現) — 境界検証と型。
//
// WHY VECTOR (実測に基づく採用理由):
//   ラスター (PNG) の背景は、拡大すると引き伸ばされてぼやける。既定の最大ズーム 50 倍では
//   世界幅が 18,000px 相当になり、8192px の画像でも 2.2 倍に伸びる。ベクターなら解像度非依存。
//   しかも実測では **ベクターを焼く方が、焼いた画像を読むより速い**:
//     - 8192×4096 PNG のデコード+初回描画 = 162 ms
//     - 同じ地形をベクターから焼く         = 世界全体 19.8 ms / 10倍ズーム 5.6 ms
//   ゆえに「焼いた画像を保存して持ち回る」必要はない (キャッシュはメモリ上だけでよい)。
//
// FORMAT (なぜ点列でなく SVG パス定義か):
//   出界図は Illustrator 由来で曲線を含む。点列へサンプリングすると (a) 曲線が折れ線に落ちて
//   拡大時に角張り、(b) 十分な密度にするとデータが数倍に膨らむ。パス定義 (`d` 属性) をその
//   まま持てば、曲線は曲線のまま・データは 2.0MB (ZIP 圧縮前) に収まり、描画側は Path2D に
//   渡すだけでブラウザのネイティブ曲線ラスタライズに乗る。
//
// LAYER: domain (純粋・フレームワーク非依存)。ここは「バイト列 → 検証済みの値」までを担い、
// 実際のラスタライズは render 層 (`render/vector-base-map.ts`) の責務。

import { z } from 'zod';

/** このビルドが理解するベクター背景地図の形式識別子。 */
export const VECTOR_BASEMAP_KIND = 'tmap/basemap-vector@1' as const;

const finite = z.number().finite();

/**
 * 同じ塗り色を共有するパス群 (元 SVG のレイヤー単位)。描画は宣言順 = 奥から手前。
 */
export const vectorBaseMapLayerSchema = z
  .object({
    /** CSS 色 (`#rrggbb`)。 */
    fill: z.string().min(1),
    /** SVG のパス定義 (`d` 属性) の配列。 */
    paths: z.array(z.string().min(1)),
  })
  .strict();

/**
 * ベクター背景地図。`viewBox` は「SVG ユーザー座標のどの矩形が世界矩形 (経度 ±180 /
 * 緯度 ±90) に対応するか」を表し、これだけで SVG 座標 → 画面 の変換が決まる。
 */
export const vectorBaseMapSchema = z
  .object({
    kind: z.literal(VECTOR_BASEMAP_KIND),
    viewBox: z
      .object({
        x: finite,
        y: finite,
        width: finite.positive(),
        height: finite.positive(),
      })
      .strict(),
    /** 下地の色 (海)。パスを塗る前に全面を塗る。 */
    background: z.string().min(1),
    layers: z.array(vectorBaseMapLayerSchema),
  })
  .strict();

export type VectorBaseMap = z.infer<typeof vectorBaseMapSchema>;
export type VectorBaseMapLayer = z.infer<typeof vectorBaseMapLayerSchema>;

/**
 * 展開後の JSON テキストの上限 (64 MB)。ベースマップ資産のバイト上限と同じ考え方で、
 * 病的に大きいデータが JSON.parse でメインスレッドを止めるのを防ぐ。実データは 2 MB 級。
 */
export const MAX_VECTOR_BASEMAP_BYTES = 64 * 1024 * 1024;

/**
 * ベースマップ資産のバイト列がベクター背景地図なら検証済みの値を、そうでなければ `null` を返す。
 *
 * ベースマップ資産のスロットは 1 つで、そこにラスター画像とベクターのどちらも入りうる。
 * 呼び出し側はまずこれを試し、`null` なら従来どおり画像として扱う (画像側の
 * `checkBaseMapImageBytes` は PNG/JPEG のマジックを見るので、両者が取り違えられることはない)。
 *
 * R8: 外部入力はここで Zod 検証を通してからしかドメイン/描画へ入らない。壊れた JSON も
 * 形式違いも例外にせず `null` を返すので、呼び出し側は静かにラスター経路へ落ちられる。
 */
export function parseVectorBaseMap(bytes: Uint8Array): VectorBaseMap | null {
  if (bytes.length === 0 || bytes.length > MAX_VECTOR_BASEMAP_BYTES) return null;
  // 先頭が `{` でなければ JSON ですらない (画像バイト列を無駄にデコードしない早期判定)。
  if (bytes[0] !== 0x7b) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = vectorBaseMapSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
