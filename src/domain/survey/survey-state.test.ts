import { describe, expect, it } from 'vitest';

import {
  SURVEY_PHASE,
  cancelDraft,
  clearSurvey,
  clickPoint,
  disableSurveyMode,
  discardOnToolSwitch,
  enableSurveyMode,
  initialSurveyState,
  removeSurveyLine,
  updateHover,
} from './survey-state';

const P = (lon: number, lat: number) => ({ lon, lat });

function active() {
  return enableSurveyMode(initialSurveyState());
}

describe('initial state', () => {
  it('is mode-off, idle, no draft, no lines', () => {
    const s = initialSurveyState();
    expect(s.active).toBe(false);
    expect(s.phase).toBe(SURVEY_PHASE.Idle);
    expect(s.draft).toBeNull();
    expect(s.lines).toEqual([]);
  });
});

describe('mode toggle (補助モード)', () => {
  it('enable activates and stays idle', () => {
    const s = active();
    expect(s.active).toBe(true);
    expect(s.phase).toBe(SURVEY_PHASE.Idle);
  });

  it('enable/disable are idempotent and keep confirmed lines', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = clickPoint(s, P(10, 0)); // 1 confirmed line
    s = disableSurveyMode(s);
    expect(s.active).toBe(false);
    expect(s.lines).toHaveLength(1); // FR-15: lines persist past mode exit
    s = disableSurveyMode(s);
    expect(s.lines).toHaveLength(1);
  });
});

describe('completion trigger: 2 clicks -> 1 line (AC-1 / 教訓 5.7)', () => {
  it('first click sets the start (AwaitingEnd), second confirms a line', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    expect(s.phase).toBe(SURVEY_PHASE.AwaitingEnd);
    expect(s.draft).not.toBeNull();
    expect(s.lines).toHaveLength(0);

    s = clickPoint(s, P(20, 10));
    expect(s.phase).toBe(SURVEY_PHASE.Idle);
    expect(s.draft).toBeNull(); // draft discarded after confirm (教訓 5.2)
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]?.start).toEqual(P(0, 0));
    expect(s.lines[0]?.end).toEqual(P(20, 10));
  });

  it('supports multiple lines simultaneously (FR-15)', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = clickPoint(s, P(1, 1));
    s = clickPoint(s, P(2, 2));
    s = clickPoint(s, P(3, 3));
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]?.id).not.toBe(s.lines[1]?.id); // unique transient ids
  });

  it('clicks while mode is off are ignored', () => {
    let s = initialSurveyState();
    s = clickPoint(s, P(0, 0));
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(0);
  });
});

describe('hover preview (一時表示)', () => {
  it('updateHover updates the draft hover only while drafting', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = updateHover(s, P(5, 5));
    expect(s.draft?.hover).toEqual(P(5, 5));
  });

  it('updateHover is a no-op when idle or mode off', () => {
    const idle = active();
    expect(updateHover(idle, P(5, 5))).toBe(idle);
    const off = initialSurveyState();
    expect(updateHover(off, P(5, 5))).toBe(off);
  });
});

describe('temporary-draft discard on ALL paths (AC-5 / 教訓 5.2)', () => {
  it('cancel discards the draft, keeps confirmed lines', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = clickPoint(s, P(1, 1)); // 1 line
    s = clickPoint(s, P(2, 2)); // start a 2nd draft
    expect(s.draft).not.toBeNull();
    s = cancelDraft(s);
    expect(s.draft).toBeNull();
    expect(s.phase).toBe(SURVEY_PHASE.Idle);
    expect(s.lines).toHaveLength(1);
  });

  it('tool switch discards the draft, keeps confirmed lines', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = clickPoint(s, P(1, 1));
    s = clickPoint(s, P(2, 2));
    s = discardOnToolSwitch(s);
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(1);
  });

  it('mode exit discards ONLY the draft and KEEPS confirmed lines (named pitfall §6)', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = clickPoint(s, P(1, 1)); // 1 confirmed line
    s = clickPoint(s, P(2, 2)); // mid-draft
    s = disableSurveyMode(s);
    expect(s.draft).toBeNull(); // draft gone
    expect(s.lines).toHaveLength(1); // line kept
  });

  it('continuous mid-draft -> cancel -> re-survey leaves no residual draft (AC-5)', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = cancelDraft(s);
    s = clickPoint(s, P(10, 0));
    expect(s.draft?.start).toEqual(P(10, 0)); // fresh draft, not the old one
  });

  it('continuous mid-draft -> mode toggle off/on -> re-survey leaves no residual', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = disableSurveyMode(s);
    s = enableSurveyMode(s);
    expect(s.draft).toBeNull();
    s = clickPoint(s, P(9, 9));
    expect(s.draft?.start).toEqual(P(9, 9));
  });
});

