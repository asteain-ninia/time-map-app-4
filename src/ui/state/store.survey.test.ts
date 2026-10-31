// U16 — the survey slice (U37 / FR-14 / FR-15 / FR-16 結線).
//
// The store holds ONE SurveyState (domain/survey) and exposes thin actions that
// only call the pure domain transitions (単一真実源 — no re-implemented survey
// logic here). These tests pin the reset契約 matrix rows the STORE owns
// (仕様書 §7): confirm keeps `active`, disable keeps `lines` (FR-15 — the named
// pitfall: 解除=ドラフトのみ破棄), clear empties both, and a LOAD / NEW discards
// the whole slice. They also pin that NO survey action ever touches
// `projectDirty` or the domain reference (survey is non-persisted UI display).
//
// **増分 5 の手直し A5 で `surveyEnable` の契約が変わった。** 以前ここは「道具は外すが
// `mode` は変えない」を固定していたが、それが欠陥そのものだった ―― 道具を外したのに
// `mode` を追加のまま残すと、**画面は「選択」なのに内部は「追加」**になり、左クリックは
// 追加の経路へ送られるのに追加のコントローラは居らず、選ぶことも追加することも
// できなくなる。いまの契約は「**測量を入れたら道具は外れ、`mode` も道具から導き直す**」
// （`mode = 鍵が閉 ? 読むだけ : 面/線/点 ? 追加 : 編集`）。測量が第 4 のモードになった
// わけではない ―― `mode` は相変わらず道具から導かれるだけである。

import { describe, expect, it } from 'vitest';

