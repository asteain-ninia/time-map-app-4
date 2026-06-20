// UI layer (U39): the single load FLOW classifier (FR-104 / FR-106 / FR-116).
//
// Every load entry (menu 読み込み / shortcut / D&D) funnels through ONE flow
// (spec §A 同一フローへの収束, 教訓 5.6): unsaved-guard → U15 load → U14 parse/
// version classification → U14 consistency check → auto-repair UI → reflect. This
// module owns the PURE classification step that decides what the UI does with a
// load result, so the decision is unit-testable with no Electron (受け入れ基準 7).
//
// SINGLE SOURCE OF TRUTH (教訓 5.33): the version / structural outcomes come from
// U14's `ParseResult` (`PARSE_OUTCOME`) and the load transport outcomes from U15's
// `LoadResponse`. This module re-classifies them into the UI's next step; it never
// re-defines a parallel reason vocabulary.

import {
  PARSE_OUTCOME,
  type ConsistencyReport,
  type ParseResult,
} from '../../domain/persistence/index';

// --- the load transport reason vocabulary (SINGLE SOURCE, 教訓 5.33) ---------
//
// The transport-failure reasons are declared ONCE here and the `load-adapter`
// maps U15's `LoadResponse.reason` onto them through a TOTAL mapping fixed by
// both-side tests, so a reason can never be silently dropped (the review's
// 'invalid'/version 取りこぼし regression is pinned). U15's `LoadResponse` failure
// reasons are `'cancelled' | 'read-failed' | 'corrupt' | 'invalid'`; we mirror
// exactly that set so the adapter's mapping is exhaustive at the type level.
export const LOAD_TRANSPORT_REASON = {
  /** User dismissed the open dialog (not an error, not a success). */
  Cancelled: 'cancelled',
  /** The file could not be read (I/O error). */
  ReadFailed: 'read-failed',
  /** The `.tmap` container is broken / cannot be unzipped. */
  Corrupt: 'corrupt',
  /**
   * The file was read but its manifest failed Zod / version validation. Carries
   * the STRUCTURED `ParseResult` so the flow can render the right rejection
   * (version-missing / version-incompatible / invalid) rather than a generic one.
   */
  Invalid: 'invalid',
} as const;

export type LoadTransportReason =
  (typeof LOAD_TRANSPORT_REASON)[keyof typeof LOAD_TRANSPORT_REASON];

// --- the load transport result (U15 contract, mapped by the adapter) --------
//
// U15's `LoadResponse` lives in the shell layer (`shell/ipc/contract`). The ui
// layer is `ui → domain / ui-state` only (技術方針 2.13), so we accept the load
// outcome as a STRUCTURAL value the `load-adapter` maps from `LoadResponse`
// rather than importing the shell contract directly in the flow (the adapter
// fixes the contract on BOTH sides with unit tests, 教訓 5.33). This is the
// minimal shape the flow needs — and it covers EVERY `LoadResponse` variant,
// including `invalid` (which carries the structured parse).
export type LoadTransport =
  | { readonly ok: true; readonly path: string; readonly parse: ParseResult }
  | { readonly ok: false; readonly reason: typeof LOAD_TRANSPORT_REASON.Cancelled }
  | {
      readonly ok: false;
      readonly reason:
        | typeof LOAD_TRANSPORT_REASON.ReadFailed
        | typeof LOAD_TRANSPORT_REASON.Corrupt;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: typeof LOAD_TRANSPORT_REASON.Invalid;
      readonly message: string;
      /** The structured parse result so the flow renders the right rejection. */
      readonly parse: ParseResult;
    };

// --- what the UI must do next ------------------------------------------------

export const LOAD_STEP = {
  /** The user dismissed the open dialog: do nothing, keep current state. */
  Cancelled: 'cancelled',
  /** Show a Japanese warning and abort the load (read/corrupt/version/invalid). */
  Reject: 'reject',
  /** No inconsistency: reflect the parsed project directly (受け入れ基準 3 空レポート). */
  ReflectDirect: 'reflect-direct',
  /** Inconsistencies found: open the auto-repair UI before reflecting. */
  Repair: 'repair',
} as const;

export type LoadStepKind = (typeof LOAD_STEP)[keyof typeof LOAD_STEP];

/**
 * The classified next step. `Reject` carries a Japanese message AND a machine
 * `reason` (教訓 5.26: 通知と戻り値の両方). `ReflectDirect` / `Repair` carry the
 * validated parse result so the caller proceeds without re-parsing.
 */
export type LoadStep =
  | { readonly kind: typeof LOAD_STEP.Cancelled }
  | {
      readonly kind: typeof LOAD_STEP.Reject;
      readonly reason: 'read-failed' | 'corrupt' | 'version-missing' | 'version-incompatible' | 'invalid';
      readonly message: string;
    }
  | {
      readonly kind: typeof LOAD_STEP.ReflectDirect;
      readonly parse: Extract<ParseResult, { outcome: typeof PARSE_OUTCOME.Ok }>;
    }
  | {
      readonly kind: typeof LOAD_STEP.Repair;
      readonly parse: Extract<ParseResult, { outcome: typeof PARSE_OUTCOME.Ok }>;
      readonly report: ConsistencyReport;
    };

/**
 * Classify a transport result + its consistency report into the next UI step.
 *
 * `report` is OPTIONAL because it is only computed for a structurally-valid parse;
 * the caller runs U14's `checkConsistency` only after this function would return
 * `ReflectDirect`/`Repair`. To keep the decision pure & total, callers pass the
 * report computed from the Ok parse; for the reject / cancel branches it is
 * ignored. When the parse is Ok and the report is empty (受け入れ基準 3: 空レポート
 * は正当値), the step is `ReflectDirect` — no repair UI, no false confirmation.
 */
export function classifyLoad(
  transport: LoadTransport,
  report: ConsistencyReport | undefined,
): LoadStep {
  if (!transport.ok) {
    if (transport.reason === LOAD_TRANSPORT_REASON.Cancelled) {
      return { kind: LOAD_STEP.Cancelled };
    }
    // `invalid` carries a STRUCTURED parse: classify it the same way an Ok-
    // transport-with-invalid-parse is classified, so version-missing / version-
    // incompatible / invalid are distinguished (no 取りこぼし, the review's regression).
    if (transport.reason === LOAD_TRANSPORT_REASON.Invalid) {
      return classifyParse(transport.parse, report);
    }
    return { kind: LOAD_STEP.Reject, reason: transport.reason, message: transport.message };
  }

  return classifyParse(transport.parse, report);
}

/** Classify a structural parse result (+ its report) into the next UI step. */
function classifyParse(parse: ParseResult, report: ConsistencyReport | undefined): LoadStep {
  switch (parse.outcome) {
    case PARSE_OUTCOME.VersionMissing:
      return { kind: LOAD_STEP.Reject, reason: 'version-missing', message: parse.message };
    case PARSE_OUTCOME.VersionIncompatible:
      return { kind: LOAD_STEP.Reject, reason: 'version-incompatible', message: parse.message };
    case PARSE_OUTCOME.Invalid:
      return { kind: LOAD_STEP.Reject, reason: 'invalid', message: parse.message };
    case PARSE_OUTCOME.Ok: {
      // A structurally-valid parse: empty report ⇒ reflect directly; otherwise
      // open the repair UI (教訓 5.18: emptiness decided by the report flag/length).
      if (report === undefined || (report.ok && report.inconsistencies.length === 0)) {
        return { kind: LOAD_STEP.ReflectDirect, parse };
      }
      return { kind: LOAD_STEP.Repair, parse, report };
    }
  }
}
