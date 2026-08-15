import { describe, expect, it } from 'vitest';

import {
  PARSE_OUTCOME,
  type ConsistencyReport,
  type Manifest,
  type ParseResult,
} from '../../domain/persistence/index';

import { LOAD_STEP, classifyLoad, type LoadTransport } from './load-flow';

// A stand-in Ok parse: classifyLoad only branches on `outcome`, never reads the
// manifest body, so a cast keeps the test focused on the flow decision (the
// manifest content is exercised by U14's own tests).
const OK_PARSE: ParseResult = {
  outcome: PARSE_OUTCOME.Ok,
  manifest: {} as Manifest,
};

const EMPTY_REPORT: ConsistencyReport = { ok: true, inconsistencies: [] };
const NONEMPTY_REPORT: ConsistencyReport = {
  ok: false,
  inconsistencies: [
    {
      kind: 'shape-preservation',
      featureIds: [],
      featureNames: ['A国'],
      detail: 'leaf-empty-shape',
    },
  ],
};

function transportOk(parse: ParseResult): LoadTransport {
  return { ok: true, path: '/tmp/p.gimoza', parse };
}

describe('classifyLoad (single load flow, 教訓 5.6 / FR-104 / FR-106)', () => {
  it('cancelled transport → Cancelled (no warning)', () => {
    expect(classifyLoad({ ok: false, reason: 'cancelled' }, undefined)).toEqual({
      kind: LOAD_STEP.Cancelled,
    });
  });

  it('read-failed transport → Reject with the Japanese message', () => {
    const step = classifyLoad(
      { ok: false, reason: 'read-failed', message: '読み込み失敗' },
      undefined,
    );
    expect(step.kind).toBe(LOAD_STEP.Reject);
    if (step.kind === LOAD_STEP.Reject) {
      expect(step.reason).toBe('read-failed');
      expect(step.message).toBe('読み込み失敗');
    }
  });

  it('version-incompatible parse → Reject, load aborted (no migration)', () => {
    const parse: ParseResult = {
      outcome: PARSE_OUTCOME.VersionIncompatible,
      foundVersion: '0.0',
      supportedVersion: '1',
      message: '非対応バージョン',
    };
    const step = classifyLoad(transportOk(parse), undefined);
    expect(step.kind).toBe(LOAD_STEP.Reject);
    if (step.kind === LOAD_STEP.Reject) {
      expect(step.reason).toBe('version-incompatible');
    }
  });

  it('version-missing parse → Reject', () => {
    const parse: ParseResult = { outcome: PARSE_OUTCOME.VersionMissing, message: 'バージョン無し' };
    const step = classifyLoad(transportOk(parse), undefined);
    expect(step.kind).toBe(LOAD_STEP.Reject);
  });

  it('invalid (Zod) parse → Reject', () => {
    const parse: ParseResult = {
      outcome: PARSE_OUTCOME.Invalid,
      issues: [{ path: ['x'], message: 'bad' }],
      message: '形式不正',
    };
    const step = classifyLoad(transportOk(parse), undefined);
    expect(step.kind).toBe(LOAD_STEP.Reject);
    if (step.kind === LOAD_STEP.Reject) {
      expect(step.reason).toBe('invalid');
    }
  });

  it('Ok parse + EMPTY report → ReflectDirect (受け入れ基準 3 空レポートは正当値)', () => {
    const step = classifyLoad(transportOk(OK_PARSE), EMPTY_REPORT);
    expect(step.kind).toBe(LOAD_STEP.ReflectDirect);
  });

  it('Ok parse + undefined report → ReflectDirect (no false confirmation)', () => {
    const step = classifyLoad(transportOk(OK_PARSE), undefined);
    expect(step.kind).toBe(LOAD_STEP.ReflectDirect);
  });

  it('Ok parse + NON-empty report → Repair (open the auto-repair UI)', () => {
    const step = classifyLoad(transportOk(OK_PARSE), NONEMPTY_REPORT);
    expect(step.kind).toBe(LOAD_STEP.Repair);
    if (step.kind === LOAD_STEP.Repair) {
      expect(step.report).toBe(NONEMPTY_REPORT);
    }
  });
});
