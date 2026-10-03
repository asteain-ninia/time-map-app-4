// UI layer (U20 / shell): 状態行とウィンドウタイトルの文字を作る純関数（設計書 §C.8 / §H.6）。
//
// 表示の判断（何を出すか・出さないか）だけをここに置き、DOM も React も触らない
// （教訓 5.41: 実機でしか動かせない範囲を減らし、単体テストで守れる形にする）。

import { SHELL_TEXT } from './strings';

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
export const UNSAVED_NEW_PROJECT = SHELL_TEXT.unsavedNewProject;

/**
 * 読み込みは成功したのに保存先の確定に失敗したときに、ファイル名の代わりに出す文字。
 * 「（未保存の新規）」と区別する（読み込んだファイルが無かったことにされて見えるため）。
 */
export const DESTINATION_UNDETERMINED = SHELL_TEXT.destinationUndetermined;

/** 未保存の印。 */
export const DIRTY_MARK = '●';

/** 世代から開いたときの「何の、いつの世代か」（増分 8D。契約の `RestoredFrom` と同じ形）。 */
export interface RestoredFromLabel {
  /** 元の保存ファイルの名前（拡張子込み）。 */
  readonly sourceName: string;
  /** その世代を保存した時刻（epoch ms。実時間）。 */
  readonly savedAtMs: number;
}

/**
 * 世代から開いて、まだどこにも保存していないときにファイル名の代わりに出す文字
 * （増分 8D / 設計書 §E.1 の V14 の規則 ①）。
 *
 * 「derle-world.gimoza（2026-10-03 14:03 の世代から復旧・保存先は未確定）」。設計書の例は
 * 時刻を「1200年」と作中の年で書いているが、世代は **保存した実時間**で並んでいるので
 * 実時間を出す（一覧の日時の列と同じ物差し）。
 */
export function restoredFileLabel(restored: RestoredFromLabel): string {
  return SHELL_TEXT.restoredFileLabel(restored.sourceName, formatDateMinute(restored.savedAtMs));
}

export interface WindowTitleInput {
  /** 世界名（プロジェクト名）。空なら段ごと出さない。 */
  readonly worldName: string;
  /** 保存先のファイル名（拡張子込み）。null なら「（未保存の新規）」。 */
  readonly fileName: string | null;
  readonly dirty: boolean;
  /** 保存先を取り下げた状態か（読み込みは成功したが宛先の確定に失敗した）。 */
  readonly destinationRetracted?: boolean;
  /** 世代から開いて、まだ保存していないとき（増分 8D）。 */
  readonly restoredFrom?: RestoredFromLabel | null;
}

/**
 * ファイル名の段に出す文字（アプリバーとウィンドウタイトルの共通）。優先は
 * 保存先の名前 → 世代から復旧 → 取り下げ → 未保存の新規。
 */
export function fileSlotText(input: {
  readonly fileName: string | null;
  readonly destinationRetracted?: boolean;
  readonly restoredFrom?: RestoredFromLabel | null;
}): string {
  if (input.fileName !== null) return input.fileName;
  if (input.restoredFrom !== undefined && input.restoredFrom !== null) {
    return restoredFileLabel(input.restoredFrom);
  }
  return input.destinationRetracted === true ? DESTINATION_UNDETERMINED : UNSAVED_NEW_PROJECT;
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
  parts.push(fileSlotText(input));
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

/**
 * 「2026-10-03 14:03」（秒を落とした完全表記。増分 8D の世代の一覧とアプリバー）。
 * {@link formatTimestamp} と同じくロケールに依らない。読めなければ「—」。
 */
export function formatDateMinute(epochMs: number): string {
  const full = formatTimestamp(epochMs);
  return full === UNKNOWN_TIME ? full : full.slice(0, 16);
}

/** 日時が読めないとき（NaN 等）に出す文字。`formatScale` の「—」と揃える。 */
export const UNKNOWN_TIME = '—';

/**
 * 記録時刻（実時間）の完全表記「2026-09-04 14:03:07」。診断情報のログ 1 行がこれを使う。
 *
 * **`toLocaleString` を使わない。** この unit の方針は `groupDigits` の注記と同じで、
 * 表示をロケール設定に委ねない。`toLocaleString()` は OS の地域と暦の設定しだいで
 * 「2026/9/4 14:03:07」にも「R8/9/4 14:03:07」（和暦）にもなり、**環境によって違う文字が
 * 出る**。診断情報は「いつ何が起きたか」を人が読んで突き合わせる用途なので、どの環境でも
 * 同じ並び（年-月-日 時:分:秒・0 埋め・24 時制）で出す必要がある。
 *
 * 時:分は {@link formatClock} をそのまま使う（同じ整形を 2 か所に書かない）。秒まで出すのは、
 * 連続して起きたエラーの前後関係がログ上で分かるようにするため。
 */
export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return UNKNOWN_TIME;
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd} ${formatClock(epochMs)}:${ss}`;
}
