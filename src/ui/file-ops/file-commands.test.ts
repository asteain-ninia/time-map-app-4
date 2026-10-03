import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import {
  PARSE_OUTCOME,
  type ConsistencyReport,
  type DomainProject,
  type Manifest,
} from '../../domain/persistence/index';

// The repair-retry flow tests (BUG #2 / BUG #5) need to drive completeLoad through
// deterministic REPAIR_OUTCOME sequences without crafting a real domain project that
// provably fails to repair. applyChosenRepairs / buildRepairRows are module imports
// (not ports), so we mock the repair-flow module's APPLY step while keeping the real
// REPAIR_OUTCOME enum; the per-test `applyResults` queue feeds the outcome per call.
const applyResults: unknown[] = [];
vi.mock('./repair-flow', async (importActual) => {
  const actual = await importActual<typeof import('./repair-flow')>();
  return {
    ...actual,
    buildRepairRows: vi.fn(() => []),
    applyChosenRepairs: vi.fn(() => applyResults.shift()),
  };
});

import { REPAIR_OUTCOME, type RepairChoices } from './repair-flow';
import {
  dropLoadCommand,
  newProjectCommand,
  openBackupCommand,
  openCommand,
  quitGuard,
  saveCommand,
  saveSucceeded,
  SAVE_OUTCOME,
  type FileCommandPorts,
  type SaveOutcome,
} from './file-commands';
import { REPAIR_STRINGS } from './strings';
import { UNSAVED_CHOICE } from './unsaved-guard';
import type { LoadTransport } from './load-flow';

afterEach(() => {
  applyResults.length = 0;
  vi.clearAllMocks();
});

const CAL = getCalendar('gregorian');
/** 成功の結末（保存できた先つき）。ほとんどのテストはここを既定にする。 */
const SAVED: SaveOutcome = { kind: SAVE_OUTCOME.Saved, path: '/tmp/x.gimoza' };
const FAKE_PROJECT = { histories: [], settings: {}, baseMap: {} } as unknown as DomainProject;
const CLEAN_REPORT: ConsistencyReport = { ok: true, inconsistencies: [] };
const okTransport = (): LoadTransport => ({
  ok: true,
  path: '/tmp/x.gimoza',
  parse: { outcome: PARSE_OUTCOME.Ok, manifest: {} as Manifest },
});

function makePorts(over: Partial<FileCommandPorts> = {}): FileCommandPorts {
  return {
    guard: {
      isDirty: () => false,
      promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Cancel),
      save: () => Promise.resolve(true),
    },
    save: () => Promise.resolve(SAVED),
    saveAs: () => Promise.resolve(SAVED),
    autoSave: () => Promise.resolve(SAVED),
    load: () => Promise.resolve(okTransport()),
    loadDropped: () => Promise.resolve(okTransport()),
    listBackups: () => Promise.resolve([]),
    openBackup: () => Promise.resolve(okTransport()),
    toProject: () => FAKE_PROJECT,
    checkConsistency: () => CLEAN_REPORT,
    calendar: CAL,
    promptRepair: () => Promise.resolve(null),
    reflectProject: () => {},
    notify: () => {},
    ...over,
  };
}

