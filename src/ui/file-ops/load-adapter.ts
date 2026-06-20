// UI layer (U39): the EXPLICIT adapter from U15's `LoadResponse` (shell IPC
// contract) to the flow's {@link LoadTransport} (受け入れ基準 6 / 教訓 5.33).
//
// THE SEAM, IN ONE PLACE (the review's finding): U15's `LoadResponse` and the
// flow's `LoadTransport` are SHAPED DIFFERENTLY on purpose —
//   - success: `LoadResponse` carries `{ path, manifest, baseMapImage, attachments }`
//     while the flow needs `{ path, parse: ParseResult }`. We wrap the already-
//     Zod-validated `manifest` (main validated it, FR-104/116) into a `ParseResult`
//     Ok so the SAME `classifyLoad` path handles loaded files and any parse case.
//   - failure: `LoadResponse.reason` is `'cancelled' | 'read-failed' | 'corrupt'
//     | 'invalid'`; the `invalid` variant keeps the STRUCTURED `parse`, which the
//     flow routes through the version/structural classifier rather than a generic
//     reject (so version-missing / version-incompatible / invalid are NOT 取りこぼし).
//
// This is the ONLY module that imports BOTH `LoadResponse` (shell) and
// `LoadTransport` (this unit), and `load-adapter.test.ts` pins every variant on
// both sides (教訓 5.33: a drift on one side fails a test). `ui → shell` is an
// allowed import direction (eslint layerBoundaries forbids only shell→ui), and
// the shell contract is a pure type/const module (no Electron pulled in).

import { PARSE_OUTCOME } from '../../domain/persistence/index';
import type { LoadResponse } from '../../shell/ipc/contract';

import { LOAD_TRANSPORT_REASON, type LoadTransport } from './load-flow';

/**
 * Map a U15 {@link LoadResponse} to the flow's {@link LoadTransport}. TOTAL over
 * every `LoadResponse` variant — the `switch` is exhaustive on `ok` and on the
 * failure `reason`, so a new `LoadResponse` reason added in the shell contract
 * fails to type-check here until it is mapped (no silent取りこぼし, 教訓 5.33).
 */
export function loadTransportFrom(response: LoadResponse): LoadTransport {
  if (response.ok) {
    // The manifest is already Zod-validated by main (FR-104/116); present it as a
    // ParseResult Ok so the loaded-file path reuses `classifyLoad` unchanged.
    return {
      ok: true,
      path: response.path,
      parse: { outcome: PARSE_OUTCOME.Ok, manifest: response.manifest },
    };
  }

  switch (response.reason) {
    case 'cancelled':
      return { ok: false, reason: LOAD_TRANSPORT_REASON.Cancelled };
    case 'read-failed':
      return {
        ok: false,
        reason: LOAD_TRANSPORT_REASON.ReadFailed,
        message: response.message,
      };
    case 'corrupt':
      return {
        ok: false,
        reason: LOAD_TRANSPORT_REASON.Corrupt,
        message: response.message,
      };
    case 'invalid':
      // Preserve the structured parse when U15 supplies it (FR-104). If main did
      // not attach a parse (defensive), fall back to a generic Invalid parse so
      // the flow still rejects with the Japanese message — never reflects it.
      return {
        ok: false,
        reason: LOAD_TRANSPORT_REASON.Invalid,
        message: response.message,
        parse:
          response.parse ??
          {
            outcome: PARSE_OUTCOME.Invalid,
            issues: [],
            message: response.message,
          },
      };
  }
}
