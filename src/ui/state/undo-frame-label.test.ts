// 状態行の元に戻す枠の言葉（B10）。戻す順番どおりに言うこと、次の Ctrl+Z が履歴を戻さないときは
// 履歴の名前を言わないこと、対象が 1 つに定まらないときは名前を付けないことを固定する。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { deriveAnchorId } from '../../domain/anchor-id';
import { createAnchorEntry } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  type Command,
  createCommandResult,
  createHistory,
  defineCommandKind,
  execute as historyExecute,
  undo as historyUndo,
} from '../../domain/command/index';
import { createLeafFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/serialize';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';

import { UI_COMMAND_LABEL } from '../shell/command-result';
import { COMMAND_LABEL_TEXT } from '../shell/command-result-strings';
import { createUndoFrameLabels, soleTouchedFeatureName } from './undo-frame-label';

function command(label: string): Command<number> {
  const outcome = { state: 0, result: createCommandResult({}) };
  return {
    kind: defineCommandKind('test'),
    label,
    execute: () => outcome,
    undo: () => outcome,
    redo: () => outcome,
  };
}

describe('元に戻す枠の言葉', () => {
  it('対象の名前と操作名を言い、名前が無ければ操作名だけを言う', () => {
    const labels = createUndoFrameLabels<number>();
    const named = command(UI_COMMAND_LABEL.Edit);
    const unnamed = command(UI_COMMAND_LABEL.Split);
    labels.remember(named, '南ケナ州');
    labels.remember(unnamed, null);
    expect(labels.labelOf(named)).toBe(`南ケナ州の${COMMAND_LABEL_TEXT.edit}`);
    expect(labels.labelOf(unnamed)).toBe(COMMAND_LABEL_TEXT.split);
  });

  it('覚えていないコマンドは操作名だけで、内部の英語を出さない', () => {
    const labels = createUndoFrameLabels<number>();
    expect(labels.labelOf(command(UI_COMMAND_LABEL.Delete))).toBe(COMMAND_LABEL_TEXT.delete);
    expect(labels.labelOf(command('no-such-label'))).toBe(COMMAND_LABEL_TEXT.fallback);
  });

  it('取り消すと、枠は次に戻るコマンドを言い、履歴が空なら何も言わない', () => {
    const labels = createUndoFrameLabels<number>();
    const first = command(UI_COMMAND_LABEL.Add);
    const second = command(UI_COMMAND_LABEL.Edit);
    labels.remember(first, 'A');
    labels.remember(second, 'B');
    let history = historyExecute(createHistory(0), first).history;
    history = historyExecute(history, second).history;
    expect(labels.frameLabel(history, false)).toBe(`Bの${COMMAND_LABEL_TEXT.edit}`);
    history = historyUndo(history).history;
    expect(labels.frameLabel(history, false)).toBe(`Aの${COMMAND_LABEL_TEXT.add}`);
    history = historyUndo(history).history;
    expect(labels.frameLabel(history, false)).toBeNull();
  });

  it('次の Ctrl+Z が消した測量の線を戻すときは、履歴の名前を言わない', () => {
    const labels = createUndoFrameLabels<number>();
    const edit = command(UI_COMMAND_LABEL.Edit);
    labels.remember(edit, 'A');
    const history = historyExecute(createHistory(0), edit).history;
    expect(labels.frameLabel(history, true)).toBeNull();
  });

  it('言葉を決め直すと、その言葉だけを言う', () => {
    const labels = createUndoFrameLabels<number>();
    const add = command(UI_COMMAND_LABEL.Add);
    labels.remember(add, null);
    labels.rename(add, '重なりの解消');
    expect(labels.labelOf(add)).toBe('重なりの解消');
  });
});

describe('対象の名前を引く', () => {
  const Y0 = timePointYear(0);
  const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

  function project(...names: readonly (readonly [id: string, name: string])[]): DomainProject {
    return {
      histories: names.map(([id, name]) => {
        const vertices = [
          [0, 0],
          [2, 0],
          [2, 2],
        ].map(([lon, lat], i) => createVertex(asVertexId(`${id}-${i}`), { lon: lon!, lat: lat! }));
        const featureId = asFeatureId(id);
        const feature = createLeafFeature(
          featureId,
          createBasicAttributes(name, 0, 0),
          color,
          createShape([createTerritoryRing(asRingId(`${id}-r`), vertices.map((v) => v.id))]),
        );
        return {
          featureId,
          series: {
            entries: [
              createAnchorEntry(
                createAnchor(
                  deriveAnchorId(featureId, Y0),
                  createAnchorSnapshot([feature], createVertexStore(vertices)),
                ),
                Y0,
                null,
              ),
            ],
          },
        };
      }),
      settings: {
        calendarId: 'gregorian',
        geo: createGeoParams(40000, 0.0034),
        gridSpacingDeg: 10,
        snapDistancePx: 50,
        autoColorDefault: true,
      },
      baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
    };
  }

  const A = asFeatureId('a');
  const B = asFeatureId('b');

  it('改名したら新しい名前を言う', () => {
    const before = project(['a', '北ケナ州']);
    const after = project(['a', '南ケナ州']);
    expect(soleTouchedFeatureName(new Set([A]), before, after, Y0)).toBe('南ケナ州');
  });

  it('消した地物は確定前の名前を言う', () => {
    const before = project(['a', '南ケナ州'], ['b', 'バアカ']);
    const after = project(['b', 'バアカ']);
    expect(soleTouchedFeatureName(new Set([A]), before, after, Y0)).toBe('南ケナ州');
  });

  it('触った地物が 2 つ以上なら名前を言わない', () => {
    const root = project(['a', '南ケナ州'], ['b', 'バアカ']);
    expect(soleTouchedFeatureName(new Set([A, B]), root, root, Y0)).toBeNull();
  });

  it('地物でない id は数えない', () => {
    const root = project(['a', '南ケナ州']);
    expect(soleTouchedFeatureName(new Set([A, asVertexId('a-0')]), root, root, Y0)).toBe('南ケナ州');
  });

  it('名前が空なら言わない', () => {
    const root = project(['a', '']);
    expect(soleTouchedFeatureName(new Set([A]), root, root, Y0)).toBeNull();
  });

  it('触ったものが無ければ言わない', () => {
    const root = project(['a', '南ケナ州']);
    expect(soleTouchedFeatureName(new Set(), root, root, Y0)).toBeNull();
  });
});
