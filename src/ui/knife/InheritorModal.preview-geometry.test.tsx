// HB4-1 回帰ロック — ユーザー実機報告 2026-07-03 D56:
// 「ナイフツール実行時、地物のプレビューが表示されない。四角だけ出る」
//
// 症状の正体は継承先選択モーダル (FR-93) の SVG プレビューであった。修正前:
//
//   viewBox = `${b.minX} ${-(b.minY + b.h)} ${b.w} ${b.h}`   ← y は **-lat 空間**
//   pathFor = `M${c.lon} ${c.lat}`                            ← y は **+lat 空間**
//
// 片の path 座標は y ∈ [minLat, maxLat] にあるのに、viewBox が写す y 窓は
// [-maxLat, -minLat] である。両者が重なるのは minLat ≤ 0 ≤ maxLat のとき、すなわち
// **赤道をまたぐ地物だけ**。北半球(あるいは南半球)に閉じた地物では二つの区間が完全に
// 分離するため、片の形は viewBox の外に落ちて 1 ピクセルも描かれない。
//
// 一方 `knife-smaller-box` の <rect> は y={-(sb.minY + sb.h)} と **-lat 空間で**
// 書かれているので viewBox 内に正しく入り、描画される。
// ⇒ 画面には「点線の赤い四角だけ」が残る = 報告そのもの。
//
// 既存の InheritorModal.test.tsx / knife-nway E2E が緑のままなのは、双方の
// フィクスチャが lat 0 近傍(既定カメラの画面中央 = 赤道)にあり、区間がたまたま
// 接する/重なる縮退ケースだったためである。
//
// 修正: `pathFor` を -lat 空間へ一本化し、<svg> の CSS `scaleY(-1)` を除去した
// (-lat 空間では SVG の y-down がそのまま「北が上」になるため、CSS 反転を残すと
// 二重反転で上下逆さになる)。
//
// 本テストは「プレビュー片の座標は viewBox の内側に入る」という描画の必要条件と、
// 「北が上」という向きの不変条件を数値で固定する(jsdom は SVG をレイアウトしない
// ので、d 属性・viewBox・style の関係を直接照合する)。
//
// 敵対レビュー fix-forward で以下を追加した(いずれもロック強度の穴):
//   #1 CSS クラス経由の scaleY(-1) — 末尾の knife.css ソース不変条件で塞ぐ。
//   #2 内包アサーションの符号非依存性 — 南半球の対称ケースで塞ぐ(pathFor と
//      viewBox を「両方 +lat に戻す」= 南が上 の退行は、内包テストが全て緑のまま
//      通ることを mutation で実測済み。捕まえるのは向きテストのみ)。
//   #3 d 属性パーサが指数表記を誤読する — 数値パターンを拡張し専用ケースを追加。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { GeoMultiPolygon } from '../../domain/geometry/types';

import { InheritorModal } from './InheritorModal';

afterEach(() => cleanup());

/** 南半球に閉じた 1 片(北半球ケースの鏡像; 緯度帯 40〜27°S). */
const SOUTHERN_PIECES: readonly GeoMultiPolygon[] = [
  [
    [
      [
        { lon: -69, lat: -40 },
        { lon: -60, lat: -40 },
        { lon: -60, lat: -27 },
        { lon: -69, lat: -27 },
      ],
    ],
  ],
];

/**
 * |lat| < 1e-6 の頂点。`pathFor` は `${-c.lat}` のテンプレート補間なので、この帯では
 * JS が **指数表記** (`-1e-7`) を出す。テスト側の d パーサが指数を読めないと
 * `-1` と誤読し、幾何アサーションが偽陽性/偽陰性になる(パーサ限定の脆弱性)。
 */
const TINY_LAT_PIECES: readonly GeoMultiPolygon[] = [
  [
    [
      [
        { lon: 0, lat: 1e-7 },
        { lon: 1, lat: 1e-7 },
        { lon: 1, lat: 3e-7 },
        { lon: 0, lat: 3e-7 },
      ],
    ],
  ],
];

