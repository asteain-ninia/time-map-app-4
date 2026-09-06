// UI layer (U21 / 時刻レール): 操作列を窓幅で畳む規則（設計書 §B.4 の表の 4 列目）。
//
// **畳みは窓幅だけで決まる**（§B.4）。選択状態・道具・時刻・エラーの有無には一切
// 依存しない ―― それが K-3（帯の中身が変わっても地図がずれない）の要点である。
//
// 教訓 5.69「畳む判断を、畳んだ結果によって幅が変わる器の実測でしてはいけない」を
// **構造で**避けている。ここが見るのは窓幅ひとつで、操作列そのものの幅は一度も測らない
// ので「畳む → 器が縮む → もっと畳む」の輪が原理的に起こらない。
//
// 教訓 5.74「予算で畳むと決めたら、その予算を実際に嵌めるところまでやる」への答えは
// {@link RAIL_GROUPS} の `width` である。**同じ数を CSS 側の固定幅として嵌める**ので、
// ここの見積りと実寸がずれようがない（増分 5 の「≫」が欄の外へこぼれた事故は、予算に
// 見込んだ兄弟の幅（160px）と実寸（189〜204px）が違ったことが原因だった）。
//
// 純粋（framework-free）。窓幅を読むのは `useRailFold`（React 側）の仕事である。

/** 畳みの段（狭くなるほど後ろの段になる）。分岐識別子は定数を経由する（教訓 5.19）。 */
export const RAIL_FOLD = {
  /** 1440px 以上。全部出す。 */
  Full: 'full',
  /** 1120〜1439px。100 年送りを「≫」へ。 */
  NoHundred: 'noHundred',
  /** 960〜1119px。拡大の 3 ボタンを「拡大 ▾」1 個へ／ステップ単位を「≫」へ。 */
  ZoomMenu: 'zoomMenu',
  /** 800〜959px。錨ジャンプはキーだけ／再生は「▶」のみ。 */
  KeysOnly: 'keysOnly',
} as const;

export type RailFoldLevel = (typeof RAIL_FOLD)[keyof typeof RAIL_FOLD];

/** 段の下限の窓幅（§B.4 の表と同じ数）。 */
export const RAIL_FOLD_BREAKPOINTS = {
  full: 1440,
  noHundred: 1120,
  zoomMenu: 960,
} as const;

/** 窓幅から段を決める。**これが唯一の判定点**（教訓 5.13）。 */
export function railFoldOf(windowWidth: number): RailFoldLevel {
  if (windowWidth >= RAIL_FOLD_BREAKPOINTS.full) return RAIL_FOLD.Full;
  if (windowWidth >= RAIL_FOLD_BREAKPOINTS.noHundred) return RAIL_FOLD.NoHundred;
  if (windowWidth >= RAIL_FOLD_BREAKPOINTS.zoomMenu) return RAIL_FOLD.ZoomMenu;
  return RAIL_FOLD.KeysOnly;
}

/** 操作列に並ぶ部品のまとまり 1 つ。`width` は CSS が実際に嵌める固定幅（px）。 */
export interface RailGroup {
  readonly id: string;
  /** その段で実際に占める幅（px）。CSS の固定幅と同じ値（教訓 5.74）。 */
  readonly width: number;
}

/** 部品どうしのすき間（px）。CSS の `gap` と同じ値。 */
export const RAIL_GROUP_GAP = 8;
/** 操作列の左右の余白の合計（px）。CSS の `padding` と同じ値。 */
export const RAIL_ROW_PADDING = 24;

/**
 * 段ごとの幅（px）。**±1 の送り・年入力・再生は最後まで残す**（§B.4）。
 * 名前は画面の部品と 1 対 1 で、`RailControls.tsx` が同じ id で並べる。
 */
