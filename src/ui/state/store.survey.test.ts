// U16 — the survey slice (U37 / FR-14 / FR-15 / FR-16 結線).
//
// The store holds ONE SurveyState (domain/survey) and exposes thin actions that
// only call the pure domain transitions (単一真実源 — no re-implemented survey
// logic here). These tests pin the reset契約 matrix rows the STORE owns
// (仕様書 §7): confirm keeps `active`, disable keeps `lines` (FR-15 — the named
// pitfall: 解除=ドラフトのみ破棄), clear empties both, and a LOAD / NEW discards
// the whole slice. They also pin the two integration invariants: surveyEnable
// null-ifies the active tool WITHOUT changing the mode (survey is a separate
// 補助モード axis, specs/U37 §2.1), and NO survey action ever touches
// `projectDirty` or the domain reference (survey is non-persisted UI display).

import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';
import { SURVEY_PHASE } from '../../domain/survey/index';

import { EDIT_MODE, asToolId } from './session';
import { createSessionStore } from './store';

interface TestDomain {
  readonly tag: string;
}

function makeStore(
  initial?: Parameters<typeof createSessionStore<TestDomain>>[0]['initial'],
) {
  return createSessionStore<TestDomain>({
    initialDomain: { tag: 'd0' },
    ...(initial ? { initial } : {}),
  });
}

const P1 = { lon: 10, lat: 20 };
const P2 = { lon: 30, lat: 40 };
const P3 = { lon: -50, lat: 5 };

describe('survey slice — initial state', () => {
  it('starts inactive with no draft and no lines (教訓 5.18: explicit empty)', () => {
    const s = makeStore().getState();
    expect(s.survey.active).toBe(false);
    expect(s.survey.phase).toBe(SURVEY_PHASE.Idle);
    expect(s.survey.draft).toBeNull();
    expect(s.survey.lines).toEqual([]);
  });
});

describe('surveyEnable — the 補助モード toggle (別軸, specs/U37 §2.1)', () => {
  it('activates survey AND clears the active tool in ONE transition, keeping the mode', () => {
    const store = makeStore({ mode: EDIT_MODE.Edit, activeTool: asToolId('edit.knife') });
    let transitions = 0;
    store.subscribe(() => {
      transitions += 1;
    });

    store.getState().surveyEnable();

    const s = store.getState();
    expect(s.survey.active).toBe(true);
    // The edit-tool bridge unmounts in the SAME set() (入力軸の相互排他).
    expect(s.activeTool).toBeNull();
    // The View/Add/Edit mode is NOT an axis survey writes (第4 EDIT_MODE にしない).
    expect(s.mode).toBe(EDIT_MODE.Edit);
    expect(transitions).toBe(1);
  });

  it('does not clear the selection (survey is a viewing aid, not a tool switch)', () => {
    const store = makeStore();
    store.getState().setActiveFeature(asFeatureId('f1'));
    store.getState().surveyEnable();
    expect(store.getState().activeFeature).toBe(asFeatureId('f1'));
  });
});

describe('survey click flow (FR-14 二点間測量)', () => {
  it('first click drafts, second click confirms ONE line and returns to Idle', () => {
    const store = makeStore();
    store.getState().surveyEnable();

    store.getState().surveyClickPoint(P1);
    let s = store.getState();
    expect(s.survey.phase).toBe(SURVEY_PHASE.AwaitingEnd);
    expect(s.survey.draft?.start).toEqual(P1);
    expect(s.survey.lines).toHaveLength(0);

    store.getState().surveyClickPoint(P2);
    s = store.getState();
    // Matrix row「2点目クリック(確定)」: draft 破棄 / 確定線 +1 / active 保持.
    expect(s.survey.phase).toBe(SURVEY_PHASE.Idle);
    expect(s.survey.draft).toBeNull();
    expect(s.survey.lines).toHaveLength(1);
    expect(s.survey.lines[0]).toMatchObject({ start: P1, end: P2 });
    expect(s.survey.active).toBe(true);
  });

  it('surveyUpdateHover updates the live draft hover', () => {
    const store = makeStore();
    store.getState().surveyEnable();
    store.getState().surveyClickPoint(P1);

    store.getState().surveyUpdateHover(P3);

    expect(store.getState().survey.draft?.hover).toEqual(P3);
  });

  it('surveyUpdateHover with NO draft is an identity no-op (no store notification)', () => {
    const store = makeStore();
    store.getState().surveyEnable();
    const before = store.getState().survey;
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.getState().surveyUpdateHover(P3);

    expect(store.getState().survey).toBe(before);
    expect(notified).toBe(0);
  });
});

