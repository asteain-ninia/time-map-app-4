// U14 — the external-input PARSE BOUNDARY (R8 / FR-104 / FR-116).
//
// This is the ONLY sanctioned entry point through which raw external input (IPC
// payloads, file-read bytes already turned into a JS value, external-map input)
// is allowed to become a typed domain manifest. Every such boundary MUST route
// through `parseManifest` here so an unvalidated value can never reach the
// domain (spec 受け入れ基準8). The module is named `boundary` precisely so the
// lint rule can target it: shell / IPC code may import `parseManifest` from this
// module, but may NOT hand a bare `unknown` to the deserializer directly.
//
// FR-104 version handling: the FIRST thing checked is the manifest's `version`
// string. If it is missing / not a string / not the supported value, the result
// is a structured INCOMPATIBLE outcome (warned or rejected — never migrated),
// carrying BOTH a machine-readable code (for tests / callers) AND a 日本語 user
// message (教訓5.26: 拒否理由は通知と戻り値の両方で). Only a version-compatible
// payload proceeds to the full structural (Zod) validation.
//
// Pure & framework-free: takes an `unknown`, returns a discriminated result. No
// I/O, no throwing for the expected rejection paths.

import { z } from 'zod';

import {
  SCHEMA_VERSION,
  manifestSchema,
  type Manifest,
} from './schema';

/** Why a parse attempt did not yield a usable manifest. */
export const PARSE_OUTCOME = {
  /** The payload is a valid, version-compatible manifest. */
  Ok: 'ok',
  /** The `version` is missing / unreadable: cannot even classify the format. */
  VersionMissing: 'version-missing',
  /** The `version` is a known shape but not a value this build supports. */
  VersionIncompatible: 'version-incompatible',
  /** Version is fine but the body failed structural (Zod) validation. */
  Invalid: 'invalid',
} as const;

export type ParseOutcomeKind = (typeof PARSE_OUTCOME)[keyof typeof PARSE_OUTCOME];

/** A single structural issue (path + message) for the Invalid outcome. */
export interface ParseIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Result of {@link parseManifest}. On success the typed manifest is exposed; on
 * any failure a machine code AND a 日本語 message are returned so the UI can
 * notify the user while tests assert on the code (教訓5.26).
 */
export type ParseResult =
  | { readonly outcome: typeof PARSE_OUTCOME.Ok; readonly manifest: Manifest }
  | {
      readonly outcome: typeof PARSE_OUTCOME.VersionMissing;
      readonly message: string;
    }
  | {
      readonly outcome: typeof PARSE_OUTCOME.VersionIncompatible;
      readonly foundVersion: string;
      readonly supportedVersion: string;
      readonly message: string;
    }
  | {
      readonly outcome: typeof PARSE_OUTCOME.Invalid;
      readonly issues: readonly ParseIssue[];
      readonly message: string;
    };

// --- 日本語 user messages (FR-115; gathered as constants, 技術方針 5.5) ------

export const MSG_VERSION_MISSING =
  'ファイル形式のバージョン情報が見つかりません。対応していない、または壊れたファイルの可能性があります。';

export const MSG_VERSION_INCOMPATIBLE =
  'このファイルは現在のバージョンでは対応していない形式です。読み込みを中止しました。';

export const MSG_INVALID =
  'ファイルの内容が壊れているか、形式が正しくありません。読み込みできませんでした。';

// --- the boundary entry point -----------------------------------------------

/** Shallow read of the `version` field without trusting the rest of the value. */
function readVersion(input: unknown): { kind: 'missing' } | { kind: 'found'; version: string } {
  if (typeof input !== 'object' || input === null) return { kind: 'missing' };
  const v = (input as Record<string, unknown>)['version'];
  if (typeof v !== 'string') return { kind: 'missing' };
  return { kind: 'found', version: v };
}

/**
 * Parse and validate an arbitrary external value into a typed {@link Manifest}.
 * Order (FR-104): (1) classify the version first, returning an incompatibility
 * result WITHOUT touching the body if it is unknown; (2) only then run the full
 * Zod structural validation. A version-compatible-but-malformed body yields the
 * Invalid outcome with per-issue detail.
 *
 * This is the single boundary the lint rule guards (R8): the domain must never
 * receive a manifest that did not pass through here.
 */
export function parseManifest(input: unknown): ParseResult {
  const version = readVersion(input);
  if (version.kind === 'missing') {
    return { outcome: PARSE_OUTCOME.VersionMissing, message: MSG_VERSION_MISSING };
  }
  if (version.version !== SCHEMA_VERSION) {
    return {
      outcome: PARSE_OUTCOME.VersionIncompatible,
      foundVersion: version.version,
      supportedVersion: SCHEMA_VERSION,
      message: MSG_VERSION_INCOMPATIBLE,
    };
  }

  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      outcome: PARSE_OUTCOME.Invalid,
      issues: toIssues(parsed.error),
      message: MSG_INVALID,
    };
  }
  return { outcome: PARSE_OUTCOME.Ok, manifest: parsed.data };
}

/** True iff the result is the success branch (narrowing helper for callers). */
export function isParsed(result: ParseResult): result is {
  readonly outcome: typeof PARSE_OUTCOME.Ok;
  readonly manifest: Manifest;
} {
  return result.outcome === PARSE_OUTCOME.Ok;
}

/** Map a ZodError's issues to the unit's plain ParseIssue list. */
function toIssues(error: z.ZodError): ParseIssue[] {
  return error.issues.map((issue) => ({
    path: [...issue.path],
    message: issue.message,
  }));
}
