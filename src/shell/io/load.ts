// U15 — the LOAD adapter: read `.gimoza` bytes → extract → MANDATORY Zod parse
// boundary → typed result (R8 / FR-104 / FR-116 / 受け入れ基準5).
//
// This is the ONLY path that turns file bytes into a domain-bound manifest, and
// it CANNOT skip validation: after `readTmap` extracts the raw manifest, it is
// handed to U14 `parseManifest` (the single Zod boundary). There is no exported
// function here that returns an un-validated manifest to the caller — a corrupt
// ZIP, a missing entry, a version mismatch and a schema mismatch all become a
// discriminated `LoadResponse` rejection carrying a 日本語 message (拒否理由は
// 通知と戻り値の両方で, 教訓5.26). Never throws for these expected paths.
//
// Pure given its bytes (Electron-free, 受け入れ基準7): the dialog / fs read that
// produces the bytes live in the IPC handler; this function takes the bytes and
// the resolved path.

import {
  isParsed,
  parseManifest,
  PARSE_OUTCOME,
} from '../../domain/persistence/boundary';
import type { LoadResponse } from '../ipc/contract';
import { readTmap } from './tmap';

/**
 * Decode + validate `.gimoza` bytes into a {@link LoadResponse}. Order:
 *   1. unzip + extract (readTmap) — corrupt/missing-entry → reject;
 *   2. parseManifest (Zod boundary) — version/schema mismatch → reject, NEVER
 *      migrate (spec §やらないこと);
 *   3. success → return the typed manifest + extracted assets.
 */
export function loadTmapBytes(path: string, bytes: Uint8Array): LoadResponse {
  const extracted = readTmap(bytes);
  if (!extracted.ok) {
    return { ok: false, reason: 'corrupt', message: extracted.message };
  }

  const parsed = parseManifest(extracted.contents.manifest);
  if (!isParsed(parsed)) {
    // Map every non-Ok parse outcome to an `invalid` rejection that still
    // carries the structured ParseResult (so the UI can distinguish version vs
    // schema issues) plus the boundary's 日本語 message.
    const message =
      parsed.outcome === PARSE_OUTCOME.VersionMissing ||
      parsed.outcome === PARSE_OUTCOME.VersionIncompatible ||
      parsed.outcome === PARSE_OUTCOME.Invalid
        ? parsed.message
        : 'ファイルの読み込みに失敗しました。';
    return { ok: false, reason: 'invalid', message, parse: parsed };
  }

  return {
    ok: true,
    path,
    manifest: parsed.manifest,
    baseMapImage: extracted.contents.baseMapImage,
    attachments: extracted.contents.attachments,
  };
}