import { createCommandResult } from '../../domain/command/result';
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
  it('測量を入れると、道具を外すのと mode の導き直しが 1 回の遷移で一緒に起きる', () => {
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
    // 道具が外れたので、導出式のとおり編集になる（ナイフは編集の道具なので値は同じ）。
    expect(s.mode).toBe(EDIT_MODE.Edit);
    expect(transitions).toBe(1);
  });

  it('面を描いている最中に測量を入れると、mode も編集へ導き直される（A5 の穴）', () => {
    // **旧い契約はここを「追加のまま」に固定していた**。それだと左クリックは追加の
    // 経路へ送られるのに、道具を外したせいで追加のコントローラは居ない ―― 選ぶことも
    // 追加することもできない状態が残る。道具と mode は必ず一緒に動かす。
    const store = makeStore({ mode: EDIT_MODE.Add, activeTool: asToolId('add.area') });

    store.getState().surveyEnable();

    const s = store.getState();
    expect(s.activeTool).toBeNull();
    expect(s.mode).toBe(EDIT_MODE.Edit);
  });

  it('鍵が閉じているあいだは読むだけのまま（測量が編集の入口にならない）', () => {
    // 導出式は「鍵が閉じていれば読むだけ」を先に返す。測量は表示の補助なので、
    // これを入れたからといって編集の関門（K-6）が開いてはいけない。
    const store = makeStore({ mode: EDIT_MODE.View });

    store.getState().surveyEnable();

    expect(store.getState().survey.active).toBe(true);
    expect(store.getState().mode).toBe(EDIT_MODE.View);
    expect(store.getState().activeTool).toBeNull();
  });

  it('does not clear the selection (survey is a viewing aid, not a tool switch)', () => {
    const store = makeStore();
    store.getState().setActiveFeature(asFeatureId('f1'));
    store.getState().surveyEnable();
    expect(store.getState().activeFeature).toBe(asFeatureId('f1'));
  });

  it('測量を切っても道具は戻らない（入れたときに外したものを勝手に復活させない）', () => {
    const store = makeStore({ mode: EDIT_MODE.Edit, activeTool: asToolId('add.area') });
    store.getState().surveyEnable();
    store.getState().surveyDisable();
    expect(store.getState().activeTool).toBeNull();
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);
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

  it('surveyRemoveLine（増分 8C）: 1 本だけ消える / 途中の始点・active は保つ / 無い id は書かない', () => {
    const store = armed();
    store.getState().surveyClickPoint(P1); // armed() の途中の測量を確定 → 2 本
    const [first, second] = store.getState().survey.lines;
    expect(second).toBeDefined();
    store.getState().surveyClickPoint(P2); // 始点だけ押した途中の測量
    const draft = store.getState().survey.draft;
    store.getState().surveyRemoveLine(first!.id);
    const s = store.getState().survey;
    expect(s.lines.map((l) => l.id)).toEqual([second!.id]);
    expect(s.draft).toBe(draft);
    expect(s.active).toBe(true);
    // 無い id は同じ参照のまま（購読者に余計な世代を見せない）。
    store.getState().surveyRemoveLine(first!.id);
    expect(store.getState().survey).toBe(s);
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
    store.getState().surveyRemoveLine(store.getState().survey.lines[0]?.id ?? -1);
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

// --- 増分 8C の手直し（反証 #2）: 消した線を戻す覚えと、それを捨てる契機 ----------------

describe('surveyRestoreRemovedLine — 直前に消した線を戻す（増分 8C の手直し）', () => {
  /** 線を 2 本測ってから 1 本目を消した状態。 */
  function removedOne() {
    const store = makeStore({ mode: EDIT_MODE.Edit });
    store.getState().surveyEnable();
    store.getState().surveyClickPoint(P1);
    store.getState().surveyClickPoint(P2);
    store.getState().surveyClickPoint(P2);
    store.getState().surveyClickPoint(P3);
    const ids = store.getState().survey.lines.map((l) => l.id);
    store.getState().surveyRemoveLine(ids[0]!);
    expect(store.getState().survey.removed).not.toBeNull();
    return { store, ids };
  }

  it('消した線を元の位置へ戻し、true を返す。覚えが無ければ false で何も書かない', () => {
    const { store, ids } = removedOne();
    expect(store.getState().surveyRestoreRemovedLine()).toBe(true);
    expect(store.getState().survey.lines.map((l) => l.id)).toEqual(ids);
    const after = store.getState().survey;
    expect(store.getState().surveyRestoreRemovedLine()).toBe(false);
    expect(store.getState().survey).toBe(after);
  });

  it('地物の編集（applyCommandResult）で覚えを捨てる ―― そのあとの Ctrl+Z は地物の取り消しへ', () => {
    const { store } = removedOne();
    const lines = store.getState().survey.lines;
    store.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({}));
    expect(store.getState().survey.removed).toBeNull();
    expect(store.getState().survey.lines).toBe(lines);
    expect(store.getState().surveyRestoreRemovedLine()).toBe(false);
  });

  it('地物の取り消し／やり直し（applyUndoRedoResult）でも覚えを捨てる', () => {
    const { store } = removedOne();
    store.getState().applyUndoRedoResult({ tag: 'd0' }, createCommandResult({}));
    expect(store.getState().survey.removed).toBeNull();
  });

  it('道具の持ち替え・鍵の切り替えで覚えを捨てる', () => {
    const a = removedOne().store;
    a.getState().setActiveTool(asToolId('edit.knife'));
    expect(a.getState().survey.removed).toBeNull();
    const b = removedOne().store;
    b.getState().setMode(EDIT_MODE.View);
    expect(b.getState().survey.removed).toBeNull();
  });

  it('覚えが無いときの編集・持ち替えは survey の参照を変えない（測量の層を描き直させない）', () => {
    const store = makeStore({ mode: EDIT_MODE.Edit });
    store.getState().surveyEnable();
    store.getState().surveyClickPoint(P1);
    store.getState().surveyClickPoint(P2);
    const before = store.getState().survey;
    store.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({}));
    store.getState().setActiveTool(asToolId('edit.knife'));
    expect(store.getState().survey.lines).toBe(before.lines);
    expect(store.getState().survey.removed).toBeNull();
  });
});
