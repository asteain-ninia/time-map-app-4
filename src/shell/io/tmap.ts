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

import { strFromU8, strToU8, Unzip, UnzipInflate, UnzipPassThrough, zipSync } from 'fflate';

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
  // 展開サイズ上限 — STREAMING enforcement (Sol review 2周目 #1 根治). The previous
  // `unzipSync` designs could not truly bound the work: the size a ZIP DECLARES
  // (central directory) is under the file author's control, and `unzipSync` keeps
  // processing an entry's whole deflate stream even when the declared output buffer
  // is smaller — so neither a declared-size filter nor an after-the-fact length
  // check bounds CPU (実測: 宣言 8B に改変した 64 MiB エントリでも全ストリームを同期
  // 処理). fflate's streaming `Unzip` + sync `UnzipInflate` emits the ACTUAL output
  // in chunks as it inflates; counting those chunks and THROWING from `ondata`
  // unwinds the synchronous `push` immediately — decompression work is bounded by
  // the caps regardless of what the file claims about itself. Entries outside the
  // `.tmap` layout (never consumed) are not even started.
  class CapExceeded extends Error {
    constructor(readonly verdict: ReadTmapResult) {
      super('tmap-cap-exceeded');
    }
  }
  // Structural gate (受け入れ基準5): the streaming `Unzip` — unlike `unzipSync` —
  // does NOT throw on non-ZIP bytes; it simply discovers no entries and we would
  // fall through to a misleading `missing-entry`. A real `.tmap` always begins with
  // a ZIP local-file-header signature (`PK\x03\x04`); the only other valid start is
  // an empty-archive end-of-central-directory (`PK\x05\x06`), which has no manifest
  // and is corrupt for our purposes too. Anything else is corrupt, reported as such.
  const looksLikeZip =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
  if (!looksLikeZip) {
    return { ok: false, reason: 'corrupt', message: 'ZIP 形式ではありません。' };
  }
  const entries: Record<string, Uint8Array> = {};
  let actualTotal = 0;
  try {
    const unzip = new Unzip((file) => {
      const name = file.name;
      const wanted =
        name === MANIFEST_ENTRY || name === BASEMAP_ENTRY || attachmentNameOf(name) !== undefined;
      if (!wanted) return; // not started ⇒ not decompressed (層外エントリは仕事ゼロ).
      const chunks: Uint8Array[] = [];
      let written = 0;
      file.ondata = (err, chunk, final) => {
        if (err) throw err;
        written += chunk.length;
        actualTotal += chunk.length;
        if (written > maxEntry) throw new CapExceeded(entryTooLarge(name));
        if (actualTotal > maxTotal) throw new CapExceeded(totalTooLarge);
        chunks.push(chunk);
        if (final) {
          const whole = new Uint8Array(written);
          let offset = 0;
          for (const c of chunks) {
            whole.set(c, offset);
            offset += c.length;
          }
          entries[name] = whole;
        }
      };
      file.start();
    });
    // Deflate (zipSync's default) + stored entries; any other method makes
    // `start()` throw, which the catch below maps to a corrupt rejection.
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);
    unzip.push(bytes, true);
  } catch (error) {
    if (error instanceof CapExceeded) return error.verdict;
    return {
      ok: false,
      reason: 'corrupt',
      message: error instanceof Error ? error.message : String(error),
    };
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
