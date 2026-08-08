// U15 — the `.tmap` ZIP container read/write ADAPTERS (技術方針 2.12 / FR-103).
//
// PURE & Electron-free (受け入れ基準7): `buildTmap` assembles a ZIP byte array
// from a manifest value + binary assets; `readTmap` parses ZIP bytes back into
// the same parts. Both use the SINGLE entry-path convention (entry-paths.ts).
// ZIP I/O is fflate's synchronous `zipSync` / `unzipSync` (技術方針: ZIP入出力
// は fflate).
//
// The manifest is stored as UTF-8 JSON text. Binary assets are stored verbatim.
// `readTmap` returns a discriminated result: the manifest is returned as a raw
// `unknown` (parsed JSON) — it is DELIBERATELY NOT validated here. Zod validation
// is the load adapter's job through `parseManifest` (R8 / 受け入れ基準5). This
// adapter only deals with bytes ↔ entries; structural trust never starts here.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import type { NamedAsset } from '../ipc/contract';
import {
  attachmentEntry,
  attachmentNameOf,
  BASEMAP_ENTRY,
  MANIFEST_ENTRY,
} from './entry-paths';

/** Inputs to {@link buildTmap}: the manifest value plus the binary assets. */
export interface TmapContents {
  /** The manifest value to JSON-encode (already serialized by U14). */
  readonly manifest: unknown;
  /** Base-map image bytes. */
  readonly baseMapImage: Uint8Array;
  /** Attached document images (may be empty — 0 is a valid count, 教訓5.18). */
  readonly attachments: readonly NamedAsset[];
}

/** What {@link readTmap} extracts from a `.tmap` byte stream. */
export interface ExtractedTmap {
  /** The raw, NOT-yet-validated manifest (parsed JSON). */
  readonly manifest: unknown;
  readonly baseMapImage: Uint8Array;
  readonly attachments: readonly NamedAsset[];
}

/**
 * Size caps (Codex 全体レビュー MED「zip・サイズ上限なし — 巨大ファイルで main 停止」).
 * The container cap bounds what the IPC layer will even READ from disk (statで事前
 * 拒否 — a multi-GB pick must never freeze main's event loop in unzipSync); the
 * per-entry cap bounds what unzipSync will EXPAND (zip-bomb: a tiny container can
 * declare a huge originalSize — the fflate filter rejects it BEFORE decompression).
 * Both are far above any legitimate project (実測 derle 実データ=数十MB級) so a real
 * file is never rejected; they exist to keep a pathological file from stalling main.
 */
export const MAX_TMAP_BYTES = 1024 * 1024 * 1024; // 1 GiB (container / stat cap)
export const MAX_TMAP_ENTRY_BYTES = 512 * 1024 * 1024; // 512 MiB (expanded per entry)
/** Cap on the SUMMED expanded size of all entries (GPT-5.6 Sol review #2: many
 *  individually-passing entries must not add up to an OOM). */
export const MAX_TMAP_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB (expanded total)

/** Optional cap overrides for {@link readTmap} (tests inject small values). */
export interface ReadTmapCaps {
  readonly maxContainerBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxTotalBytes?: number;
}

/** Why reading a `.tmap` failed (corrupt zip / missing required entry / bad JSON). */
export type ReadTmapResult =
  | { readonly ok: true; readonly contents: ExtractedTmap }
  | { readonly ok: false; readonly reason: 'corrupt'; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: 'missing-entry';
      readonly entry: string;
      readonly message: string;
    };

/**
 * Assemble a `.tmap` ZIP byte array from the manifest + assets (FR-103). The
 * manifest JSON entry is written first (its `version`先頭 is preserved by the
 * serializer). Attachments are placed under the shared attachments directory.
 * Pure: same input → same bytes (fflate `zipSync` with default settings).
 */
export function buildTmap(contents: TmapContents): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(contents.manifest)),
    [BASEMAP_ENTRY]: contents.baseMapImage,
  };
  for (const asset of contents.attachments) {
    files[attachmentEntry(asset.name)] = asset.bytes;
  }
  return zipSync(files);
}