/** 北半球に閉じた 2 片(実データ「トルエ巫術都市国」相当の緯度帯 27〜40°N). */
const NORTHERN_PIECES: readonly GeoMultiPolygon[] = [
  [
    [
      [
        { lon: -69, lat: 27 },
        { lon: -60, lat: 27 },
        { lon: -60, lat: 40 },
        { lon: -69, lat: 40 },
      ],
    ],
  ],
  [
    [
      [
        { lon: -60, lat: 27 },
        { lon: -52, lat: 27 },
        { lon: -52, lat: 40 },
        { lon: -60, lat: 40 },
      ],
    ],
  ],
];

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function renderModal(pieces: readonly GeoMultiPolygon[]): void {
  render(
    <InheritorModal
      pieces={pieces}
      smallestIndex={1}
      selectedIndex={1}
      onSelect={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
}

function viewBoxOf(): Box {
  const svg = screen.getByTestId('knife-preview');
  const raw = svg.getAttribute('viewBox');
  expect(raw).not.toBeNull();
  const [x, y, w, h] = raw!.trim().split(/\s+/).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return { x, y, w, h };
}

/**
 * Every numeric pair in a path `d` (`M`/`L` commands only, as `pathFor` emits).
 *
 * NOTE: the number pattern MUST accept exponent notation. `pathFor` interpolates
 * `${-c.lat}` and JS renders |x| < 1e-6 as `-1e-7`; a `-?[\d.]+` pattern would
 * read that back as `-1` and make every geometry assertion below lie.
 */
const NUM = String.raw`-?[\d.]+(?:[eE][-+]?\d+)?`;

function pathPoints(d: string): readonly { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const re = new RegExp(String.raw`[ML]\s*(${NUM})\s+(${NUM})`, 'g');
  let m = re.exec(d);
  while (m !== null) {
    out.push({ x: Number(m[1]), y: Number(m[2]) });
    m = re.exec(d);
  }
  return out;
}

describe('HB4-1 — 継承先モーダルのプレビュー片が viewBox 内に描かれる', () => {
  it('北半球の片: path 座標が viewBox の y 窓の内側にある', () => {
    renderModal(NORTHERN_PIECES);
    const vb = viewBoxOf();
    const yMin = vb.y;
    const yMax = vb.y + vb.h;

    for (let i = 0; i < NORTHERN_PIECES.length; i += 1) {
      const path = screen.getByTestId(`knife-preview-${String(i)}`);
      const d = path.getAttribute('d') ?? '';
      const pts = pathPoints(d);
      expect(pts.length, `piece ${String(i)} has no path points`).toBeGreaterThan(0);
      for (const p of pts) {
        // 描画の必要条件: viewBox はすべての片の bbox から作られているので、
        // どの片の座標も viewBox の内側に入っていなければならない。
        expect(
          p.y,
          `piece ${String(i)} point y=${String(p.y)} は viewBox y 窓 ` +
            `[${String(yMin)}, ${String(yMax)}] の外(= 描画されない)`,
        ).toBeGreaterThanOrEqual(yMin);
        expect(p.y).toBeLessThanOrEqual(yMax);
      }
    }
  });

  it('小さい方ボックス(rect)も同じ -lat 空間にあり viewBox 内に描画される', () => {
    renderModal(NORTHERN_PIECES);
    const vb = viewBoxOf();
    const rect = screen.getByTestId('knife-smaller-box');
    const ry = Number(rect.getAttribute('y'));
    const rh = Number(rect.getAttribute('height'));
    // rect は元から -lat 空間で書かれていた。修正前はこれ「だけ」が viewBox に
    // 収まっていたため、画面には赤い点線の四角しか残らなかった。
    expect(ry).toBeGreaterThanOrEqual(vb.y);
    expect(ry + rh).toBeLessThanOrEqual(vb.y + vb.h);
  });

  it('北が上: 高緯度の頂点ほど SVG y が小さく、CSS の二重反転が無い', () => {
    renderModal(NORTHERN_PIECES);
    // NORTHERN_PIECES の緯度帯は 27(南端)〜40(北端)。
    const pts = pathPoints(screen.getByTestId('knife-preview-0').getAttribute('d') ?? '');
    const ys = pts.map((p) => p.y);
    const northY = Math.min(...ys);
    const southY = Math.max(...ys);
    // SVG は y-down。北端が南端より「上」= y が小さい。
    expect(northY).toBeLessThan(southY);
    // 北端(lat 40)は -40、南端(lat 27)は -27 に写像されている必要がある。
    expect(northY).toBeCloseTo(-40, 9);
    expect(southY).toBeCloseTo(-27, 9);
    // -lat 空間なら CSS 反転は二重反転になる。掛かっていないことを固定する
    // (幾何アサーションだけでは上下逆さを検出できないため; 診断 §6 注意書き)。
    const svg = screen.getByTestId('knife-preview');
    expect(svg.getAttribute('style') ?? '').not.toMatch(/scaleY\s*\(\s*-/);
  });

  it('南半球でも北が上: 符号を +lat に戻す“修正”を検出する(対称ケース)', () => {
    // 指摘 #2 への対応。viewBox も path も同じ boundsOf 由来なので、内包アサーション
    // だけでは「pathFor と viewBox を両方 +lat に戻す」退行(= 南が上に描かれる)を
    // 検出できない。向きを固定するケースが北半球だけだったので鏡像を足す。
    // -lat 空間なら南半球の y は **正** になり、北端(lat -27)の y=27 が
    // 南端(lat -40)の y=40 より小さい。+lat 空間ではこれが -40 / -27 になり落ちる。
    renderModal(SOUTHERN_PIECES);
    const pts = pathPoints(screen.getByTestId('knife-preview-0').getAttribute('d') ?? '');
    const ys = pts.map((p) => p.y);
    const northY = Math.min(...ys);
    const southY = Math.max(...ys);
    expect(northY).toBeLessThan(southY);
    expect(northY).toBeCloseTo(27, 9);
    expect(southY).toBeCloseTo(40, 9);
    // 内包(viewBox 窓 [27, 40])も同時に満たすこと。
    const vb = viewBoxOf();
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(vb.y);
      expect(p.y).toBeLessThanOrEqual(vb.y + vb.h);
    }
  });

  it('指数表記(|lat| < 1e-6)の座標も取りこぼさずに読める', () => {
    // 指摘 #3 への対応。`String(-1e-7)` は "-1e-7" なので、パーサが指数を
    // 受け付けないと y=-1 と誤読し、viewBox 窓 [-1.1e-6, -1e-7] の外だと
    // 誤判定する(= 幾何アサーションが嘘をつく)。
    renderModal(TINY_LAT_PIECES);
    const d = screen.getByTestId('knife-preview-0').getAttribute('d') ?? '';
    expect(d, 'fixture must actually produce exponent notation').toMatch(/e-\d/i);
    const pts = pathPoints(d);
    expect(pts.length).toBe(4);
    const vb = viewBoxOf();
    // このスパン (2e-7) は boundsOf の下限 1e-6 にクランプされるので、窓の上端
    // `vb.y + vb.h` は数学的には -minLat ちょうどだが、`-(minY + h) + h` の丸めで
    // 1e-22 ほど下にずれる(指摘 #4 の縮退クランプ境界)。e2e と同じく窓の高さに
    // 比例した許容量で吸収する — 旧バグの誤読 (y=-1) は窓 1 個分どころか 6 桁
    // 外側なので、この eps でも取りこぼさない。
    const eps = Math.abs(vb.h) * 1e-9;
    for (const p of pts) {
      // 誤読していれば |y| は 1 以上になる。
      expect(Math.abs(p.y)).toBeLessThan(1e-6);
      expect(p.y).toBeGreaterThanOrEqual(vb.y - eps);
      expect(p.y).toBeLessThanOrEqual(vb.y + vb.h + eps);
    }
  });

  it('赤道をまたぐ片も viewBox 内に描かれる(修正前に緑だったケースのデグレ防止)', () => {
    const straddling: readonly GeoMultiPolygon[] = [
      [
        [
          [
            { lon: 0, lat: -10 },
            { lon: 5, lat: -10 },
            { lon: 5, lat: 10 },
            { lon: 0, lat: 10 },
          ],
        ],
      ],
    ];
    renderModal(straddling);
    const vb = viewBoxOf();
    const pts = pathPoints(screen.getByTestId('knife-preview-0').getAttribute('d') ?? '');
    const inside = pts.filter((p) => p.y >= vb.y && p.y <= vb.y + vb.h);
    // 赤道対称ケースは y 窓 [-10,10] と片の y 範囲が一致する縮退ケース。修正前は
    // これ「だけ」が偶然描かれており、既存テスト/E2E が緑だった理由でもある。
    expect(inside.length).toBe(pts.length);
  });
});

// 指摘 #1 への対応 — 向き不変条件の「CSS クラス経由」の抜け穴を塞ぐ。
//
// 上の向きテストと E2E は <svg> の **インライン** style しか見ていない。ところが
// 二重反転は `.knife-preview { transform: scaleY(-1) }` を knife.css に足すだけでも
// 起きる。そしてこの経路は jsdom では原理的に観測できない: vitest 設定に
// `css: true` は無く、knife.css を読み込むのは App.tsx なので、InheritorModal 単体
// レンダリングのドキュメントにスタイルシートが 1 枚も入らない(= `getComputedStyle`
// に切り替えてもインライン style と同じ結果しか返らず、穴は塞がらない)。
// よって **CSS ソースそのもの**を不変条件にする。実ブラウザ側の合成結果は
// e2e/knife-preview-north.spec.ts が `getComputedStyle` で照合する。
const knifeCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'knife.css'),
  'utf8',
);

