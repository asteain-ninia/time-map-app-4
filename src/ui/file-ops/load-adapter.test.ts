// U39 both-side adapter test (受け入れ基準 6 / 教訓 5.33): pins the mapping from
// U15's `LoadResponse` (shell IPC contract) to the flow's `LoadTransport` for
// EVERY variant, then drives the mapped transport through `classifyLoad` to prove
// the end-to-end seam (the review's missing adapter/test). A drift on either side
// — a renamed reason, a dropped `invalid`/version case — fails here.

import { describe, expect, it } from 'vitest';

import {
  PARSE_OUTCOME,
  type ConsistencyReport,
  type Manifest,
  type ParseResult,
} from '../../domain/persistence/index';
import type { LoadResponse } from '../../shell/ipc/contract';

import { loadTransportFrom } from './load-adapter';
import { LOAD_STEP, LOAD_TRANSPORT_REASON, classifyLoad } from './load-flow';

const MANIFEST = {} as Manifest; // classifyLoad never reads the body.
const EMPTY_REPORT: ConsistencyReport = { ok: true, inconsistencies: [] };

describe('loadTransportFrom (U15 LoadResponse → LoadTransport, 教訓 5.33)', () => {
  it('success → ok transport carrying a ParseResult Ok with the validated manifest', () => {
    const response: LoadResponse = {
      ok: true,
      path: '/tmp/p.gimoza',
      manifest: MANIFEST,
      baseMapImage: new Uint8Array(),
      attachments: [],
    };
    const transport = loadTransportFrom(response);
    expect(transport.ok).toBe(true);
    if (transport.ok) {
      expect(transport.path).toBe('/tmp/p.gimoza');
      expect(transport.parse.outcome).toBe(PARSE_OUTCOME.Ok);
    }
    // End-to-end: an Ok parse + empty report reflects directly.
    expect(classifyLoad(transport, EMPTY_REPORT).kind).toBe(LOAD_STEP.ReflectDirect);
  });

  it('cancelled → Cancelled transport (no warning)', () => {
    const transport = loadTransportFrom({ ok: false, reason: 'cancelled' });
    expect(transport).toEqual({ ok: false, reason: LOAD_TRANSPORT_REASON.Cancelled });
    expect(classifyLoad(transport, undefined).kind).toBe(LOAD_STEP.Cancelled);
  });

  it('read-failed → ReadFailed transport with the Japanese message', () => {
    const transport = loadTransportFrom({
      ok: false,
      reason: 'read-failed',
      message: '読み込み失敗',
    });
    expect(transport).toEqual({
      ok: false,
      reason: LOAD_TRANSPORT_REASON.ReadFailed,
      message: '読み込み失敗',
    });
    const step = classifyLoad(transport, undefined);
    expect(step.kind).toBe(LOAD_STEP.Reject);
  });

  it('corrupt → Corrupt transport', () => {
    const transport = loadTransportFrom({
      ok: false,
      reason: 'corrupt',
      message: '壊れています',
    });
    expect(transport).toEqual({
      ok: false,
      reason: LOAD_TRANSPORT_REASON.Corrupt,
      message: '壊れています',
    });
    expect(classifyLoad(transport, undefined).kind).toBe(LOAD_STEP.Reject);
  });

  it('invalid with a structured parse → preserves the parse + routes by parse outcome', () => {
    const parse: ParseResult = {
      outcome: PARSE_OUTCOME.VersionIncompatible,
      foundVersion: '0.0',
      supportedVersion: '1',
      message: '非対応バージョン',
    };
    const transport = loadTransportFrom({
      ok: false,
      reason: 'invalid',
      message: '形式不正',
      parse,
    });
    expect(transport.ok).toBe(false);
    if (!transport.ok && transport.reason === LOAD_TRANSPORT_REASON.Invalid) {
      expect(transport.parse).toBe(parse);
    }
    // The structured parse is NOT lost: it rejects as version-incompatible, not generic.
    const step = classifyLoad(transport, undefined);
    expect(step.kind).toBe(LOAD_STEP.Reject);
    if (step.kind === LOAD_STEP.Reject) {
      expect(step.reason).toBe('version-incompatible');
    }
  });

  it('invalid WITHOUT a parse → falls back to a generic Invalid parse (still rejects)', () => {
    const transport = loadTransportFrom({
      ok: false,
      reason: 'invalid',
      message: '形式不正',
    });
    if (!transport.ok && transport.reason === LOAD_TRANSPORT_REASON.Invalid) {
      expect(transport.parse.outcome).toBe(PARSE_OUTCOME.Invalid);
    }
    const step = classifyLoad(transport, undefined);
    expect(step.kind).toBe(LOAD_STEP.Reject);
    if (step.kind === LOAD_STEP.Reject) {
      expect(step.reason).toBe('invalid');
    }
  });
});
