// UI 層（U39 / FR-04）: 背景地図を差し替えるときの **縦横比の判定と補正の提案**（増分 8E / G-10）。
//
// **これが直すもの**（現状分析 §6.2 の G-10）: 差し替えは画像のバイト列の安全確認だけをして、
// 縦横比を見ていなかった。地図は正距円筒（横が縦の 2 倍＝2:1）で描くので、2:1 でない画像を
// 差し替えると **黙って横（か縦）に引き伸ばされて地図が歪む**。比率を見る式は
// `domain/basemap/format.ts` に 11 個そろっていたが、どれも呼ばれていなかった。
//
// ここは判定（`decideBasemapReplacement` をそのまま使う。比率と許し幅を写さない＝教訓 5.29）
// と、利用者に聞く文と、補正（余白を足して 2:1 にする）の実行だけを持つ。聞く板は
// `BasemapAspectDialog.tsx`、聞く口は `runBasemapReplace` の `confirmAspect` である。

import {
  BASEMAP_FALLBACK_REASON,
  BASEMAP_OUTCOME,
  decideBasemapReplacement,
  validateImageDescriptor,
  type CorrectedDimensions,
} from '../../domain/basemap/index';
import { BASEMAP_ASPECT_STRINGS } from './strings';

/** 利用者の答え。 */
export const BASEMAP_ASPECT_CHOICE = {
  /** 余白を足して 2:1 にしてから使う。 */
  Correct: 'correct',
  /** そのまま使う（地図は引き伸ばされる）。 */
  Keep: 'keep',
  /** 差し替えをやめる（地図は変わらない）。 */
  Cancel: 'cancel',
} as const;

export type BasemapAspectChoice = (typeof BASEMAP_ASPECT_CHOICE)[keyof typeof BASEMAP_ASPECT_CHOICE];

/** 板に出す問い。 */
export interface BasemapAspectQuestion {
  readonly widthPx: number;
  readonly heightPx: number;
  /** 「3:2」のような比の書き方。 */
  readonly ratioLabel: string;
  /** 補正できるか（2:1 から離れすぎていれば補正の選択肢を出さない）。 */
  readonly correctable: boolean;
  /** 補正したあとの寸法（補正できるときだけ）。 */
  readonly corrected: CorrectedDimensions | null;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/** 約分した比の項がこれより大きいと読めないので、小数の比（1.78:1）で書く。 */
const MAX_RATIO_TERM = 32;

/**
 * 縦横比を人が読める形にする。約分して小さな整数になれば「3:2」、ならなければ
 * 「1.78:1」（小数 2 桁）。
 */
export function aspectRatioLabel(widthPx: number, heightPx: number): string {
  const d = gcd(widthPx, heightPx);
  const w = widthPx / d;
  const h = heightPx / d;
  if (w <= MAX_RATIO_TERM && h <= MAX_RATIO_TERM) return `${String(w)}:${String(h)}`;
  return `${(widthPx / heightPx).toFixed(2)}:1`;
}

/**
 * 差し替えようとしている画像について、利用者に聞くべきことがあるか。2:1（許し幅の内）なら
 * null（聞かずに使う）。判定は `decideBasemapReplacement` の 1 本を通す。
 */
export function basemapAspectQuestion(dims: {
  readonly widthPx: number;
  readonly heightPx: number;
}): BasemapAspectQuestion | null {
  const decision = decideBasemapReplacement(
    validateImageDescriptor({ widthPx: dims.widthPx, heightPx: dims.heightPx, source: '' }),
  );
  const ratioLabel = aspectRatioLabel(dims.widthPx, dims.heightPx);
  switch (decision.outcome) {
    case BASEMAP_OUTCOME.Adopted:
      return null;
    case BASEMAP_OUTCOME.CorrectedAndAdopted:
      return { ...dims, ratioLabel, correctable: true, corrected: decision.dimensions };
    case BASEMAP_OUTCOME.FallbackToPreset:
      // 画像として読めないものは手前の関門（バイト列の確認・試し読み）で断っている。
      // ここまで来て寸法が不正と言われることは無いが、来たら聞かない（判断材料が無い）。
      if (decision.reason !== BASEMAP_FALLBACK_REASON.Uncorrectable) return null;
      return { ...dims, ratioLabel, correctable: false, corrected: null };
  }
}

/** 画面に出す言葉（教訓 5.19）。設計書 §F の G-10 の文に合わせる。 */
export { BASEMAP_ASPECT_STRINGS };

/**
 * 補正したとき、絵が地図の中で縮んで見える向き（増分 8E の手直し）。横が足りない画像
 * （2:1 より縦長）は横に余白を足すので横方向に、縦が足りない画像は縦方向に縮んで見える。
 */
export function correctShiftAxis(question: BasemapAspectQuestion): string {
  const corrected = question.corrected;
  if (corrected === null) return BASEMAP_ASPECT_STRINGS.axisHorizontal;
  return corrected.widthPx > question.widthPx
    ? BASEMAP_ASPECT_STRINGS.axisHorizontal
    : BASEMAP_ASPECT_STRINGS.axisVertical;
}

/**
 * 画像に余白を足して `target` の寸法（2:1）にし、PNG のバイト列で返す。画像は中央に置き、
 * 足した余白は透明にする（画像そのものは縮めない＝`correctedDimensions` の規則）。
 * 描画の器が無い環境（単体試験の node）や読めない画像では null。
 */
export async function padImageToTarget(
  bytes: Uint8Array,
  mimeType: string,
  target: CorrectedDimensions,
): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return null;
  }
  try {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const bitmap = await createImageBitmap(new Blob([copy], { type: mimeType }));
    const canvas = new OffscreenCanvas(target.widthPx, target.heightPx);
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      bitmap.close();
      return null;
    }
    const dx = Math.round((target.widthPx - bitmap.width) / 2);
    const dy = Math.round((target.heightPx - bitmap.height) / 2);
    ctx.drawImage(bitmap, dx, dy);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 板と差し替えの手続きをつなぐ極小の置き場。手続き（`runBasemapReplace`）が `ask` で
 * 問いを置いて答えを待ち、板（`BasemapAspectDialog`）が `answer` で答える。React の外に
 * 置くのは、手続きが React の外（ファイル操作の排他の中）で走るからである。
 */
export class BasemapAspectPromptStore {
  private pending: {
    readonly question: BasemapAspectQuestion;
    readonly resolve: (choice: BasemapAspectChoice) => void;
  } | null = null;
  private readonly listeners = new Set<() => void>();

  /** いま出している問い（無ければ null）。 */
  get = (): BasemapAspectQuestion | null => this.pending?.question ?? null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 問いを置いて答えを待つ。前の問いが残っていれば、それは「やめる」で閉じる。 */
  ask = (question: BasemapAspectQuestion): Promise<BasemapAspectChoice> => {
    this.pending?.resolve(BASEMAP_ASPECT_CHOICE.Cancel);
    return new Promise<BasemapAspectChoice>((resolve) => {
      this.pending = { question, resolve };
      this.emit();
    });
  };

  /** 答える（問いが無ければ何もしない）。 */
  answer = (choice: BasemapAspectChoice): void => {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    pending.resolve(choice);
    this.emit();
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
