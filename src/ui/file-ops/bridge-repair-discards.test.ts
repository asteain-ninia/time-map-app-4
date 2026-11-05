// 修復で捨てた記録の件数の知らせ（増分 7 の手直し 2 回目の `reportRepairDiscards`）が、
// **本物の `buildFileCommandPorts` を通って宿主まで届く**ことを固定する（統合ブランチの継ぎ目の検証 2-1）。
//
// 本体（増分 7）では口が宿主（`FileOpsController`）と `FileCommandPorts` にだけあり、間の
// `FileOpsHost` の型と `buildFileCommandPorts` の写しに無かったので、知らせは一度も出ていなかった。
// `file-commands.test.ts` などは `FileCommandPorts` を直接組んで口を差すので、間の写しの漏れは
// 見えない。ここでは宿主の模型を `buildFileCommandPorts` に渡し、本物の `dropLoadCommand`・
// `openBackupCommand` を通す。形は「同じ年で中身が食い違う」（`repair-orphan-materialize.test.ts`）
// と同じで、既定の修復（各地物に自分の年表を作って残す）が古い記録を 1 件捨てる。

import { describe, expect, it, vi } from 'vitest';

import { createBasicAttributes } from '../../domain/attributes';
import { anchorOf, fid, leafTile } from '../../domain/deletion/fixtures';
import { withAttributes } from '../../domain/feature';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from '../../domain/persistence/fixtures';
import { serialize, type DomainProject } from '../../domain/persistence/index';
import type { FeatureHistory } from '../../domain/persistence/serialize';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import { buildFileCommandPorts, type FileOpsHost } from './bridge';
import { dropLoadCommand, openBackupCommand } from './file-commands';
import { buildRepairRows, defaultRepairChoices } from './repair-flow';

const CAL = getCalendar('gregorian');

/** 既定の修復で「捨てた記録 1 件」になる形。 */
function brokenProject(): DomainProject {
  const c1000 = leafTile('c', 0, 0, 10, 10, 'O');
  const d1000 = leafTile('d', 10, 0, 10, 10, 'O');
  const c1200 = leafTile('c', 0, 0, 10, 10);
  const own = withAttributes(c1200.feature, createBasicAttributes('別の名前', 0, 1));
  const histories: FeatureHistory[] = [
    {
      featureId: fid('O'),
      series: {
        entries: [
          {
            anchor: anchorOf('O-1000', [c1000.feature, d1000.feature], [
              ...c1000.vertices,
              ...d1000.vertices,
            ]),
            start: timePointYear(1000),
            end: null,
          },
        ],
      },
    },
    {
      featureId: fid('c'),
      series: {
        entries: [
          { anchor: anchorOf('c-1200', [own], c1200.vertices), start: timePointYear(1200), end: null },
        ],
      },
    },
  ];
  return { histories, settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
}

function okLoad(project: DomainProject, path: string) {
  return {
    ok: true as const,
    path,
    manifest: serialize(project),
    baseMapImage: new Uint8Array(),
  };
}

function makeHost() {
  const order: string[] = [];
  const reportRepairDiscards = vi.fn((count: number) => {
    order.push(`discards:${String(count)}`);
  });
  const reflectProject = vi.fn((_p: DomainProject, path: string, info?: { repaired: boolean }) => {
    order.push(`reflect:${path}:${String(info?.repaired)}`);
  });
  const api = {
    save: vi.fn(async () => ({ ok: true as const, path: 'cur.gimoza' })),
    saveAs: vi.fn(async () => ({ ok: true as const, path: 'cur.gimoza' })),
    load: vi.fn(async () => okLoad(brokenProject(), 'a.gimoza')),
    loadDropped: vi.fn(async (p: string) => okLoad(brokenProject(), p)),
    listBackups: vi.fn(async () => ({ basis: 'file', sourceName: 'a.gimoza', entries: [] })),
    openBackup: vi.fn(async (id: string) => okLoad(brokenProject(), `backup/${id}`)),
    endBackupChoice: vi.fn(async () => undefined),
  };
  const host = {
    api,
    buildSaveRequest: () => ({
      manifest: serialize(brokenProject()),
      baseMapImage: new Uint8Array(),
    }),
    needsSaveAs: () => false,
    onSaved: () => undefined,
    isDirty: () => false,
    promptUnsaved: async () => 'discard' as const,
    // 修復ダイアログは各行の先頭（既定）を選んだ状態から始まる（増分 8D）。そのまま押す。
    promptRepair: async (report: Parameters<FileOpsHost['promptRepair']>[0]) =>
      defaultRepairChoices(buildRepairRows(report)),
    reflectProject,
    notify: () => undefined,
    reportRepairDiscards,
    saveWithOverwriteConfirm: async () => ({ kind: 'cancelled' as const }),
    calendar: CAL,
  } as unknown as FileOpsHost;
  return { host, order, reportRepairDiscards };
}

describe('修復で捨てた記録の件数は、buildFileCommandPorts を通って宿主へ届く', () => {
  it('D&D で開いて既定の修復が 1 件捨てたら、反映のあとで 1 件と知らせる', async () => {
    const { host, order, reportRepairDiscards } = makeHost();
    await dropLoadCommand(buildFileCommandPorts(host), 'a.gimoza');
    expect(reportRepairDiscards).toHaveBeenCalledTimes(1);
    expect(reportRepairDiscards).toHaveBeenCalledWith(1);
    // 反映が状態行を消すので、知らせは反映のあと。
    expect(order).toEqual(['reflect:a.gimoza:true', 'discards:1']);
  });

  it('「以前の保存から開く」で壊れた世代を開いても同じく知らせる', async () => {
    const { host, order, reportRepairDiscards } = makeHost();
    await openBackupCommand(buildFileCommandPorts(host), async () => 'g1');
    expect(reportRepairDiscards).toHaveBeenCalledWith(1);
    expect(order).toEqual(['reflect:backup/g1:true', 'discards:1']);
  });

  it('宿主が口を持たなければ、ports にも口を作らない（省略できる口のまま）', () => {
    const { host } = makeHost();
    const { reportRepairDiscards: _omit, ...rest } = host as FileOpsHost & {
      reportRepairDiscards?: unknown;
    };
    void _omit;
    expect('reportRepairDiscards' in buildFileCommandPorts(rest as FileOpsHost)).toBe(false);
  });
});
