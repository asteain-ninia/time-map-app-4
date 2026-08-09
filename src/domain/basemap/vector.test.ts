// ベクター背景地図の境界検証 (R8: 外部入力は検証を通ってからしかドメインへ入らない)。
//
// ベースマップ資産のスロットは 1 つで、ラスター画像とベクターのどちらも入りうる。
// ここでの契約は「ベクターならその値を、そうでなければ null を返し、決して throw しない」
// こと — 呼び出し側 (host-ports) は null を見て静かにラスター経路へ落ちる。

import { describe, expect, it } from 'vitest';

import {
  MAX_VECTOR_BASEMAP_BYTES,
  VECTOR_BASEMAP_KIND,
  parseVectorBaseMap,
} from './vector';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

const VALID = {
  kind: VECTOR_BASEMAP_KIND,
  viewBox: { x: 5.26, y: 0.5, width: 4243.4, height: 2121.7 },
  background: '#556fb5',
  layers: [{ fill: '#7fb86e', paths: ['M0,0H10V10H0Z'] }],
};

describe('parseVectorBaseMap', () => {
  it('妥当なベクター背景地図を受け入れる', () => {
    const map = parseVectorBaseMap(encode(VALID));
    expect(map).not.toBeNull();
    expect(map?.viewBox.width).toBe(4243.4);
    expect(map?.layers[0]?.paths[0]).toBe('M0,0H10V10H0Z');
  });

  it('PNG のバイト列は null (= ラスター経路) — 先頭バイトで即座に判定する', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(parseVectorBaseMap(png)).toBeNull();
  });

  it('空のバイト列は null', () => {
    expect(parseVectorBaseMap(new Uint8Array())).toBeNull();
  });

  it('壊れた JSON でも throw せず null', () => {
    expect(parseVectorBaseMap(new TextEncoder().encode('{"kind":'))).toBeNull();
  });

  it('UTF-8 として不正なバイト列でも throw せず null', () => {
    // 先頭は '{' だが後続が不正な継続バイト
    expect(parseVectorBaseMap(new Uint8Array([0x7b, 0xff, 0xfe]))).toBeNull();
  });

  it('形式識別子が違えば null (将来形式を取り違えない)', () => {
    expect(parseVectorBaseMap(encode({ ...VALID, kind: 'tmap/basemap-vector@2' }))).toBeNull();
  });

  it('未知のキーがあれば null (strict — 宣言していないものを通さない)', () => {
    expect(parseVectorBaseMap(encode({ ...VALID, extra: 1 }))).toBeNull();
  });

  it('viewBox の幅・高さが 0 や負なら null (変換が退化する)', () => {
    expect(
      parseVectorBaseMap(encode({ ...VALID, viewBox: { x: 0, y: 0, width: 0, height: 10 } })),
    ).toBeNull();
    expect(
      parseVectorBaseMap(encode({ ...VALID, viewBox: { x: 0, y: 0, width: 10, height: -1 } })),
    ).toBeNull();
  });

  it('レイヤーが空でも妥当 (地形のない地図 = 海だけ)', () => {
    const map = parseVectorBaseMap(encode({ ...VALID, layers: [] }));
    expect(map?.layers).toEqual([]);
  });

  it('上限を超えるバイト列は読まずに null (巨大 JSON でメインを止めない)', () => {
    const huge = new Uint8Array(MAX_VECTOR_BASEMAP_BYTES + 1);
    huge[0] = 0x7b;
    expect(parseVectorBaseMap(huge)).toBeNull();
  });
});