export const RAIL_GROUP_WIDTH = {
  /** 「◀ 前へ」「次へ ▶」。U-8 の下限（64×32）を 2 個。 */
  step1: 128,
  /** 「◀10」「10▶」。 */
  step10: 112,
  /** 「◀100」「100▶」。 */
  step100: 112,
  /** 「[ 1200 ]年 ⏎ [ジャンプ]」。 */
  year: 152,
  /** 「月日 ▾」（直接ジャンプの月日。設計書 §C.7 の (d)）。 */
  ymd: 56,
  /**
   * 「▶ 再生」＋速度。**実寸を測って直した**（2026-09-07 の手直し）―― 見積り 110 に対し
   * 実寸は停止 165.6 / 再生中 189.1px で、**再生を押すだけで幅が変わって**いた
   * （「再生」2 文字 →「一時停止」4 文字）。広いほうの実寸に合わせて 192 を取り、
   * ボタンそのものの幅も CSS で固定して、押しても動かないようにした。
   */
  playFull: 192,
  /** 「▶」だけ。 */
  playMin: 64,
  /** 拡大「−」「＋」「全体」。実寸 115.6 に合わせた。 */
  zoomFull: 120,
  /** 「拡大 ▾」1 個。実寸 54.4 に合わせた。 */
  zoomMenu: 56,
  /** 「◀錨」「錨▶」。実寸 104 に合わせた。 */
  anchorJump: 104,
  /** ステップ単位（月日 ▾）。実寸 100.8 に合わせた。 */
  unit: 104,
  /** 「≫」。 */
  overflow: 40,
} as const;

/**
 * 操作列に並びうるまとまり **全部**（畳みの段に関わらず）。
 *
 * **「行に出ていないものは必ず『≫』から開ける」**を機械で確かめるための母集団である
 * （進捗 §2 の約束）。実際、800〜959px では **10 年送りと再生速度が行にも「≫」にも
 * 無かった** ―― `overflowItems` が数え落としていたためで、母集団を持たずに
 * 「落としたものを 1 つずつ足す」形で書いていたのが原因である。
 */
export const RAIL_ALL_GROUPS: readonly (keyof typeof RAIL_GROUP_WIDTH)[] = [
  'step100',
  'step10',
  'step1',
  'year',
  'ymd',
  'playFull',
  'zoomFull',
  'anchorJump',
  'unit',
];

/** その段で操作列に並ぶまとまりを、左から順に返す。 */
export function railGroupsAt(level: RailFoldLevel): readonly RailGroup[] {
  const g = (id: keyof typeof RAIL_GROUP_WIDTH): RailGroup => ({
    id,
    width: RAIL_GROUP_WIDTH[id],
  });
  switch (level) {
    case RAIL_FOLD.Full:
      return [
        g('step100'),
        g('step10'),
        g('step1'),
        g('year'),
        g('ymd'),
        g('playFull'),
        g('zoomFull'),
        g('anchorJump'),
        g('unit'),
      ];
    case RAIL_FOLD.NoHundred:
      return [
        g('step10'),
        g('step1'),
        g('year'),
        g('ymd'),
        g('playFull'),
        g('zoomFull'),
        g('anchorJump'),
        g('unit'),
        g('overflow'),
      ];
    case RAIL_FOLD.ZoomMenu:
      return [
        g('step10'),
        g('step1'),
        g('year'),
        g('playFull'),
        g('zoomMenu'),
        g('anchorJump'),
        g('overflow'),
      ];
    case RAIL_FOLD.KeysOnly:
      return [g('step1'), g('year'), g('playMin'), g('zoomMenu'), g('overflow')];
  }
}

/** その段で操作列が要する幅（px）。すき間と左右の余白まで数える。 */
export function railContentWidth(level: RailFoldLevel): number {
  const groups = railGroupsAt(level);
  const sum = groups.reduce((acc, x) => acc + x.width, 0);
  const gaps = Math.max(0, groups.length - 1) * RAIL_GROUP_GAP;
  return sum + gaps + RAIL_ROW_PADDING;
}

/**
 * 畳んだあとの最小内容幅（§B.4）。**いちばん狭い段でこの幅を超えてはいけない**
 * ―― 超えたら 800px の窓で右端が欄の外へこぼれる（§1.2「右端が永久に到達不能」の再発）。
 */
export const RAIL_MIN_CONTENT_WIDTH = 672;

/** 支える最小の窓幅（FR-114）。この幅で操作列が収まることを契約テストが固定する。 */
export const RAIL_MIN_WINDOW_WIDTH = 800;