describe('clear empties BOTH slots (AC-3 / 教訓 5.7)', () => {
  it('clear removes all lines and any in-progress draft', () => {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = clickPoint(s, P(1, 1));
    s = clickPoint(s, P(2, 2)); // mid-draft + 1 line
    s = clearSurvey(s);
    expect(s.lines).toHaveLength(0);
    expect(s.draft).toBeNull();
    expect(s.phase).toBe(SURVEY_PHASE.Idle);
    expect(s.active).toBe(true); // clear does not exit the mode
  });
});

describe('phase invariant', () => {
  it('phase always equals draft===null ? Idle : AwaitingEnd', () => {
    let s = active();
    const check = () =>
      expect(s.phase).toBe(s.draft === null ? SURVEY_PHASE.Idle : SURVEY_PHASE.AwaitingEnd);
    check();
    s = clickPoint(s, P(0, 0));
    check();
    s = clickPoint(s, P(1, 1));
    check();
  });
});

describe('immutability (lesson 5.17)', () => {
  it('transitions return new objects, never mutate the input', () => {
    const s0 = active();
    const s1 = clickPoint(s0, P(0, 0));
    expect(s1).not.toBe(s0);
    expect(s0.draft).toBeNull();
  });
});

// --- 増分 8C: 線を 1 本だけ消す（設計書 §E.1 V15）-----------------------------

describe('removeSurveyLine — 線を 1 本だけ消す（増分 8C の中身 1）', () => {
  function threeLines() {
    let s = active();
    s = clickPoint(s, P(0, 0));
    s = clickPoint(s, P(10, 10));
    s = clickPoint(s, P(20, 0));
    s = clickPoint(s, P(30, 10));
    s = clickPoint(s, P(40, 0));
    s = clickPoint(s, P(50, 10));
    return s;
  }

  it('指定した id の 1 本だけが消え、ほかの線は順番どおり残る', () => {
    const s = threeLines();
    const [, second] = s.lines;
    const next = removeSurveyLine(s, second!.id);
    expect(next.lines.map((l) => l.id)).toEqual([s.lines[0]!.id, s.lines[2]!.id]);
  });

  it('測っている途中の始点（draft）には触らない', () => {
    let s = threeLines();
    s = clickPoint(s, P(60, 0)); // 始点だけ押した
    const next = removeSurveyLine(s, s.lines[0]!.id);
    expect(next.draft).toEqual(s.draft);
    expect(next.phase).toBe(SURVEY_PHASE.AwaitingEnd);
    expect(next.lines).toHaveLength(2);
  });

  it('id の発行は戻さない（消したあとに測った線は新しい id を持つ）', () => {
    const s = threeLines();
    const removed = removeSurveyLine(s, s.lines[2]!.id);
    expect(removed.nextLineId).toBe(s.nextLineId);
    let again = clickPoint(removed, P(0, 20));
    again = clickPoint(again, P(10, 30));
    expect(again.lines[again.lines.length - 1]!.id).toBe(s.nextLineId);
  });

  it('無い id（クリアのあとで押した古いメニューなど）は同じ参照をそのまま返す（教訓 5.24）', () => {
    const s = threeLines();
    expect(removeSurveyLine(s, 9999)).toBe(s);
    const cleared = clearSurvey(s);
    expect(removeSurveyLine(cleared, s.lines[0]!.id)).toBe(cleared);
  });

  it('入力の状態を書き換えない（lesson 5.17）', () => {
    const s = threeLines();
    const snapshot = JSON.stringify(s);
    removeSurveyLine(s, s.lines[1]!.id);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('測量が OFF でも消せる（線は OFF のあいだも描かれている＝FR-15）', () => {
    const s = disableSurveyMode(threeLines());
    const next = removeSurveyLine(s, s.lines[0]!.id);
    expect(next.lines).toHaveLength(2);
    expect(next.active).toBe(false);
  });
});