describe('reset契約 matrix — the draft-only vs full-clear distinction (仕様書 §7)', () => {
  /** enable → confirm one line → start a second draft. */
  function armed() {
    const store = makeStore();
    store.getState().surveyEnable();
    store.getState().surveyClickPoint(P1);
    store.getState().surveyClickPoint(P2);
    store.getState().surveyClickPoint(P3); // in-progress draft
    expect(store.getState().survey.draft).not.toBeNull();
    expect(store.getState().survey.lines).toHaveLength(1);
    return store;
  }

  it('surveyCancelDraft (Escape 経路): draft 破棄 / 確定線 保持 / active 保持', () => {
    const store = armed();
    store.getState().surveyCancelDraft();
    const s = store.getState().survey;
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(1);
    expect(s.active).toBe(true);
  });

  it('surveyDisable (トグル OFF): draft 破棄 / 確定線【保持】(FR-15) / active false', () => {
    const store = armed();
    store.getState().surveyDisable();
    const s = store.getState().survey;
    expect(s.draft).toBeNull();
    // The NAMED pitfall (U37 §6): mode exit keeps the confirmed lines.
    expect(s.lines).toHaveLength(1);
    expect(s.active).toBe(false);
  });

  it('surveyClear (クリア): draft 破棄 / 確定線 全消去 / active 保持', () => {
    const store = armed();
    store.getState().surveyClear();
    const s = store.getState().survey;
    expect(s.draft).toBeNull();
    expect(s.lines).toEqual([]);
    expect(s.active).toBe(true);
  });

  it('re-enable after disable KEEPS the confirmed lines (FR-15 across toggles)', () => {
    const store = armed();
    store.getState().surveyDisable();
    store.getState().surveyEnable();
    expect(store.getState().survey.lines).toHaveLength(1);
  });

  it('resetToDomain (LOAD/NEW): the whole slice is discarded (U37 §4.5)', () => {
    const store = armed();
    store.getState().resetToDomain({ tag: 'loaded' });
    const s = store.getState().survey;
    expect(s.active).toBe(false);
    expect(s.draft).toBeNull();
    expect(s.lines).toEqual([]);
  });

  it('reflectLoadedProject (atomic LOAD/NEW): the whole slice is discarded', () => {
    const store = armed();
    store.getState().reflectLoadedProject({ tag: 'loaded' }, {});
    const s = store.getState().survey;
    expect(s.active).toBe(false);
    expect(s.draft).toBeNull();
    expect(s.lines).toEqual([]);
  });
});

describe('survey slice never touches the persisted truth (非保存 UI display)', () => {
  it('no survey action changes projectDirty or the domain reference', () => {
    const store = makeStore();
    const domainBefore = store.getState().domain;

    store.getState().surveyEnable();
    store.getState().surveyClickPoint(P1);
    store.getState().surveyUpdateHover(P3);
    store.getState().surveyClickPoint(P2);
    store.getState().surveyCancelDraft();
    store.getState().surveyClear();
    store.getState().surveyDisable();

    expect(store.getState().projectDirty).toBe(false);
    expect(store.getState().domain).toBe(domainBefore);
  });

  it('mode/tool setters do not touch the survey slice (別軸の非干渉)', () => {
    const store = makeStore();
    store.getState().surveyEnable();
    store.getState().surveyClickPoint(P1);
    store.getState().surveyClickPoint(P2);
    const before = store.getState().survey;

    // The store-side setters leave survey alone; the CONTROLLER owns the
    // tool-select → surveyDisable / mode-change → surveyCancelDraft rules.
    store.getState().setMode(EDIT_MODE.Add);
    store.getState().setActiveTool(asToolId('add.area'));

    expect(store.getState().survey).toBe(before);
  });
});
