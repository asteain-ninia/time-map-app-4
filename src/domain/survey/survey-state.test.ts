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
