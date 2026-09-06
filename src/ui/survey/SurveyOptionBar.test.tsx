// U37 / U20: 「測る」の帯（設計書 §C.4。増分 5 の手直し C3・司令塔の決定 (4)）の検査。
//
// **何を守るか**: 測るは `ToolId` の軸ではないが、利用者から見ればレールの 12 個目の
// ボタンで始める作業である。押したボタンと帯の中身が食い違わないこと ―― 測っている
// あいだ帯が「✦ 選ぶ」「地図か地物一覧から選ぶ」のままにならないこと ―― を固定する。

/// <reference types="@testing-library/jest-dom" />

import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OptionBarStore } from '../shell/option-bar';
import { ToolOptionBar } from '../shell/ToolOptionBar';
import { createSessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import type { Feature } from '../../domain/feature';

import { SurveyOptionBar } from './SurveyOptionBar';
import { SURVEY_STRINGS } from './strings';

function makeStore() {
  return createSessionStore<Record<string, never>>({
    initialDomain: {},
    initial: { mode: EDIT_MODE.Edit },
  });
}

/** 対象欄の解決口の代役（この検査では地物を 1 件も置かないので、常に引けない）。 */
const resolveFeature = (): Feature | undefined => undefined;

describe('SurveyOptionBar — 測るがオプションバーを使う（司令塔の決定 (4)）', () => {
  it('測量が OFF のあいだは帯に触らない', () => {
    const store = makeStore();
    const optionBar = new OptionBarStore();
    render(<SurveyOptionBar<Record<string, never>> store={store} optionBar={optionBar} />);

    expect(optionBar.get().toolName).toBeNull();
    expect(optionBar.hasOwner()).toBe(false);
  });

  it('測量を始めると道具名・対象・次の一手・確定欄が入る', () => {
    const store = makeStore();
    const optionBar = new OptionBarStore();
    render(<SurveyOptionBar<Record<string, never>> store={store} optionBar={optionBar} />);

    act(() => {
      store.getState().surveyEnable();
    });

    const state = optionBar.get();
    expect(state.toolName).toBe(SURVEY_STRINGS.toolName);
    expect(state.target.name).toBe(SURVEY_STRINGS.targetNone);
    expect(state.nextStep).toBe(SURVEY_STRINGS.nextStepIdle);
    expect(state.commit).toHaveLength(1);
    expect(state.commit[0]?.label).toBe(SURVEY_STRINGS.finishLabel);
  });

  it('確定欄の［測量を終える］が測量を止める（押して何が起きるかまで見る）', () => {
    const store = makeStore();
    const optionBar = new OptionBarStore();
    render(<SurveyOptionBar<Record<string, never>> store={store} optionBar={optionBar} />);

    act(() => {
      store.getState().surveyEnable();
    });
    expect(store.getState().survey.active).toBe(true);

    act(() => {
      optionBar.get().commit[0]?.onClick();
    });
    expect(store.getState().survey.active).toBe(false);
    // 止めたら帯も空へ戻る（前の作業の確定ボタンが残らない＝教訓 5.2）。
    expect(optionBar.get().commit).toHaveLength(0);
  });

  it('**測量中は道具の帯（ToolOptionBar）が持ち主にならない**（持ち主が 2 つに割れない）', () => {
    const store = makeStore();
    const optionBar = new OptionBarStore();
    render(
      <>
        <ToolOptionBar<Record<string, never>>
          store={store}
          optionBar={optionBar}
          resolveFeature={resolveFeature}
        />
        <SurveyOptionBar<Record<string, never>> store={store} optionBar={optionBar} />
      </>,
    );

    act(() => {
      store.getState().surveyEnable();
    });
    expect(optionBar.get().toolName).toBe(SURVEY_STRINGS.toolName);

    // 測量を止めれば道具の帯が持ち直す（道具名は既定へ戻る）。
    act(() => {
      store.getState().surveyDisable();
    });
    expect(optionBar.get().toolName).toBeNull();
    expect(optionBar.hasOwner()).toBe(true);
  });
});
