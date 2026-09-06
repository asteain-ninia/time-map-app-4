// U37 / U20: 「測る」の帯（設計書 §C.4。増分 5 の手直し C3・司令塔の決定 (4)）。
//
// **測るは道具ではないが、道具と同じ帯を使う。** `ToolId` にすると鍵で無効化されて
// 「読むだけでは測れない」になるので、軸は `store.survey` のままである（U37 §2.1）。
// けれど利用者から見れば、レールの 12 個目のボタンを押して始める作業であって、
// ほかの道具と扱いが違う理由は無い ―― **帯の 5 区画（道具名・対象・次の一手・設定・
// 確定）を使う**。使わないと、測っているあいだ帯は「✦ 選ぶ」「地図か地物一覧から選ぶ」
// のままで、**押したボタンと帯の中身が食い違う**（増分 5 の審査で残っていた食い違い）。
//
// この部品は **DOM を 1 つも作らない**。読み取り（距離・座標 ▾・クリア）は従来どおり
// 設定欄の常設スロット（`SurveyMeasurementPanel`）が持ち、ここは道具名・対象・次の一手・
// 確定だけを押し込む。
//
// **帯の持ち主**（`option-bar.ts` の `claim`）: 測量が ON のあいだは測るが持つ。
// `ToolOptionBar` は測量が ON のあいだ持たない（あちらの `holdsBar` が見ている）ので、
// 持ち主が 2 つになることはない。

import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { OptionBarStore } from '../shell/option-bar';
import type { SessionStore } from '../state/store';

import { SURVEY_STRINGS } from './strings';

export interface SurveyOptionBarProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly optionBar: OptionBarStore;
}

export function SurveyOptionBar<S>(props: SurveyOptionBarProps<S>): null {
  const { store, optionBar } = props;
  const survey = useStore(store, (s) => s.survey);

  const active = survey.active;
  const lineCount = survey.lines.length;
  const hasDraft = survey.draft !== null;

  // 帯を持つ / 手放す。持った瞬間に中身は空へ戻る（前の道具の確定ボタンを持ち越さない）。
  useEffect(() => {
    if (!active) return;
    const owner = {};
    return optionBar.claim(owner);
  }, [optionBar, active]);

  useEffect(() => {
    if (!active) return;
    optionBar.setToolName(SURVEY_STRINGS.toolName);
    optionBar.setTarget(
      null,
      hasDraft
        ? SURVEY_STRINGS.targetStartOnly
        : lineCount > 0
          ? SURVEY_STRINGS.targetLines(lineCount)
          : SURVEY_STRINGS.targetNone,
    );
    optionBar.setNextStep(
      hasDraft ? SURVEY_STRINGS.guideAwaitingEnd : SURVEY_STRINGS.nextStepIdle,
    );
    optionBar.setCommit([
      {
        id: 'finish',
        // T-1: 役割は「測量を終える」。入口のトグル（`survey-toggle`）とは別の
        // ボタンなので、testid も別に持つ。
        label: SURVEY_STRINGS.finishLabel,
        onClick: () => store.getState().surveyDisable(),
      },
    ]);
    return () => {
      optionBar.setCommit([]);
      optionBar.setNextStep(null);
    };
  }, [optionBar, store, active, hasDraft, lineCount]);

  return null;
}
