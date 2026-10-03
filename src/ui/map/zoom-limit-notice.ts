// UI 層（地図）: ズームの上下限を超えた操作を **理由つきで断る**（増分 8E / G-21）。
//
// **これが直すもの**: 拡大の上限（既定 50 倍）で［＋］・Ctrl+= を押しても、地図は黙って
// 何も変わらなかった。壊れているのか上限なのかが画面から分からない（設計書 §H.5 の
// 「無反応にしない」）。設計書 §F の G-21 は「地図内のズームボタンの脇と状態行」に出す。
//
// ここに置くのは **判定と文と小さな置き場** だけである。ズームの処理そのもの（U17 の
// `zoomStepAtCursor` とクランプ、`keyboardZoomCamera`）は書き換えない ―― 増分 8A が
// 上限で［拡大］を引っ込める直しを入れているので、触る場所を分ける（依頼書の制約 3）。
// 判定は **いまの上限の値を読むだけ**: 押す前の倍率がすでに上限（下限）に着いていれば、
// その向きの 1 押しは何も変えないので断る。
//
// 上限の値は 2 つある: カメラが実際にクランプに使う値（`ZoomRange`。描画の単位）と、
// 利用者が設定で入れた倍率（`projectSettings.zoomMin / zoomMax`）。判定は前者で、文に出す
// 数は後者で書く（利用者が設定で見ている数と同じにする）。

import type { ZoomDirection } from './keyboard-zoom';

/** 判定に使う範囲（`render/camera` の `ZoomRange` と同じ形）。 */
export interface ZoomLimitRange {
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** 文に出す、利用者が設定した倍率（`ProjectSettings` の 2 項目）。 */
export interface ZoomLimitSettings {
  readonly zoomMin: number;
  readonly zoomMax: number;
}

/** 断ったときに出す 2 つの文。 */
export interface ZoomLimitRefusal {
  /** ズームボタンの脇に出す短い文。 */
  readonly side: string;
  /** 状態行に出す文（何が起きたか → なぜか → 次に何をするか。§H.5）。 */
  readonly status: string;
}

/** 倍率を画面に出す書き方（整数ならそのまま、端数は小数 1 桁まで）。 */
function formatTimes(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

/** 画面に出る言葉（教訓 5.19: 文言は定数を経由する）。 */
export const ZOOM_LIMIT_NOTICE_STRINGS = {
  sideMax: (max: number): string => `拡大の上限（${formatTimes(max)}倍）です`,
  sideMin: (min: number): string => `縮小の下限（${formatTimes(min)}倍）です`,
  statusMax: (max: number): string =>
    `これ以上は拡大できません。拡大の上限（${formatTimes(max)}倍）に達しています。上限は設定の「最大ズーム倍率」で変えられます。`,
  statusMin: (min: number): string =>
    `これ以上は縮小できません。縮小の下限（${formatTimes(min)}倍）に達しています。下限は設定の「最小ズーム倍率」で変えられます。`,
} as const;

/**
 * 着いているとみなす相対の許し幅。クランプは上限の値そのものを書くので本来は等しくなるが、
 * 浮動小数の往復でごくわずかにずれても「着いている」と読む。
 */
const AT_LIMIT_EPSILON = 1e-9;

/**
 * その向きの 1 押しを **断るべきか**。押す前の倍率がすでに上限（拡大）・下限（縮小）に
 * 着いていれば断りの文を返し、そうでなければ null（ズームはいつもどおり進む）。
 */
export function zoomLimitRefusal(
  direction: ZoomDirection,
  zoomBefore: number,
  range: ZoomLimitRange,
  settings: ZoomLimitSettings,
): ZoomLimitRefusal | null {
  if (!Number.isFinite(zoomBefore)) return null;
  if (direction === 'in') {
    if (zoomBefore < range.maxZoom * (1 - AT_LIMIT_EPSILON)) return null;
    return {
      side: ZOOM_LIMIT_NOTICE_STRINGS.sideMax(settings.zoomMax),
      status: ZOOM_LIMIT_NOTICE_STRINGS.statusMax(settings.zoomMax),
    };
  }
  if (zoomBefore > range.minZoom * (1 + AT_LIMIT_EPSILON)) return null;
  return {
    side: ZOOM_LIMIT_NOTICE_STRINGS.sideMin(settings.zoomMin),
    status: ZOOM_LIMIT_NOTICE_STRINGS.statusMin(settings.zoomMin),
  };
}

/** ズームボタンの脇に出している断り（出していなければ null）。 */
export interface ZoomLimitNote {
  readonly text: string;
  /** 断ったときの倍率。**倍率がこれから動いたら脇の文は消す**（もう上限ではない）。 */
  readonly zoom: number;
}

/**
 * 脇の文の置き場（React の外の極小 pub/sub。`StatusMessageStore` と同じ形）。
 * 地図の結線（`onMapMount`）から押し込み、脇の部品だけが購読する。
 */
export class ZoomLimitNoteStore {
  private note: ZoomLimitNote | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): ZoomLimitNote | null => this.note;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  show(text: string, zoom: number): void {
    const current = this.note;
    if (current !== null && current.text === text && current.zoom === zoom) return;
    this.note = { text, zoom };
    this.emit();
  }

  clear(): void {
    if (this.note === null) return;
    this.note = null;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** 脇の文を出し続けてよいか（倍率が断ったときから動いていなければ出す）。 */
export function zoomLimitNoteVisible(note: ZoomLimitNote | null, zoomNow: number): boolean {
  if (note === null) return false;
  const scale = Math.max(Math.abs(note.zoom), 1e-12);
  return Math.abs(zoomNow - note.zoom) / scale <= 1e-6;
}
