// UI layer (U39 / FR-04): the PURE base-map 差し替え seam.
//
// FR-04「背景地図(ベースマップ)差し替え」: the settings dialog's差し替えボタン (U38,
// SettingsDialog data-testid="settings-basemap-replace") hands a REQUEST here; this
// seam performs the replacement over INJECTED ports so the whole flow (pick image →
// guard → apply) is unit-testable without Electron / a native dialog / the renderer
// (教訓 5.41 純粋な決定はテスト可能な関数へ).
//
// It mirrors the EXTERNAL derle-import/tools/swap-basemap.js contract used off-app:
// keep the project's base-map META (座標契約 v2 — 投影/範囲を維持) and swap only the
// IMAGE bytes (ユーザー方針: 一旦出界図の様式で決め打ち). The bytes are validated with
// the SAME untrusted-image guard the renderer host runs before decode
// (base-map-image-guard, checkBaseMapImageBytes), so an image ACCEPTED here also
// displays, and an明白に不正な image is rejected BEFORE it touches the project — never
// a半端な資産 that corrupts data (task §フェーズ0 / Codex 指摘の非信頼バイト規律).
//
// It writes NOTHING itself: `applyReplacement` is the single effect port the live
// controller wires to (a) the U16 store domain swap (baseMap.source/meta +
// projectDirty), (b) the retained SAVE bytes (loadedAssetsRef → 保存往復), and (c) the
// DISPLAY bytes push (onBaseMapImageChange → 即時再描画), so this module stays a pure
// decision (教訓 5.29 単一真実源 — one decision, three sinks the caller owns).

import {
  checkBaseMapImageBytes,
  BASE_MAP_IMAGE_REJECTION,
  type BaseMapImageCheck,
  type BaseMapImageRejection,
} from '../map/base-map-image-guard';
import {
  PRESET_BASEMAP_ID,
  type EquirectangularMeta,
} from '../../domain/basemap/index';
import type { BaseMapReference } from '../../domain/persistence/index';

/**
 * The base-map `source` marker stamped when a PRESET / empty project adopts a user
 * image. It only has to be a NON-empty, NON-preset string so the domain's
 * `resolveDisplayedBasemap` selects the USER map: the actual bytes always live at the
 * fixed ZIP entry `assets/basemap.img` (entry-paths.BASEMAP_ENTRY), so `source` is
 * purely an identity/reference marker — this literal deliberately equals that ZIP
 * entry convention (schema baseMapReference doc:「Relative reference into the ZIP
 * container」). A project whose source is ALREADY a user reference KEEPS it
 * (swap-basemap.js semantics: マニフェスト参照は無傷).
 */
export const REPLACED_BASEMAP_SOURCE = 'assets/basemap.img';

/** The outcome of a差し替え request (テスト可能な戻り値, 教訓 5.26). */
export const BASEMAP_REPLACE_OUTCOME = {
  /** A valid image was picked and applied (store + assets + display updated). */
  Applied: 'applied',
  /** The user dismissed the picker, or it failed — honest no-op (無変更). */
  Cancelled: 'cancelled',
  /** The picked bytes failed the image guard — rejected before apply (+notify). */
  Rejected: 'rejected',
} as const;

export type BasemapReplaceOutcomeKind =
  (typeof BASEMAP_REPLACE_OUTCOME)[keyof typeof BASEMAP_REPLACE_OUTCOME];

export type BasemapReplaceOutcome =
  | {
      readonly status: typeof BASEMAP_REPLACE_OUTCOME.Applied;
      readonly source: string;
      readonly meta: EquirectangularMeta;
    }
  | { readonly status: typeof BASEMAP_REPLACE_OUTCOME.Cancelled }
  | {
      readonly status: typeof BASEMAP_REPLACE_OUTCOME.Rejected;
      readonly reason: BaseMapImageRejection;
    };

/**
 * FR-115 日本語 notice for a rejected image (unreadable / wrong format /
 * out-of-bounds dimensions). Surfaced through the caller's `notify` before the
 * honest no-op, so the user learns WHY nothing changed (拒否理由は通知でも, 教訓 5.26).
 */
export const BASEMAP_REPLACE_REJECT_NOTICE =
  '選択した画像をベースマップとして読み込めませんでした（対応形式は PNG / JPEG、寸法・容量の上限内）。差し替えを中止しました。';

/** The injected ports for {@link runBasemapReplace} (all effects are the caller's). */
export interface BasemapReplacePorts {
  /**
   * Pick the replacement image BYTES (the main-process image dialog via U15 IPC).
   * Resolves `null` when the user cancels OR the pick fails — the flow then does
   * nothing (honest no-op). Never throws for a cancel.
   */
  readonly pickImageBytes: () => Promise<Uint8Array | null>;
  /** The project's CURRENT base-map reference (store domain.baseMap) — read live. */
  readonly getBaseMap: () => BaseMapReference;
  /**
   * Apply the replacement: swap the domain baseMap (source/meta) + mark dirty, retain
   * the SAVE bytes for the round-trip, and push the DISPLAY bytes for immediate
   * repaint. The caller owns all three sinks (単一真実源 — this seam decides once).
   */
  readonly applyReplacement: (next: {
    readonly source: string;
    readonly meta: EquirectangularMeta;
    readonly bytes: Uint8Array;
  }) => void;
  /** Surface a日本語 notice (FR-115). Optional; absent in the standalone tests. */
  readonly notify?: (message: string) => void;
  /**
   * The untrusted-image guard (size / PNG・JPEG header / dimension caps). Defaults to
   * {@link checkBaseMapImageBytes} — the SAME guard the renderer host runs — so an
   * image accepted here displays and one明白に不正 is rejected identically (単一真実源).
   */
  readonly checkBytes?: (bytes: Uint8Array) => BaseMapImageCheck;
  /**
   * F4 async decode probe: PROVE the picked bytes actually decode to an image (the
   * sync {@link checkBytes} only parses the header, so a truncated / corrupt but
   * header-valid PNG/JPEG passes it yet fails a real decode). Resolves `true` when the
   * bytes decode, `false` when they do NOT. Defaults to {@link probeImageDecodable}
   * (a `createImageBitmap` decode); in an environment WITHOUT a decoder (node/jsdom
   * unit tests) the default does not block, because the real renderer — which has the
   * decoder — is where the gate bites. Injected explicitly in unit tests to exercise
   * both verdicts without a DOM.
   */
  readonly decodeProbe?: (bytes: Uint8Array, mimeType: string) => Promise<boolean>;
}

