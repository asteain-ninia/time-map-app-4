// 修復ダイアログの呼び名（増分 8D の手直し / N-22・設計書 §H.1）。
//
// 名前のある地物は名前で、名前が空・ID と同じ地物は「名前のない面（1500年に作成）」の形で
// 1 件ずつ見分けられるように呼ぶ。歴史の行は「〈名前〉の歴史」、孤立した歴史は中に入っている
// 地物の名前で呼ぶ。同じ名前の地物は作成年で見分ける。

import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../../domain/ids';
import {
  INCONSISTENCY,
  type DomainProject,
  type Inconsistency,
} from '../../domain/persistence/index';
import { describeInconsistency, INCONSISTENCY_LABELS } from './repair-flow';
import { buildRepairNamer, repairTargetLabel } from './repair-names';

/** 呼び名に要る形だけを持った地物（name・kind・id）。 */
function feature(id: string, kind: string, name: string): unknown {
  return { id: asFeatureId(id), kind, attributes: { name } };
}

/** `owner` の歴史。entries は [開始年, その年の地物たち] の並び。 */
function history(owner: string, entries: readonly (readonly [number, readonly unknown[]])[]): unknown {
  return {
    featureId: asFeatureId(owner),
    series: {
      entries: entries.map(([year, features]) => ({
        start: { year },
        end: null,
        anchor: { snapshot: { features } },
      })),
    },
  };
}

function project(histories: readonly unknown[]): DomainProject {
  return { histories } as unknown as DomainProject;
}

const id = (s: string): FeatureId => asFeatureId(s);

describe('buildRepairNamer', () => {
  const PROJECT = project([
    history('f-1', [
      [1200, [feature('f-1', 'leaf', '旧名')]],
      [1300, [feature('f-1', 'leaf', 'アルラーク国')]],
    ]),
    history('f-2', [[1500, [feature('f-2', 'leaf', '')]]]),
    history('f-3', [[1600, [feature('f-3', 'line', 'f-3')]]]),
    history('f-4', [[900, [feature('f-4', 'point', '州')]]]),
    history('f-5', [[1100, [feature('f-5', 'aggregate', '州')]]]),
    // 持ち主（gone）がどの年にも居ない歴史。中身は 4 つ。
    history('gone', [
      [
        1000,
        [
          feature('m-1', 'aggregate', 'ラヴィエンド・ウィル同君王国'),
          feature('m-2', 'leaf', '北州'),
          feature('m-3', 'leaf', ''),
          feature('m-4', 'leaf', '南州'),
        ],
      ],
    ]),
  ]);
  const namer = buildRepairNamer(PROJECT);

  it('名前はいちばん新しい年のもの・年は最初に現れた年・種類は面/線/点', () => {
    expect(namer.featureInfo(id('f-1'))).toEqual({ name: 'アルラーク国', kindLabel: '面', createdYear: 1200 });
    expect(namer.featureInfo(id('f-3'))).toEqual({ name: null, kindLabel: '線', createdYear: 1600 });
    expect(namer.featureInfo(id('f-4')).kindLabel).toBe('点');
    expect(namer.featureInfo(id('f-5')).kindLabel).toBe('面');
    expect(namer.featureInfo(id('nowhere'))).toEqual({ name: null, kindLabel: '地物', createdYear: null });
  });

  it('名前が空・ID と同じなら「名前のない面（1500年に作成）」（設計書 §H.1）', () => {
    expect(repairTargetLabel(namer.featureInfo(id('f-2')))).toBe('名前のない面（1500年に作成）');
    expect(repairTargetLabel(namer.featureInfo(id('f-3')))).toBe('名前のない線（1600年に作成）');
    expect(repairTargetLabel(namer.featureInfo(id('f-1')))).toBe('アルラーク国');
  });

  it('時間の矛盾・重複した歴史は「〈名前〉の歴史」と呼ぶ（名前があるのに「名前のない」と言わない）', () => {
    // 検出は名前の欄に ID を入れてくる。
    for (const kind of [INCONSISTENCY.TimeConflict, INCONSISTENCY.DuplicateOwnerHistory] as const) {
      const inc: Inconsistency = { kind, featureIds: [id('f-1')], featureNames: ['f-1'] };
      expect(describeInconsistency(inc, namer)).toBe(
        `${INCONSISTENCY_LABELS[kind]}（対象: アルラーク国の歴史）`,
      );
    }
  });

  it('孤立した歴史は、中に入っている地物の名前で呼ぶ（持ち主はどの年にも居ないので）', () => {
    const inc: Inconsistency = {
      kind: INCONSISTENCY.OrphanHistory,
      featureIds: [id('gone')],
      featureNames: ['gone'],
      detail: 'owner-feature-absent',
    };
    expect(describeInconsistency(inc, namer)).toBe(
      `${INCONSISTENCY_LABELS[INCONSISTENCY.OrphanHistory]}（対象: 持ち主の居ない歴史（中の地物: ラヴィエンド・ウィル同君王国、北州、名前のない面（1000年に作成） ほか 1 件））`,
    );
  });

  it('同じ名前の地物が並ぶときは作成年で見分ける（名前のない地物とは数えない）', () => {
    const inc: Inconsistency = {
      kind: INCONSISTENCY.AnchorSpatialOverlap,
      featureIds: [id('f-4'), id('f-5')],
      featureNames: ['州', '州'],
    };
    expect(describeInconsistency(inc, namer)).toBe(
      `${INCONSISTENCY_LABELS[INCONSISTENCY.AnchorSpatialOverlap]}（対象: 州（900年に作成）、州（1100年に作成））`,
    );
  });

  it('名前のない地物が 2 件でも 1 件ずつ見分けられる', () => {
    const inc: Inconsistency = {
      kind: INCONSISTENCY.TerminalExclusion,
      featureIds: [id('f-2'), id('f-3')],
      featureNames: ['f-2', 'f-3'],
    };
    expect(describeInconsistency(inc, namer)).toBe(
      `${INCONSISTENCY_LABELS[INCONSISTENCY.TerminalExclusion]}（対象: 名前のない面（1500年に作成）、名前のない線（1600年に作成））`,
    );
  });
});

// 取り込み（増分 8A〜8E）で、呼び名の規則を `conflict/participant-name.ts` の 1 か所にまとめた（B75）。
// 修復ダイアログの側で変わったのは、見えない文字だけの名前を名前と見なさないことと、紀元前の年の書き方。
describe('修復ダイアログの呼び名は重なり解決と同じ規則を通る', () => {
  const PROJECT = project([
    history('z-1', [[-300, [feature('z-1', 'leaf', '​ ')]]]),
    history('z-2', [[-300, [feature('z-2', 'leaf', '州')]]]),
    history('z-3', [[1200, [feature('z-3', 'leaf', '州')]]]),
  ]);
  const namer = buildRepairNamer(PROJECT);

  it('見えない文字だけの名前は名前と見なさず、紀元前の年は「紀元前300年」と書く', () => {
    expect(repairTargetLabel(namer.featureInfo(id('z-1')))).toBe('名前のない面（紀元前300年に作成）');
  });

  it('同じ名前を年で見分けるときも、年の書き方は同じ', () => {
    expect(repairTargetLabel(namer.featureInfo(id('z-2')), true)).toBe('州（紀元前300年に作成）');
    expect(repairTargetLabel(namer.featureInfo(id('z-3')), true)).toBe('州（1200年に作成）');
  });
});
