// 頂点の印の上限の知らせ（増分 8A）と「測る」の帯（増分 8C）が、同じ「次の一手」を取り合わない
// ことの検査（統合 8A〜8D の継ぎ目の検証 2-1）。
//
// **何を守るか**: 頂点の多い地物を選んだまま測ると、上限の知らせがカメラの動きのたびに次の
// 一手へ書き込み、数が上限を下回った瞬間の片付けで次の一手を空にしていた（空の次の一手は
// 「選択」の既定の文を出す）。「頂点」の道具で選んだまま測り始める形で確かめる。
// 測るの案内（終点を押す・Esc でやめる）が消えて、測るをやめたように見えた。
//
// 本物の `HandleCapNotice` と `SurveyOptionBar` を同じ帯に載せ、上限を小さくして確かめる。

/// <reference types="@testing-library/jest-dom" />

import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TOOL_ID } from '../shell/tools';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createLeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import type { Camera, Viewport } from '../../render';
import { OptionBarStore } from '../shell/option-bar';
import { EDIT_MODE } from '../state/session';
import { DEFAULT_APP_SETTINGS } from '../state/settings';
import { createSessionStore } from '../state/store';
import { SurveyOptionBar } from '../survey/SurveyOptionBar';
import { SURVEY_STRINGS } from '../survey/strings';

import { HANDLE_CAP_ZOOM_ACTION_ID, HandleCapNotice } from './HandleCapNotice';

const ID = asFeatureId('ring');
const T = timePointYear(10);
const VIEWPORT: Viewport = { widthCss: 900, heightCss: 600, devicePixelRatio: 1 };
const WHOLE: Camera = { centerLon: 0, centerLat: 0, zoom: 900 / 360 };
/** 円の右端へ寄った視野（視野内の頂点の数が全体表示より減り、上限 20 を下回らない）。 */
const CLOSER: Camera = { centerLon: 30, centerLat: 0, zoom: (900 / 360) * 6 };