/**
 * Extract the manifest + assets from `.tmap` bytes (FR-103). Never throws for
 * the expected failure paths: a corrupt ZIP, a missing required entry, or
 * malformed manifest JSON all return a discriminated `ok:false` result so the
 * caller can map them to a 拒否理由 (受け入れ基準5). The manifest is returned as
 * raw `unknown` — validation happens at the parse boundary, not here.
 */
export function readTmap(bytes: Uint8Array, caps: ReadTmapCaps = {}): ReadTmapResult {
  const maxContainer = caps.maxContainerBytes ?? MAX_TMAP_BYTES;
  const maxEntry = caps.maxEntryBytes ?? MAX_TMAP_ENTRY_BYTES;
  // Container cap — a belt at the byte layer (the IPC handler stat-rejects earlier,
  // but every caller of this pure adapter gets the same bound).
  if (bytes.length > maxContainer) {
    return {
      ok: false,
      reason: 'corrupt',
      message: `ファイルが大きすぎます（上限 ${Math.floor(maxContainer / (1024 * 1024))} MB）。`,
    };
  }
  const maxTotal = caps.maxTotalBytes ?? MAX_TMAP_TOTAL_BYTES;
  const entryTooLarge = (name: string): ReadTmapResult => ({
    ok: false,
    reason: 'corrupt',
    message: `エントリ ${name} が大きすぎます（上限 ${Math.floor(maxEntry / (1024 * 1024))} MB）。`,
  });
  const totalTooLarge: ReadTmapResult = {
    ok: false,
    reason: 'corrupt',
    message: `展開後の合計サイズが大きすぎます（上限 ${Math.floor(maxTotal / (1024 * 1024))} MB）。`,
  };
  let entries: Record<string, Uint8Array>;
  // Zip-bomb guard, first line: fflate's filter sees each entry's DECLARED expanded
  // size (originalSize) BEFORE decompression, so an honestly-declared huge entry —
  // or an honestly-declared set whose SUM is huge (Sol review #2) — is rejected
  // without ever expanding it.
  let oversizedEntry: string | undefined;
  let declaredTotal = 0;
  let declaredTotalExceeded = false;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (file.originalSize > maxEntry) {
          oversizedEntry = file.name;
          return false;
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > maxTotal) {
          declaredTotalExceeded = true;
          return false;
        }
        return true;
      },
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'corrupt',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (oversizedEntry !== undefined) return entryTooLarge(oversizedEntry);
  if (declaredTotalExceeded) return totalTooLarge;
  // Second line (Sol review #1): the DECLARED size is attacker-controlled — a forged
  // central directory can under-declare. Re-verify the ACTUAL expanded lengths.
  // Residual (documented): a forged-small declaration still makes fflate process the
  // whole deflate stream synchronously (output truncated, memory bounded); that CPU
  // cost is bounded by the container cap above, and the truncated data then fails
  // the manifest/asset consumers — a hostile file only corrupts itself.
  let actualTotal = 0;
  for (const [entryName, entryBytes] of Object.entries(entries)) {
    if (entryBytes.length > maxEntry) return entryTooLarge(entryName);
    actualTotal += entryBytes.length;
    if (actualTotal > maxTotal) return totalTooLarge;
  }

  const manifestBytes = entries[MANIFEST_ENTRY];
  if (manifestBytes === undefined) {
    return {
      ok: false,
      reason: 'missing-entry',
      entry: MANIFEST_ENTRY,
      message: `必須エントリ ${MANIFEST_ENTRY} が見つかりません。`,
    };
  }

  const baseMapImage = entries[BASEMAP_ENTRY];
  if (baseMapImage === undefined) {
    return {
      ok: false,
      reason: 'missing-entry',
      entry: BASEMAP_ENTRY,
      message: `必須エントリ ${BASEMAP_ENTRY} が見つかりません。`,
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch (error) {
    return {
      ok: false,
      reason: 'corrupt',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const attachments: NamedAsset[] = [];
  for (const [entryPath, entryBytes] of Object.entries(entries)) {
    const name = attachmentNameOf(entryPath);
    if (name !== undefined) attachments.push({ name, bytes: entryBytes });
  }
  // Stable order so round-trips compare deterministically (名前昇順).
  attachments.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { ok: true, contents: { manifest, baseMapImage, attachments } };
}