/**
 * Default {@link BasemapReplacePorts.decodeProbe} (F4): prove the picked bytes decode
 * before the replacement mutates the project. Uses the renderer's `createImageBitmap`.
 * In an environment without a decoder (node/jsdom) it CANNOT run the decode and so
 * returns `true` (does not block — the real renderer enforces it; unit tests inject an
 * explicit probe). A decode failure resolves `false`, never throws.
 */
export async function probeImageDecodable(
  bytes: Uint8Array,
  mimeType: string,
): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return true;
  try {
    // Copy into a fresh ArrayBuffer-backed view before wrapping in a Blob so the
    // decode sees exactly this range even for a view over a larger/shared buffer
    // (mirrors the host's decode adapter).
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const bitmap = await createImageBitmap(new Blob([copy], { type: mimeType }));
    (bitmap as { close?: () => void }).close?.();
    return true;
  } catch {
    return false;
  }
}

/** A source that means「preset / まだユーザー画像なし」(→ needs the user marker). */
function isPresetOrEmpty(source: string): boolean {
  return source === '' || source === PRESET_BASEMAP_ID;
}

/**
 * Run the FR-04 base-map replacement over the injected ports. Control flow:
 *   1. pick bytes; `null` ⇒ Cancelled (無変更, honest no-op);
 *   2. sync-guard the bytes (size / header / dimensions); reject ⇒ notify + Rejected
 *      (適用前に拒否, no half asset);
 *   3. async decode-probe the bytes (F4); undecodable ⇒ notify + Rejected — a header-
 *      valid but truncated/corrupt image is rejected BEFORE it is adopted + saved;
 *   4. KEEP the current meta (座標契約 v2 — 投影/範囲維持; a preset project already
 *      carries the全世界 equirectangular meta, so keeping it IS the preset default),
 *      keep a user `source` or stamp {@link REPLACED_BASEMAP_SOURCE} for a preset one,
 *      then apply. Returns the outcome for the caller / tests (教訓 5.26).
 */
export async function runBasemapReplace(
  ports: BasemapReplacePorts,
): Promise<BasemapReplaceOutcome> {
  const bytes = await ports.pickImageBytes();
  // Cancel / picker-fail → do nothing (教訓 5.7 完了トリガー: キャンセルは無変更).
  if (bytes === null) return { status: BASEMAP_REPLACE_OUTCOME.Cancelled };

  const check = (ports.checkBytes ?? checkBaseMapImageBytes)(bytes);
  if (!check.ok) {
    //明白に不正な画像は適用前に拒否 (+ FR-115 notify): the project asset is never
    // touched, so no downstream save can persist a broken base map (Codex 規律).
    ports.notify?.(BASEMAP_REPLACE_REJECT_NOTICE);
    return { status: BASEMAP_REPLACE_OUTCOME.Rejected, reason: check.reason };
  }

  // F4: the sync guard only parsed the HEADER. Prove the bytes actually DECODE before
  // mutating anything — a truncated / corrupt but header-valid PNG/JPEG passes the
  // guard yet fails a real decode, and (pre-fix) was adopted + dirtied + SAVED as a
  // broken asset (the display silently fell back to the preset via resolveDisplayedBasemap,
  // but the on-disk bytes were still broken). Reject BEFORE applyReplacement so no half
  // asset is ever persisted; the host's resolveDisplayedBasemap fallback stays as the
  // second line of defence for any image that slips through (二重防御). Runs once, only
  // for header-accepted bytes.
  const decodable = await (ports.decodeProbe ?? probeImageDecodable)(bytes, check.mimeType);
  if (!decodable) {
    ports.notify?.(BASEMAP_REPLACE_REJECT_NOTICE);
    return {
      status: BASEMAP_REPLACE_OUTCOME.Rejected,
      reason: BASE_MAP_IMAGE_REJECTION.Undecodable,
    };
  }

  const current = ports.getBaseMap();
  // META 保持 (座標契約 v2): 投影/範囲は現行のまま。swap-basemap.js と同義 — 画像のみ差替。
  const meta: EquirectangularMeta = current.meta;
  // SOURCE: keep an existing user reference (マニフェスト無傷); a preset/empty project
  // gets the user marker so resolveDisplayedBasemap paints the user map, not the preset.
  const source = isPresetOrEmpty(current.source) ? REPLACED_BASEMAP_SOURCE : current.source;

  ports.applyReplacement({ source, meta, bytes });
  return { status: BASEMAP_REPLACE_OUTCOME.Applied, source, meta };
}