/** 頂点 n 個の円の国が 1 つだけのプロジェクト。 */
function ringProject(n: number): DomainProject {
  const vertices = Array.from({ length: n }, (_, i) =>
    createVertex(
      asVertexId(`v${String(i)}`),
      createCoordinate(30 * Math.cos((2 * Math.PI * i) / n), 30 * Math.sin((2 * Math.PI * i) / n)),
    ),
  );
  const feature = createLeafFeature(
    ID,
    createBasicAttributes('円の国', 0, 100),
    createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1'),
    createShape([createTerritoryRing(asRingId('ring-r'), vertices.map((v) => v.id))]),
  );
  return {
    histories: [singleAnchorHistory('ring', [feature], createVertexStore(vertices), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** 300 頂点の国を選び、上限 20 で、上限の知らせと測るの帯を同じ帯に載せる。 */
function mountBoth() {
  let camera: Camera = WHOLE;
  const store = createSessionStore<DomainProject>({
    initialDomain: ringProject(300),
    initial: {
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditVertex,
      activeFeature: ID,
      currentTime: T,
      camera: { ...camera, panX: 0, panY: 0 },
      appSettings: { ...DEFAULT_APP_SETTINGS, vertexMarkerCap: 20 },
    },
  });
  const cameraPorts = {
    readCamera: () => ({ camera, viewport: VIEWPORT }),
    writeCamera: (c: Camera) => {
      camera = c;
      store.getState().setCamera({ ...c, panX: 0, panY: 0 });
    },
    effectiveZoomRange: () => ({ minZoom: 0.1, maxZoom: 1000 }),
  };
  const optionBar = new OptionBarStore();
  render(
    <>
      <HandleCapNotice
        store={store as never}
        optionBar={optionBar}
        cameraRef={{ current: cameraPorts } as never}
      />
      <SurveyOptionBar<DomainProject> store={store} optionBar={optionBar} />
    </>,
  );
  const moveCamera = (c: Camera): void => {
    act(() => cameraPorts.writeCamera(c));
  };
  const hasZoomAction = (): boolean =>
    optionBar.get().nextStepActions.some((a) => a.id === HANDLE_CAP_ZOOM_ACTION_ID);
  return { store, optionBar, moveCamera, hasZoomAction };
}

describe('HandleCapNotice × 測る — 測っている間の次の一手は測るの案内のまま（継ぎ目の検証 2-1）', () => {
  it('対照: 測っていないときは、上限の知らせが次の一手に出る', () => {
    const { optionBar, hasZoomAction } = mountBoth();
    expect(optionBar.get().nextStep).toContain('上限 20');
    expect(hasZoomAction()).toBe(true);
  });

  it('測っている間に寄っても戻しても、次の一手は測るの案内のまま（上限の知らせも［拡大］も出ない）', () => {
    const { store, optionBar, moveCamera, hasZoomAction } = mountBoth();

    act(() => store.getState().surveyEnable());
    expect(optionBar.get().nextStep).toBe(SURVEY_STRINGS.nextStepIdle);
    expect(hasZoomAction()).toBe(false);

    // 視野内の頂点の数を変える（直す前は、ここで上限の文に置き換わった）。
    moveCamera(CLOSER);
    expect(optionBar.get().nextStep).toBe(SURVEY_STRINGS.nextStepIdle);
    expect(hasZoomAction()).toBe(false);
    moveCamera(WHOLE);
    expect(optionBar.get().nextStep).toBe(SURVEY_STRINGS.nextStepIdle);

    // 始点を置いたあと（終点を待つ案内）も、寄って置き換わらない。
    act(() => store.getState().surveyClickPoint(createCoordinate(0, 0)));
    expect(optionBar.get().nextStep).toBe(SURVEY_STRINGS.guideAwaitingEnd);
    moveCamera({ ...CLOSER, zoom: (900 / 360) * 5 });
    expect(optionBar.get().nextStep).toBe(SURVEY_STRINGS.guideAwaitingEnd);
    expect(hasZoomAction()).toBe(false);
    moveCamera(WHOLE);
    expect(optionBar.get().nextStep).toBe(SURVEY_STRINGS.guideAwaitingEnd);
  });

  it('測るをやめて「頂点」を構え直すと、上限の知らせが戻る（帯の持ち直しで押し直す）', () => {
    const { store, optionBar, moveCamera, hasZoomAction } = mountBoth();
    act(() => store.getState().surveyEnable());
    moveCamera(CLOSER);
    act(() => store.getState().surveyDisable());
    // 測量で道具は外れている。「選択」と同じで印を描かないので、上限を言う場面ではない（B114）。
    expect(store.getState().activeTool).toBeNull();
    expect(optionBar.get().nextStep ?? '').not.toContain('上限 20');
    act(() => store.getState().setActiveTool(TOOL_ID.EditVertex));
    expect(optionBar.get().nextStep).toContain('上限 20');
    expect(hasZoomAction()).toBe(true);
  });
});

describe('SurveyOptionBar — 測るの帯は書いた人の印つきで書く（継ぎ目の検証 2-1）', () => {
  it('印を持たない片付け（clearChromeIfMine(null)）や、別の印の片付けでは測るの案内は消えない', () => {
    const store = createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: { mode: EDIT_MODE.Edit },
    });
    const optionBar = new OptionBarStore();
    render(<SurveyOptionBar<Record<string, never>> store={store} optionBar={optionBar} />);
    act(() => store.getState().surveyEnable());
    expect(optionBar.get().nextStep).toBe(SURVEY_STRINGS.nextStepIdle);

    act(() => {
      optionBar.clearChromeIfMine(null);
      optionBar.clearChromeIfMine({});
    });
    expect(optionBar.get().nextStep).toBe(SURVEY_STRINGS.nextStepIdle);
    expect(optionBar.get().commit).toHaveLength(1);
  });
});