/** `selector { body }` の組を全て返す(セレクタはカンマ区切りのまま). */
function cssRules(css: string): readonly { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m = re.exec(css);
  while (m !== null) {
    out.push({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' });
    m = re.exec(css);
  }
  return out;
}

describe('HB4-1 — プレビュー SVG に CSS 由来の反転が掛からない', () => {
  it('.knife-preview 系のルールが存在し、transform を一切持たない', () => {
    const rules = cssRules(knifeCss);
    // ルール抽出が壊れていない(= 空振りで緑になっていない)ことの自己検証。
    expect(rules.some((r) => /(^|,|\s)\.knife-preview\s*$/.test(r.selector))).toBe(true);

    const previewRules = rules.filter((r) => /\.knife-preview\b/.test(r.selector));
    for (const r of previewRules) {
      expect(
        r.body,
        `CSS ルール "${r.selector}" に transform がある。プレビューの幾何は既に ` +
          `-lat 空間(= SVG の y-down がそのまま北上)なので、ここに transform を ` +
          `足すと二重反転(上下逆さ)になり得る。意図的に必要なら、向きを目視 + ` +
          `e2e で再検証したうえで本テストを更新すること(HB4-1)。`,
      ).not.toMatch(/(^|;|\s)transform\s*:/);
    }
  });
});
