// UI layer (U20 / shell): 状態行とウィンドウタイトルの文字を作る純関数（設計書 §C.8 / §H.6）。
//
// 表示の判断（何を出すか・出さないか）だけをここに置き、DOM も React も触らない
// （教訓 5.41: 実機でしか動かせない範囲を減らし、単体テストで守れる形にする）。

/** ファイルの絶対パスから、画面に出す名前（拡張子込み）を取り出す。 */
export function fileNameOf(savePath: string | null): string | null {
  if (savePath === null) return null;
  const normalized = savePath.replace(/\\/g, '/');
  const last = normalized.slice(normalized.lastIndexOf('/') + 1);
  return last.length > 0 ? last : null;
}

// --- ウィンドウタイトル（設計書 §H.6） --------------------------------------

/** アプリの正式名称。`src/ui/index.html` の初期 `<title>` と同じ（現状.md B3）。 */
export const APP_NAME = 'gimoza';

/** 保存先が決まっていない新規プロジェクトの、ファイル名の代わりに出す文字。 */
export const UNSAVED_NEW_PROJECT = '（未保存の新規）';

/** 未保存の印。 */
export const DIRTY_MARK = '●';

export interface WindowTitleInput {
  /** 世界名（プロジェクト名）。空なら段ごと出さない。 */
  readonly worldName: string;
  /** 保存先のファイル名（拡張子込み）。null なら「（未保存の新規）」。 */
  readonly fileName: string | null;
  readonly dirty: boolean;
}

/**
 * ウィンドウタイトル（設計書 §H.6）。
 *
 * ```
 * gimoza — デーレ界 — derle-world-2026-08-16.gimoza ●
 * 未保存でないとき: gimoza — デーレ界 — derle-world-2026-08-16.gimoza
 * ファイル未確定:   gimoza — デーレ界 —（未保存の新規）
 * ```
 *
 * 世界名が空のときはその段を落とす（空の「—  —」を出さない）。§7.4-2 が非目標としているのは
 * 「メインマップ上への常時表示」だけなので、タイトルは要件の文言に触れずに解決できる。
 */
export function buildWindowTitle(input: WindowTitleInput): string {
  const parts: string[] = [APP_NAME];
  const world = input.worldName.trim();
  if (world.length > 0) parts.push(world);
  parts.push(input.fileName ?? UNSAVED_NEW_PROJECT);
  const base = parts.join(' — ');
  return input.dirty ? `${base} ${DIRTY_MARK}` : base;
}

// --- 縮尺（設計書 §C.8 / §L.1） ---------------------------------------------

/**
 * CSS の参照ピクセルの物理長（m）。CSS 仕様の 1px = 1/96 インチ。
 *
 * **§L.1 が「分母の定義は未解決事項」としていた点をここで決める。** 縮尺 1:N の N は
 * 「地図上の 1 CSS ピクセルが実世界で何メートルか」を「1 CSS ピクセルの物理長」で割った値と
 * する。devicePixelRatio は掛けない（描画変換も掛けていない＝`render/camera.ts` の方針と
 * 揃える）。実機の実寸は OS の表示倍率で変わるので厳密な物差しにはならないが、**桁を読む**
 * 用途には足りる。理由は docs/技術方針.md に記録した。
 */
export const METRES_PER_CSS_PX = 0.0254 / 96;

/**
 * 縮尺の分母 N（1:N）。`zoom` は「CSS ピクセル / 度」（`render/camera.ts` の定義）。
 * 赤道での縮尺を返す（緯度が上がるほど実距離は縮むが、基準を 1 つに決めないと桁が読めない）。
 * 入力が病的なら null（＝画面には「—」を出す）。
 */
export function scaleDenominator(zoomPxPerDeg: number, equatorLengthKm: number): number | null {
  if (!Number.isFinite(zoomPxPerDeg) || zoomPxPerDeg <= 0) return null;
  if (!Number.isFinite(equatorLengthKm) || equatorLengthKm <= 0) return null;
  const metresPerDegree = (equatorLengthKm * 1000) / 360;
  const metresPerPixel = metresPerDegree / zoomPxPerDeg;
  const denominator = metresPerPixel / METRES_PER_CSS_PX;
  return Number.isFinite(denominator) && denominator > 0 ? denominator : null;
}

/** 3 桁ごとに区切る（`toLocaleString` はロケール依存なので使わない）。 */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 縮尺の表示文字。有効数字 3 桁に丸めてから 3 桁区切りにする（「1:169,000,000」）。
 * 分母が読めないときは「—」。
 */
export function formatScale(denominator: number | null): string {
  if (denominator === null) return '—';
  const rounded = roundToSignificant(denominator, 3);
  return `1:${groupDigits(rounded)}`;
}

function roundToSignificant(value: number, digits: number): number {
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, magnitude - digits + 1);
  return Math.round(value / factor) * factor;
}

// --- 最終保存（設計書 §C.8 / §H.6 の表） ------------------------------------

/** 「最終保存 14:03」の時刻部分。24 時制・0 埋め（ロケールに依らない）。 */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