describe('saveCommand (FR-105 保存 / 名前を付けて保存 委譲)', () => {
  it('saves to the current path when one exists', async () => {
    const save = vi.fn(() => Promise.resolve(SAVED));
    const saveAs = vi.fn(() => Promise.resolve(SAVED));
    const outcome = await saveCommand(makePorts({ save, saveAs }), false);
    expect(outcome).toEqual(SAVED);
    expect(save).toHaveBeenCalledOnce();
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('delegates to 名前を付けて保存 when the path is undetermined', async () => {
    const save = vi.fn(() => Promise.resolve(SAVED));
    const saveAs = vi.fn(() => Promise.resolve(SAVED));
    await saveCommand(makePorts({ save, saveAs }), true);
    expect(saveAs).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  // A5: 真偽値ひとつでは「利用者がやめた」と「書けなかった」が区別できず、前者にも
  // 状態行へ赤い「保存できませんでした」が出ていた。結末は種別で返る。
  it('結末は種別で返る（やめた / 書けなかった を取り違えない）', async () => {
    const cancelled = await saveCommand(
      makePorts({ save: () => Promise.resolve({ kind: SAVE_OUTCOME.Cancelled } as const) }),
      false,
    );
    expect(cancelled.kind).toBe(SAVE_OUTCOME.Cancelled);
    expect(saveSucceeded(cancelled)).toBe(false);

    const failed = await saveCommand(
      makePorts({
        save: () =>
          Promise.resolve({ kind: SAVE_OUTCOME.WriteFailed, message: '書けません' } as const),
      }),
      false,
    );
    expect(failed).toEqual({ kind: SAVE_OUTCOME.WriteFailed, message: '書けません' });
    expect(saveSucceeded(failed)).toBe(false);
    expect(saveSucceeded(SAVED)).toBe(true);
  });
});

describe('openCommand / dropLoadCommand (教訓 5.6 同一ガード・同一フロー)', () => {
  it('open: clean → loads and reflects directly on empty report', async () => {
    const reflectProject = vi.fn();
    await openCommand(makePorts({ reflectProject }));
    expect(reflectProject).toHaveBeenCalledOnce();
  });

  it('D&D: SAME guard + SAME completion as menu load (reflects on empty report)', async () => {
    const reflectProject = vi.fn();
    const loadDropped = vi.fn(() => Promise.resolve(okTransport()));
    await dropLoadCommand(makePorts({ reflectProject, loadDropped }), '/dropped/a.gimoza');
    expect(loadDropped).toHaveBeenCalledWith('/dropped/a.gimoza');
    expect(reflectProject).toHaveBeenCalledOnce();
  });

  it('dirty + キャンセル → load never runs (guard blocks the destructive replace)', async () => {
    const load = vi.fn(() => Promise.resolve(okTransport()));
    await openCommand(
      makePorts({
        guard: {
          isDirty: () => true,
          promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Cancel),
          save: () => Promise.resolve(true),
        },
        load,
      }),
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('version-incompatible → notify, no reflect (no migration)', async () => {
    const notify = vi.fn();
    const reflectProject = vi.fn();
    const transport: LoadTransport = {
      ok: true,
      path: '/tmp/x.gimoza',
      parse: {
        outcome: PARSE_OUTCOME.VersionIncompatible,
        foundVersion: '0',
        supportedVersion: '1',
        message: '非対応バージョンです。',
      },
    };
    await openCommand(makePorts({ load: () => Promise.resolve(transport), notify, reflectProject }));
    expect(notify).toHaveBeenCalledWith('非対応バージョンです。');
    expect(reflectProject).not.toHaveBeenCalled();
  });

  it('non-empty report → repair UI; null choice (中止) → no reflect', async () => {
    const report: ConsistencyReport = {
      ok: false,
      inconsistencies: [
        { kind: 'shape-preservation', featureIds: [], featureNames: ['A'], detail: 'leaf-empty-shape' },
      ],
    };
    const reflectProject = vi.fn();
    const promptRepair = vi.fn(() => Promise.resolve(null));
    await openCommand(
      makePorts({ checkConsistency: () => report, promptRepair, reflectProject }),
    );
    expect(promptRepair).toHaveBeenCalledOnce();
    expect(reflectProject).not.toHaveBeenCalled();
  });
});

// --- repair RETRY flow (BUG #2 unresolved banner seam + BUG #5 terminal abort) ---
//
// These drive completeLoad through the repair-flow APPLY step (mocked above) so the
// outcome sequence is deterministic. A non-empty report routes to the repair UI; a
// non-null choice reaches applyChosenRepairs, whose mocked outcome decides the next
// branch. The chosen-repair value never matters (the apply mock ignores it).
describe('repair retry flow (BUG #2 / BUG #5)', () => {
  const BROKEN_REPORT: ConsistencyReport = {
    ok: false,
    inconsistencies: [
      { kind: 'shape-preservation', featureIds: [], featureNames: ['A'], detail: 'leaf-empty-shape' },
    ],
  };
  const REMAINING_REPORT: ConsistencyReport = {
    ok: false,
    inconsistencies: [
      { kind: 'shape-preservation', featureIds: [], featureNames: ['B'], detail: 'still-broken' },
    ],
  };
  const someChoices = (): RepairChoices => new Map([[0, 'x' as never]]);

  it('BUG #2: a first Unresolved re-prompts with isRetry=true (the banner seam)', async () => {
    // First apply leaves the project Unresolved; the retry repair then succeeds.
    applyResults.push(
      { outcome: REPAIR_OUTCOME.Unresolved, project: FAKE_PROJECT, remaining: REMAINING_REPORT },
      { outcome: REPAIR_OUTCOME.Applied, project: FAKE_PROJECT },
    );
    const promptRepair = vi.fn(() => Promise.resolve(someChoices()));
    const reflectProject = vi.fn();
    await openCommand(
      makePorts({ checkConsistency: () => BROKEN_REPORT, promptRepair, reflectProject }),
    );
    // The dialog opens TWICE: first-open isRetry=false, retry-open isRetry=true.
    expect(promptRepair).toHaveBeenCalledTimes(2);
    expect(promptRepair).toHaveBeenNthCalledWith(1, BROKEN_REPORT, false);
    expect(promptRepair).toHaveBeenNthCalledWith(2, REMAINING_REPORT, true);
    // The second repair resolved everything ⇒ the project reflects (success path).
    expect(reflectProject).toHaveBeenCalledOnce();
  });

  it('BUG #5: BOTH attempts Unresolved → notify + no reflect (explicit abort, not silent)', async () => {
    applyResults.push(
      { outcome: REPAIR_OUTCOME.Unresolved, project: FAKE_PROJECT, remaining: REMAINING_REPORT },
      { outcome: REPAIR_OUTCOME.Unresolved, project: FAKE_PROJECT, remaining: REMAINING_REPORT },
    );
    const promptRepair = vi.fn(() => Promise.resolve(someChoices()));
    const reflectProject = vi.fn();
    const notify = vi.fn();
    await openCommand(
      makePorts({ checkConsistency: () => BROKEN_REPORT, promptRepair, reflectProject, notify }),
    );
    expect(promptRepair).toHaveBeenCalledTimes(2);
    // The second attempt is still Unresolved: the flow surfaces an explicit failure
    // (does NOT silently load inconsistent data).
    expect(notify).toHaveBeenCalledWith(REPAIR_STRINGS.abortedUnresolved);
    expect(reflectProject).not.toHaveBeenCalled();
  });

  it('BUG #5: cancelling the RETRY → notify + no reflect (no silent drop)', async () => {
    applyResults.push({
      outcome: REPAIR_OUTCOME.Unresolved,
      project: FAKE_PROJECT,
      remaining: REMAINING_REPORT,
    });
    // First open returns choices, the retry open is cancelled (null).
    const promptRepair: FileCommandPorts['promptRepair'] = vi
      .fn()
      .mockResolvedValueOnce(someChoices())
      .mockResolvedValueOnce(null);
    const reflectProject = vi.fn();
    const notify = vi.fn();
    await openCommand(
      makePorts({ checkConsistency: () => BROKEN_REPORT, promptRepair, reflectProject, notify }),
    );
    expect(promptRepair).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(REPAIR_STRINGS.abortedUnresolved);
    expect(reflectProject).not.toHaveBeenCalled();
  });

  it('first 中止 (cancel) stays silent — no notify (受け入れ基準 3: 中止は静かに現状維持)', async () => {
    const promptRepair = vi.fn(() => Promise.resolve(null));
    const notify = vi.fn();
    const reflectProject = vi.fn();
    await openCommand(
      makePorts({ checkConsistency: () => BROKEN_REPORT, promptRepair, reflectProject, notify }),
    );
    expect(promptRepair).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(reflectProject).not.toHaveBeenCalled();
  });
});

describe('newProjectCommand / quitGuard (FR-107 / FR-03)', () => {
  it('new project: clean → runs the initialiser', async () => {
    const initialise = vi.fn();
    await newProjectCommand(makePorts(), initialise);
    expect(initialise).toHaveBeenCalledOnce();
  });

  it('new project: dirty + キャンセル → initialiser is NOT run', async () => {
    const initialise = vi.fn();
    await newProjectCommand(
      makePorts({
        guard: {
          isDirty: () => true,
          promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Cancel),
          save: () => Promise.resolve(true),
        },
      }),
      initialise,
    );
    expect(initialise).not.toHaveBeenCalled();
  });

  it('quit guard: dirty + 保存 + save success → may close', async () => {
    const ok = await quitGuard(
      makePorts({
        guard: {
          isDirty: () => true,
          promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Save),
          save: () => Promise.resolve(true),
        },
      }),
    );
    expect(ok).toBe(true);
  });

  it('quit guard: dirty + 保存 + save failure → may NOT close (protect data)', async () => {
    const ok = await quitGuard(
      makePorts({
        guard: {
          isDirty: () => true,
          promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Save),
          save: () => Promise.resolve(false),
        },
      }),
    );
    expect(ok).toBe(false);
  });
});


// --- 増分 8D: 以前の保存から開く（設計書 §E.1 の V14 の手順 (a)・§J.4 の #9）---------

describe('openBackupCommand — 一覧 → 行を選ぶ → 未保存の確認 → 開く の順', () => {
  const ENTRY = {
    id: 'b-1',
    savedAtMs: 1000,
    byteSize: 2048,
    featureCount: 3,
    sourceName: 'w.gimoza',
  } as const;

  it('未保存の確認は openBackup より **前** に走り、キャンセルなら世代を読まない', async () => {
    const order: string[] = [];
    const openBackup = vi.fn(() => {
      order.push('open');
      return Promise.resolve(okTransport());
    });
    const ports = makePorts({
      guard: {
        isDirty: () => true,
        promptUnsaved: () => {
          order.push('unsaved');
          return Promise.resolve(UNSAVED_CHOICE.Cancel);
        },
        save: () => Promise.resolve(true),
      },
      listBackups: () => {
        order.push('list');
        return Promise.resolve([ENTRY]);
      },
      openBackup,
    });
    await openBackupCommand(ports, (entries) => {
      order.push(`choose:${entries.length}`);
      return Promise.resolve('b-1');
    });
    expect(order).toEqual(['list', 'choose:1', 'unsaved']);
    expect(openBackup).not.toHaveBeenCalled();
  });

  it('「保存せずに続行」なら選んだ id で開き、読み込みと同じ完了の流れで reflect する', async () => {
    const reflectProject = vi.fn();
    const openBackup = vi.fn(() => Promise.resolve(okTransport()));
    const ports = makePorts({
      guard: {
        isDirty: () => true,
        promptUnsaved: () => Promise.resolve(UNSAVED_CHOICE.Discard),
        save: () => Promise.resolve(true),
      },
      listBackups: () => Promise.resolve([ENTRY]),
      openBackup,
      reflectProject,
    });
    await openBackupCommand(ports, () => Promise.resolve('b-1'));
    expect(openBackup).toHaveBeenCalledWith('b-1');
    expect(reflectProject).toHaveBeenCalledOnce();
  });

  it('一覧で「やめる」なら未保存の確認も出さない', async () => {
    const promptUnsaved = vi.fn(() => Promise.resolve(UNSAVED_CHOICE.Discard));
    const openBackup = vi.fn(() => Promise.resolve(okTransport()));
    const ports = makePorts({
      guard: { isDirty: () => true, promptUnsaved, save: () => Promise.resolve(true) },
      listBackups: () => Promise.resolve([ENTRY]),
      openBackup,
    });
    await openBackupCommand(ports, () => Promise.resolve(null));
    expect(promptUnsaved).not.toHaveBeenCalled();
    expect(openBackup).not.toHaveBeenCalled();
  });

  it('一覧が取れなくても板は空で出る（例外で止まらない）', async () => {
    const choose = vi.fn(() => Promise.resolve(null));
    const ports = makePorts({ listBackups: () => Promise.reject(new Error('IPC')) });
    await openBackupCommand(ports, choose);
    expect(choose).toHaveBeenCalledWith([]);
  });

  it('断られた id（一覧に無い）は読み込みの失敗と同じく理由を出して何も変えない', async () => {
    const notify = vi.fn();
    const reflectProject = vi.fn();
    const ports = makePorts({
      listBackups: () => Promise.resolve([ENTRY]),
      openBackup: () =>
        Promise.resolve({ ok: false, reason: 'read-failed', message: 'その世代は一覧に…' }),
      notify,
      reflectProject,
    });
    await openBackupCommand(ports, () => Promise.resolve('stale'));
    expect(notify).toHaveBeenCalledOnce();
    expect(reflectProject).not.toHaveBeenCalled();
  });
});
