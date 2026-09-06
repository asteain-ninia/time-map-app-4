// Escape の階段（設計書 §D.4）。**連打すれば必ず素の状態に戻る**ことを、状態の
// 組み合わせを全部回して固定する。
//
// 旧実装は「頂点と地物を同時に空にする」1 段しかなく、頂点を 3 つ選んだあとに
// 「地物だけ選んだ状態へ戻る」道が無かった。

import { describe, expect, it } from 'vitest';

import {
  ESCAPE_STEP,
  escapeHasWork,
  nextEscapeStep,
  type EscapeLadderInput,
} from './escape-ladder';

const NOTHING: EscapeLadderInput = {
  hasVertexSelection: false,
  hasActiveFeature: false,
  hasNonSelectTool: false,
};

describe('Escape の階段（設計書 §D.4 の下から 3 段）', () => {
  it('素の状態では何も起きない（灰色になる）', () => {
    expect(nextEscapeStep(NOTHING)).toBe(ESCAPE_STEP.None);
    expect(escapeHasWork(NOTHING)).toBe(false);
  });

  it('頂点 → 地物 → 道具 の順に 1 段ずつ戻る', () => {
    expect(
      nextEscapeStep({
        hasVertexSelection: true,
        hasActiveFeature: true,
        hasNonSelectTool: true,
      }),
    ).toBe(ESCAPE_STEP.ClearVertices);
    expect(
      nextEscapeStep({
        hasVertexSelection: false,
        hasActiveFeature: true,
        hasNonSelectTool: true,
      }),
    ).toBe(ESCAPE_STEP.ClearFeature);
    expect(
      nextEscapeStep({
        hasVertexSelection: false,
        hasActiveFeature: false,
        hasNonSelectTool: true,
      }),
    ).toBe(ESCAPE_STEP.ResetTool);
  });

  it('**連打すれば必ず素の状態に戻る**（8 通りの初期状態を全部回す）', () => {
    for (const hasVertexSelection of [false, true]) {
      for (const hasActiveFeature of [false, true]) {
        for (const hasNonSelectTool of [false, true]) {
          let state: EscapeLadderInput = {
            hasVertexSelection,
            hasActiveFeature,
            hasNonSelectTool,
          };
          // 各段は「その段の状態を 1 つ falsy にする」ので、3 回で必ず尽きる。
          // 4 回目までに None にならなければ、階段のどこかが自分を消していない。
          let steps = 0;
          while (nextEscapeStep(state) !== ESCAPE_STEP.None) {
            steps += 1;
            expect(steps, `${JSON.stringify(state)} で階段が止まらない`).toBeLessThan(4);
            switch (nextEscapeStep(state)) {
              case ESCAPE_STEP.ClearVertices:
                state = { ...state, hasVertexSelection: false };
                break;
              case ESCAPE_STEP.ClearFeature:
                state = { ...state, hasActiveFeature: false };
                break;
              case ESCAPE_STEP.ResetTool:
                state = { ...state, hasNonSelectTool: false };
                break;
              case ESCAPE_STEP.None:
                break;
            }
          }
          expect(nextEscapeStep(state)).toBe(ESCAPE_STEP.None);
        }
      }
    }
  });

  it('頂点を外しても地物の選択は残る（1 段ずつ戻れることの本体）', () => {
    const afterFirstEscape: EscapeLadderInput = {
      hasVertexSelection: false,
      hasActiveFeature: true,
      hasNonSelectTool: false,
    };
    expect(nextEscapeStep(afterFirstEscape)).toBe(ESCAPE_STEP.ClearFeature);
  });
});
