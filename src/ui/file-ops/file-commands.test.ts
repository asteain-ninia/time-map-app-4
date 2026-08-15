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
  openCommand,
  quitGuard,
  saveCommand,
  type FileCommandPorts,
} from './file-commands';
import { REPAIR_STRINGS } from './strings';
import { UNSAVED_CHOICE } from './unsaved-guard';
import type { LoadTransport } from './load-flow';

afterEach(() => {
  applyResults.length = 0;
  vi.clearAllMocks();
});

const CAL = getCalendar('gregorian');
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
    save: () => Promise.resolve(true),
    saveAs: () => Promise.resolve(true),
    load: () => Promise.resolve(okTransport()),
    loadDropped: () => Promise.resolve(okTransport()),
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
    const save = vi.fn(() => Promise.resolve(true));
    const saveAs = vi.fn(() => Promise.resolve(true));
    const ok = await saveCommand(makePorts({ save, saveAs }), false);
    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('delegates to 名前を付けて保存 when the path is undetermined', async () => {
    const save = vi.fn(() => Promise.resolve(true));
    const saveAs = vi.fn(() => Promise.resolve(true));
    await saveCommand(makePorts({ save, saveAs }), true);
    expect(saveAs).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
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
