import { describe, expect, it, vi } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import {
  PARSE_OUTCOME,
  type ConsistencyReport,
  type DomainProject,
  type Manifest,
} from '../../domain/persistence/index';

import {
  dropLoadCommand,
  newProjectCommand,
  openCommand,
  quitGuard,
  saveCommand,
  type FileCommandPorts,
} from './file-commands';
import { UNSAVED_CHOICE } from './unsaved-guard';
import type { LoadTransport } from './load-flow';

const CAL = getCalendar('gregorian');
const FAKE_PROJECT = { histories: [], settings: {}, baseMap: {} } as unknown as DomainProject;
const CLEAN_REPORT: ConsistencyReport = { ok: true, inconsistencies: [] };
const okTransport = (): LoadTransport => ({
  ok: true,
  path: '/tmp/x.tmap',
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
    await dropLoadCommand(makePorts({ reflectProject, loadDropped }), '/dropped/a.tmap');
    expect(loadDropped).toHaveBeenCalledWith('/dropped/a.tmap');
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
      path: '/tmp/x.tmap',
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
