// FR-98 詳細文書 dispatch tests — the LIVE wiring over a committed DomainProject:
// 編集→保存→undo で戻る / 空→absent / 超過は dispatch されず throw / no-op は記録なし.
// Drives the REAL U13 edit binding (createLiveEditBinding) + the REAL live-lookup,
// mirroring live-unshare.test.tsx (単一真実源 of the seam-test pattern).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createCoordinate } from '../domain/coordinate';
import {
  MAX_DETAIL_DOCUMENT_LENGTH,
  createPointFeature,
  withDetailDocument,
} from '../domain/index';
import { asFeatureId, asVertexId } from '../domain/ids';
import { createVertex, createVertexStore } from '../domain/vertex';
import { PROCESS_STATUS, type ProcessResult } from '../domain/consistency/index';
import type { NextTargetPreference } from '../domain/selection/index';
import { timePointYear } from '../domain/time/time-point';
import type { DomainProject } from '../domain/persistence/index';
import {
  singleAnchorHistory,
  DEFAULT_SETTINGS,
  DEFAULT_BASEMAP,
} from '../domain/persistence/fixtures';

import { createLiveEditBinding } from './consistency-binding';
import { createDetailDocumentDispatch } from './live-detail-document';
import { clearLiveLookupCache, featureByIdAt } from './live-lookup';

const TIME = timePointYear(0);
const A = asFeatureId('A');
const COLOR = createColorInfo(true, '#111111', '#222222', '#333333', 'default', 1, 1);

function projectWith(doc?: string): DomainProject {
  const v = createVertex(asVertexId('A-v'), createCoordinate(10, 0));
  const base = createPointFeature(A, createBasicAttributes('城A', 0, 100), COLOR, v.id);
  const feature = doc === undefined ? base : withDetailDocument(base, doc);
  return {
    histories: [singleAnchorHistory('A', [feature], createVertexStore([v]))],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

interface Recorded {
  readonly result: ProcessResult<DomainProject>;
  readonly preference: NextTargetPreference;
  readonly anchorTime: unknown;
}

function makeDispatch(root: () => DomainProject): {
  dispatch: ReturnType<typeof createDetailDocumentDispatch>;
  recorded: Recorded[];
  startProcess: ReturnType<typeof vi.fn>;
} {
  const binding = createLiveEditBinding({ getRoot: root });
  const recorded: Recorded[] = [];
  const startProcess = vi.fn(binding.startProcess);
  const dispatch = createDetailDocumentDispatch({
    getRoot: root,
    startProcess,
    recordCommit: (result, preference, anchorTime) =>
      recorded.push({ result, preference, anchorTime }),
  });
  return { dispatch, recorded, startProcess };
}

function docOf(root: DomainProject): string | undefined {
  return featureByIdAt(root, TIME, A)?.detailDocument;
}

beforeEach(() => clearLiveLookupCache());

describe('createDetailDocumentDispatch — FR-98 の LIVE 保存経路', () => {
  it('編集→保存は 1 コマンドで commit され、undo で元の文書に戻る (FR-73 / 教訓 5.20)', () => {
    const root = projectWith('旧文書');
    const { dispatch, recorded } = makeDispatch(() => root);

    dispatch.dispatchDetailDocument({ featureId: A, editTime: TIME, detailDocument: '**新**文書' });

    expect(recorded).toHaveLength(1);
    const { result, preference, anchorTime } = recorded[0]!;
    expect(preference).toEqual({ featureId: A }); // 編集対象の昇格 (教訓 5.11)
    expect(anchorTime).toEqual(TIME); // fr100: コマンドの anchorTime = editTime
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;

    // The committed state carries the new document…
    expect(docOf(result.state)).toBe('**新**文書');
    // …and the SINGLE command's undo restores the baseline document exactly.
    const undone = result.command.undo(result.state).state;
    expect(docOf(undone)).toBe('旧文書');
    // redo replays the same document (教訓 5.23 対称).
    const redone = result.command.redo(undone).state;
    expect(docOf(redone)).toBe('**新**文書');
  });

  it("'' の保存は文書を ABSENT にする (空→absent, 単一の canonical empty)", () => {
    const root = projectWith('消える文書');
    const { dispatch, recorded } = makeDispatch(() => root);

    dispatch.dispatchDetailDocument({ featureId: A, editTime: TIME, detailDocument: '' });

    const { result } = recorded[0]!;
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    const after = featureByIdAt(result.state, TIME, A)!;
    expect('detailDocument' in after).toBe(false);
  });

  it('超過ドラフトは startProcess にすら到達せず honest に throw する (WRITE ガード)', () => {
    const root = projectWith('旧');
    const { dispatch, recorded, startProcess } = makeDispatch(() => root);

    expect(() =>
      dispatch.dispatchDetailDocument({
        featureId: A,
        editTime: TIME,
        detailDocument: 'x'.repeat(MAX_DETAIL_DOCUMENT_LENGTH + 1),
      }),
    ).toThrow(/詳細文書が長すぎるため保存できません/);
    expect(startProcess).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it('no-op（ドラフト=現状）は何も dispatch しない (教訓 5.24 no幽霊 undo)', () => {
    const root = projectWith('同じ');
    const { dispatch, recorded, startProcess } = makeDispatch(() => root);

    dispatch.dispatchDetailDocument({ featureId: A, editTime: TIME, detailDocument: '同じ' });

    expect(startProcess).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it('編集対象がその時刻に存在しないと honest に throw する', () => {
    const root = projectWith('旧');
    const { dispatch } = makeDispatch(() => root);
    expect(() =>
      dispatch.dispatchDetailDocument({
        featureId: asFeatureId('ghost'),
        editTime: TIME,
        detailDocument: '新',
      }),
    ).toThrow(/編集対象が現在の時刻に存在しません/);
  });
});
