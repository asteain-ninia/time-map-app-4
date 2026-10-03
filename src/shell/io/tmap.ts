// 命名について: 本ファイル名およびこの層の識別子にある「Tmap」は、アプリの正式名称
// である「gimoza」と同じものを指す。`tmap` は開発初期のコードネームで、保存ファイル
// の拡張子は `.gimoza` に統一済みだが、内部識別子 (`readTmap` / `buildTmap` /
// `TmapContents` / このファイル名など) はコードネーム時代の名残としてそのまま残して
// ある。つまり「Tmap = gimoza」であり、両者に意味の違いはない。
//
// U15 — the `.gimoza` ZIP container read/write ADAPTERS (技術方針 2.12 / FR-103).
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
import { SHELL_IO_STRINGS } from './strings';

/** Inputs to {@link buildTmap}: the manifest value plus the binary assets. */
export interface TmapContents {
  /** The manifest value to JSON-encode (already serialized by U14). */
  readonly manifest: unknown;
  /** Base-map image bytes. */
  readonly baseMapImage: Uint8Array;
  /** Attached document images (may be empty — 0 is a valid count, 教訓5.18). */
  readonly attachments: readonly NamedAsset[];
}

/** What {@link readTmap} extracts from a `.gimoza` byte stream. */
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

/** Why reading a `.gimoza` failed (corrupt zip / missing required entry / bad JSON). */
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
 * Assemble a `.gimoza` ZIP byte array from the manifest + assets (FR-103). The
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
 * Extract the manifest + assets from `.gimoza` bytes (FR-103). Never throws for
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
      message: SHELL_IO_STRINGS.fileTooLarge(Math.floor(maxContainer / (1024 * 1024))),
    };
  }
  const maxTotal = caps.maxTotalBytes ?? MAX_TMAP_TOTAL_BYTES;
  const entryTooLarge = (name: string): ReadTmapResult => ({
    ok: false,
    reason: 'corrupt',
    message: SHELL_IO_STRINGS.entryTooLarge(name, Math.floor(maxEntry / (1024 * 1024))),
  });
  const totalTooLarge: ReadTmapResult = {
    ok: false,
    reason: 'corrupt',
    message: SHELL_IO_STRINGS.totalTooLarge(Math.floor(maxTotal / (1024 * 1024))),
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
  // Second line: the DECLARED size is attacker-controlled — a forged central
  // directory can under-declare. Re-verify the ACTUAL expanded lengths.
  //
  // ACCEPTED RESIDUAL (Sol 3周目 #1 — なぜここで止めるか): fflate's `unzipSync`
  // inflates each entry into a buffer sized to its DECLARED `originalSize`, so a
  // forged-small declaration is TRUNCATED to that small size — memory stays bounded
  // (the actual re-check below then sees the truncated length, which is why it
  // cannot catch a forged bomb). The only residual is CPU: the deflate stream is
  // decompressed to completion, bounded by the 1 GiB CONTAINER cap already enforced
  // above (compressed input ≤ 1 GiB → a one-time, bounded main-thread stall on a
  // hand-crafted file). Truly streaming, byte-exact CPU bounding needs guaranteed
  // per-chunk output sizes from fflate's internals; for a LOCAL single-user offline
  // tool opening a file the user chose, that complexity is not warranted (this is
  // the over-engineering line — the round-2 streaming rewrite that chased it also
  // regressed truncated-archive completeness [#2] and prefixed-ZIP tolerance [#4],
  // both of which `unzipSync` handles correctly, so it was reverted).
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
      message: SHELL_IO_STRINGS.missingEntry(MANIFEST_ENTRY),
    };
  }

  const baseMapImage = entries[BASEMAP_ENTRY];
  if (baseMapImage === undefined) {
    return {
      ok: false,
      reason: 'missing-entry',
      entry: BASEMAP_ENTRY,
      message: SHELL_IO_STRINGS.missingEntry(BASEMAP_ENTRY),
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

/**
 * 保存ファイルの中の **地物の数**（増分 8D。世代の一覧の「地物数」の列）。
 *
 * 世代の一覧は 10 個前後のファイルを一度に読むので、背景地図や添付は展開しない
 * ―― **マニフェストの 1 エントリだけ**を取り出して数える。数えるのは全部の歴史・全部の
 * 錨の写しに出てくる地物 ID の **種類の数**（同じ地物が 100 個の錨に出ても 1 と数える）。
 *
 * 壊れている・形が違う・大きすぎるファイルは `null`（＝画面は「—」）。**その 1 行だけを
 * 「読めない」にして、一覧そのものは出す** ―― 壊れた世代が 1 つ混ざっていても、ほかの
 * 世代から戻れなくなってはいけない。Zod の境界は通さない（ここは一覧の目安の数で、
 * 開くときには `loadTmapBytes` がいつもどおり検証する）。
 */
export function countFeaturesInTmap(bytes: Uint8Array, caps: ReadTmapCaps = {}): number | null {
  const maxContainer = caps.maxContainerBytes ?? MAX_TMAP_BYTES;
  const maxEntry = caps.maxEntryBytes ?? MAX_TMAP_ENTRY_BYTES;
  if (bytes.length > maxContainer) return null;
  let manifestBytes: Uint8Array | undefined;
  try {
    const entries = unzipSync(bytes, {
      filter: (file) => file.name === MANIFEST_ENTRY && file.originalSize <= maxEntry,
    });
    manifestBytes = entries[MANIFEST_ENTRY];
  } catch {
    return null;
  }
  if (manifestBytes === undefined || manifestBytes.length > maxEntry) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    return null;
  }
  return countManifestFeatures(manifest);
}

/**
 * 生のマニフェスト（検証前の JSON）から地物 ID の種類の数を数える。形が違えば `null`。
 * `histories[].entries[].anchor.snapshot.features[].id` を辿る（schema.ts の形）。
 */
export function countManifestFeatures(manifest: unknown): number | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const histories = (manifest as { histories?: unknown }).histories;
  if (!Array.isArray(histories)) return null;
  const ids = new Set<string>();
  for (const history of histories) {
    const entries = (history as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      const features = (
        entry as { anchor?: { snapshot?: { features?: unknown } } } | null
      )?.anchor?.snapshot?.features;
      if (!Array.isArray(features)) return null;
      for (const feature of features) {
        const id = (feature as { id?: unknown } | null)?.id;
        if (typeof id === 'string') ids.add(id);
      }
    }
  }
  return ids.size;
}
