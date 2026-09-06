// U23 — CROSS-LAYER INTEGRATION test (受け入れ基準 1 / 6 / 7).
//
// The other U23 tests cover the domain core and the hook in isolation. THIS test
// is the layer-crossing verification the lens flagged as missing: it mounts the
// REAL shell chrome (AppShell + Toolbar) together with the REAL AddToolController
// over ONE session store, and drives the whole add flow through the actual UI —
// toolbar tool selection, the map-input layer, the complete button, the property
// form, Escape / Ctrl+Z, and mode / tool switches — asserting that:
//   - 受け入れ基準 1: selecting 点/線/面 → clicking → completing → the property
//     form → save records the proposal at the current timeline time (the COMPLETE
//     and SAVE triggers are wired and fire — 教訓 5.7);
//   - 受け入れ基準 7: the property-form SAVE actually invokes the injected U13
//     process-start adapter (a logic method existing but never called from the UI
//     is caught here as a regression);
//   - 受け入れ基準 6: the transient session is discarded on EVERY exit path —
//     cancel→re-start, save(commit)→re-start, tool switch, mode switch — and the
//     provisional render batch is pushed to the render sink and cleared on discard
//     (render接続 + 教訓 5.2 全経路で破棄).
//
// This runs in jsdom (no Electron, no GUI): the renderer transform + draw sink are
// faked so the test is deterministic and non-interactive, while the WIRING under
// test is the production component graph, not a stand-in.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { type AddProposal } from '../../domain/add/index';
import {
  PROCESS_STATUS,
  REJECTION_KIND,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Command } from '../../domain/command/command';
import { EMPTY_COMMAND_RESULT } from '../../domain/command/result';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { timePointYearMonthDay } from '../../domain/time/time-point';

import { useState } from 'react';

import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';
import { AppShell } from '../shell';
import { CommandRegistry, COMMAND_ID } from '../shell/commands';

import { OptionBar } from '../shell/OptionBar';
import { OptionBarStore } from '../shell/option-bar';

import { AddDraftForm } from './AddPropertyForm';
import { AddDraftStore } from './add-draft-store';
import { AddToolController, type AddDrawSink, type ScreenToWorld } from './AddToolController';
import { ADD_PHASE } from './useAddTool';

type S = { tag: string };
const STATE: S = { tag: 'committed-state' };

const noopCommand: Command<S> = {
  kind: 'composite' as Command<S>['kind'],
  label: 'add',
  execute: () => ({ state: STATE, result: EMPTY_COMMAND_RESULT }),
  undo: () => ({ state: STATE, result: EMPTY_COMMAND_RESULT }),
  redo: () => ({ state: STATE, result: EMPTY_COMMAND_RESULT }),
};

const committed: ProcessResult<S> = {
  status: PROCESS_STATUS.Committed,
  state: STATE,
  command: noopCommand,
};

// Identity screen→world so a click at (lon*1, lat*1) lands at that world point.
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

/**
 * The host commit handler (`onCommitted` is now REQUIRED — Codex SPECULATIVE 根治:
 * the controller no longer carries a store-writing default that bypassed the host
 * funnel). This test host replicates the minimal commit reflection the removed
 * default performed: replay the command for its CommandResult, swap in the
 * committed state, promote the new feature.
 */
function hostCommit(store: StoreApi<SessionStore<S>>) {
  return (result: ProcessResult<S>, newFeatureId: ReturnType<typeof asFeatureId>): void => {
    if (result.status === PROCESS_STATUS.Committed) {
      const commandResult = result.command.execute(store.getState().domain).result;
      store.getState().applyCommandResult(result.state, commandResult, {
        featureId: newFeatureId,
      });
    }
  };
}

interface Harness {
  readonly store: StoreApi<SessionStore<S>>;
  readonly startProcess: ReturnType<typeof vi.fn>;
  readonly drawSink: AddDrawSink;
  readonly drawCalls: { primitives: readonly unknown[] }[];
  readonly proposals: AddProposal[];
  /** 増分 3: 確定のたびにホストへ渡る「確定したものの素性」（共有した頂点の数）。 */
  readonly committedInfo: ({ readonly sharedVertexCount: number } | undefined)[];
}

function mountApp(
  resultFor: () => ProcessResult<S> = () => committed,
  extra: {
    readonly onDraftDiscarded?: (count: number) => void;
    readonly onFocusSelection?: () => void;
    /** 確認の板の開閉を受ける口（増分 5 の手直し A3 / A4）。 */
    readonly onModalChange?: (open: boolean) => void;
  } = {},
): Harness {
  const store = createSessionStore<S>({
    initialDomain: { tag: 'initial' },
    initial: {
      mode: EDIT_MODE.Add,
      currentTime: timePointYearMonthDay(1500, 6, 20),
    },
  });

  const proposals: AddProposal[] = [];
  const startProcess = vi.fn((proposal: AddProposal): ProcessResult<S> => {
    proposals.push(proposal);
    return resultFor();
  });

  const committedInfo: ({ readonly sharedVertexCount: number } | undefined)[] = [];
  const drawCalls: { primitives: readonly unknown[] }[] = [];
  const drawSink: AddDrawSink = {
    drawAdd: (primitives) => {
      drawCalls.push({ primitives });
    },
  };

  let f = 0;
  let v = 0;
  let r = 0;

  // 増分 3: 道具の帯（確定・やめる・1 つ戻す・吸着 ▾）は **オプションバー**へ、確定後の
  // 素性入力は **素性欄の位置**へ移った。実アプリと同じ器を用意して結線ごと検査する。
  const optionBar = new OptionBarStore();
  const addDraft = new AddDraftStore();

  render(
    <AppShell
      store={store}
      optionBar={<OptionBar store={optionBar} />}
      sidebar={{ propertiesContent: <AddDraftForm store={addDraft} /> }}
      overlay={
        <AddToolController<S>
          store={store}
          startProcess={startProcess}
          ids={{
            nextFeatureId: () => asFeatureId(`f${++f}`),
            nextVertexId: () => asVertexId(`v${++v}`),
          }}
          nextRingId={() => asRingId(`r${++r}`)}
          screenToWorld={screenToWorld}
          drawSink={drawSink}
          optionBar={optionBar}
          addDraft={addDraft}
          onCommitted={(result, id, info) => {
            committedInfo.push(info);
            hostCommit(store)(result, id);
          }}
          {...(extra.onDraftDiscarded ? { onDraftDiscarded: extra.onDraftDiscarded } : {})}
          {...(extra.onFocusSelection ? { onFocusSelection: extra.onFocusSelection } : {})}
          {...(extra.onModalChange ? { onModalChange: extra.onModalChange } : {})}
        />
      }
    />,
  );

  return { store, startProcess, drawSink, drawCalls, proposals, committedInfo };
}

/**
 * 描画フレームを手で進めるための差し替え（D9 の検査用）。実物の
 * `requestAnimationFrame` は待ち時間が読めないので、予約を貯めて {@link runFrames} で
 * 1 回だけ流す。レイアウトを持たない環境で寸法を測るのとは違い、これは
 * 「呼び出し回数」を数えるだけなので永久に緑にはならない（教訓 5.49）。
 */
let frameQueue: FrameRequestCallback[] = [];
function installFrameStub(): void {
  frameQueue = [];
  let id = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frameQueue.push(cb);
    id += 1;
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof globalThis.cancelAnimationFrame;
}
function runFrames(): void {
  const queued = frameQueue;
  frameQueue = [];
  for (const cb of queued) cb(0);
}

function selectTool(testId: string): void {
  act(() => {
    fireEvent.click(screen.getByTestId(testId));
  });
}

function clickMap(lon: number, lat: number): void {
  act(() => {
    fireEvent.pointerDown(screen.getByTestId('add-input-layer'), { clientX: lon, clientY: lat, button: 0 });
  });
}

/** window への Escape 1 回（道具のリスナーが受ける経路）。 */
function pressEscape(): void {
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' });
  });
}

/**
 * いま道具が居る局面（`data-phase`）。道具の器が消えていれば「素の状態」なので
 * {@link ADD_PHASE.Idle} を返す ―― どちらの形でも「作図は終わっている」である。
 */
function currentPhase(): string {
  return screen.queryByTestId('add-tool')?.getAttribute('data-phase') ?? ADD_PHASE.Idle;
}

/** 確認の板が出ているか。 */
function confirmShown(): boolean {
  return screen.queryByTestId('add-draft-discard-confirm') !== null;
}

/** 焦点を持った入力欄を作る（`data-pristine` を名乗らせられる）。 */
function focusedInputWith(attrs: { type?: string; pristine?: boolean } = {}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = attrs.type ?? 'text';
  if (attrs.pristine !== undefined) input.setAttribute('data-pristine', String(attrs.pristine));
  document.body.appendChild(input);
  input.focus();
  return input;
}

describe('U23 integration: toolbar → add flow → save (受け入れ基準 1 / 7, 教訓 5.7)', () => {
  it('point: select tool → click → complete → form → save records the proposal at current time', () => {
    const h = mountApp();
    // Selecting the point tool in the REAL toolbar starts a session (wiring).
    selectTool('tool-add.point');
    expect(screen.getByTestId('add-tool')).toBeInTheDocument();

    clickMap(10, 20);
    // COMPLETE trigger is enabled at 1 vertex for a point.
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();

    // SAVE trigger fires the injected U13 adapter (受け入れ基準 7).
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    expect(h.proposals[0]?.anchorTime).toEqual(timePointYearMonthDay(1500, 6, 20));
  });

  it('HB3-21: the complete button names the POINT tool (「点を確定」, not 「線を確定」)', () => {
    mountApp();
    selectTool('tool-add.point');
    clickMap(10, 20);
    // Regression: the point tool fell into the line branch and showed 「線を確定」.
    expect(screen.getByTestId('add-complete')).toHaveTextContent('点を確定');
  });

  it('line: needs 2 vertices; <2 is rejected with a Japanese message, then completes', () => {
    const h = mountApp();
    selectTool('tool-add.line');
    clickMap(0, 0);
    // One vertex: complete is disabled (cannot confirm a line yet).
    expect(screen.getByTestId('add-complete')).toBeDisabled();
    clickMap(5, 5);
    expect(screen.getByTestId('add-complete')).toBeEnabled();
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
  });

  it('face: 3 vertices → complete → 親なし save records a top-level face (FR-77/FR-39)', () => {
    const h = mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    clickMap(2, 3);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    // The face property form shows the parent selector.
    expect(screen.getByTestId('add-parent')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    // 親なし (default) → no parentId (top-level, FR-39).
    expect(h.proposals[0]?.snapshot.feature.parentId).toBeUndefined();
  });
});

describe('U23 integration: 全経路で破棄 (受け入れ基準 6, 教訓 5.2)', () => {
  it('cancel discards placed vertices; the still-selected tool re-arms an empty session', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('2');
    // Cancel clears the placed vertices (受け入れ基準 6 / 教訓 5.2). The面 tool is
    // still selected, so the controller re-arms a FRESH empty session — re-start
    // begins with zero vertices.
    act(() => fireEvent.click(screen.getByTestId('add-cancel')));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
  });

  it('save (commit) re-arms an empty session for the next add (受け入れ基準 6)', () => {
    const h = mountApp();
    selectTool('tool-add.point');
    clickMap(1, 1);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    // Committed → the prior session is discarded and a fresh empty one re-armed
    // (the tool is still selected); the next add begins with zero vertices.
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
  });

  it('tool switch (面 → 線): 確定できない量の打ちかけは、聞かずに捨てる', () => {
    // **増分 5 の手直し A3 で契約が変わった**。確定できる点数まで打っていたら
    // 「黙って捨てない」（＝1 度聞く）ようになったので、聞かずに捨てるのは
    // **確定に届いていない量**のときだけになった（面は 3 点で確定できる）。
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('2');
    selectTool('tool-add.line');
    expect(confirmShown()).toBe(false);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
    expect(screen.getByTestId('add-is-line')).toBeInTheDocument();
  });

  it('tool switch (面 → 線): 確定できる打ちかけは、捨てる前に 1 度聞く（A3）', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    clickMap(2, 3);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    selectTool('tool-add.line');
    // まだ捨てていない ―― 板が出て、打った 3 点はそのまま。
    expect(confirmShown()).toBe(true);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    // ［捨てる］で初めて消える。捨てたあとは **待機**（道具は線を構えたまま、
    // 頂点 0 個）なので、次の 1 点で線の作図が始まる（D3 と同じ形）。
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-yes')));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
    clickMap(9, 9);
    expect(screen.getByTestId('add-is-line')).toBeInTheDocument();
  });

  it('道具を持ち替える（面 → 分ける）と作図の下書きは丸ごと捨てられる', () => {
    // **増分 5b**: モードの 3 ボタンが消えたので、「追加モード → 編集モード」ではなく
    // **道具の持ち替え**で同じことを見る（内部の mode は道具から導出されるので、
    // 面 → 分ける は add → edit そのものである＝設計書 §D.1）。
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    expect(screen.getByTestId('add-tool')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByTestId('tool-edit.knife')));
    expect(screen.queryByTestId('add-tool')).not.toBeInTheDocument();
  });

  it('Escape cancels while drawing; Ctrl+Z undoes one vertex', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('2');
    // Ctrl+Z removes the last vertex (FR-78).
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('1');
    // Escape cancels the whole add (教訓 5.2): placed vertices cleared. The tool is
    // still active so a fresh empty session re-arms (zero vertices).
    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
  });
});

describe('U23 integration: render接続 (FR-78 仮表示)', () => {
  it('feeds provisional primitives to the render sink as vertices are placed, and clears on discard', () => {
    const h = mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    clickMap(2, 3);
    // The latest draw call carries primitives for the placed vertices.
    const last = h.drawCalls[h.drawCalls.length - 1];
    expect(last).toBeDefined();
    expect(last?.primitives.length).toBeGreaterThan(0);
    // Cancelling discards the session → an empty batch is pushed (教訓 5.18 empty frame).
    act(() => fireEvent.click(screen.getByTestId('add-cancel')));
    const afterCancel = h.drawCalls[h.drawCalls.length - 1];
    expect(afterCancel?.primitives.length).toBe(0);
  });
});

describe('U23 integration: U13 rejection surfaces a Japanese message (FR-115)', () => {
  it('a rejected save shows the Japanese rejection and records nothing in the domain', () => {
    const rejected: ProcessResult<S> = {
      status: PROCESS_STATUS.Rejected,
      kind: REJECTION_KIND.TimeViolation,
      message: '時間が不正です。',
    };
    const h = mountApp(() => rejected);
    selectTool('tool-add.point');
    clickMap(1, 1);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    const rejection = screen.getByTestId('add-rejected');
    expect(within(rejection).getByRole('alert')).toHaveTextContent('時間が不正です。');
    // Nothing committed: the domain reference is unchanged.
    expect(h.store.getState().domain).toEqual({ tag: 'initial' });
  });
});

// bughunt3 H2 — Ctrl+Z must NOT double-fire during add drawing. Mounts the REAL
// production graph (AppShell wiring useShortcuts + the AddToolController) over ONE
// store, with the host derivation (suspended = addDrawing) the App uses, plus a live
// EditUndo handler on the SAME registry the shell dispatches. The empirically-verified
// listener order is: useShortcuts (mounted at shell level) registers BEFORE the
// controller's drawing-only keydown listener, so without suspension the global
// EditUndo fires FIRST on Ctrl+Z and the tool's vertex-undo ALSO fires — one Ctrl+Z
// would roll back a committed feature AND remove a vertex. The suspension makes the
// global path stand down while drawing, so only the tool's vertex-undo runs.
describe('U23 bughunt3 (H2): Ctrl+Z does NOT double-fire while drawing', () => {
  function mountWithGlobalUndo(): {
    store: StoreApi<SessionStore<S>>;
    globalUndo: ReturnType<typeof vi.fn>;
  } {
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: { mode: EDIT_MODE.Add, currentTime: timePointYearMonthDay(1500, 6, 20) },
    });
    const registry = new CommandRegistry();
    const globalUndo = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run: globalUndo });

    let f = 0;
    let v = 0;
    let r = 0;

    // Mirror the App.tsx host wiring: hold the drawing flag, thread it as `suspended`
    // into AppShell, and feed the controller's onDrawingChange back into it. This is
    // the exact production mechanism under test (no stand-in for the suspension).
    function Host(): JSX.Element {
      const [addDrawing, setAddDrawing] = useState(false);
      return (
        <AppShell
          store={store}
          registry={registry}
          suspended={addDrawing}
          overlay={
            <AddToolController<S>
              store={store}
              startProcess={() => committed}
              ids={{
                nextFeatureId: () => asFeatureId(`f${++f}`),
                nextVertexId: () => asVertexId(`v${++v}`),
              }}
              nextRingId={() => asRingId(`r${++r}`)}
              screenToWorld={screenToWorld}
              drawSink={{ drawAdd: () => {} }}
              onDrawingChange={setAddDrawing}
              onCommitted={hostCommit(store)}
            />
          }
        />
      );
    }
    render(<Host />);
    return { store, globalUndo };
  }

  it('removes only the last vertex; the global EditUndo never fires while drawing', () => {
    const { globalUndo } = mountWithGlobalUndo();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('2');

    // ONE Ctrl+Z while drawing: the tool removes the last vertex (2 → 1) and the
    // GLOBAL EditUndo (which would roll back a committed domain op) is suspended.
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('1');
    expect(globalUndo).not.toHaveBeenCalled();
  });

  it('the global EditUndo re-arms once the add session ends (back to Idle)', () => {
    const { store, globalUndo } = mountWithGlobalUndo();
    selectTool('tool-add.area');
    clickMap(0, 0);
    // Leaving 追加モード ends the session → suspension lifts; the global undo is live.
    act(() => store.getState().setMode(EDIT_MODE.Edit));
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(globalUndo).toHaveBeenCalledTimes(1);
  });
});

// バグハント第11波 #3/#6 — the controller's OWN window keydown listener (Escape /
// Ctrl+Z, live while drawing) MUST honour the SAME focus guard the global dispatcher
// does (教訓 5.13 single predicate). The timeline year field (YearMonthDayInput) and
// sidebar inputs are live at all times even while the add tool draws; a Ctrl+Z / Escape
// with a text input focused must edit the TEXT natively, NOT undo a draft vertex (#3)
// or cancel the whole add (#6). A non-editable focus still cancels / undoes as before.
describe('U23 バグハント第11波 (#3/#6): focus guard on the drawing keydown listener', () => {
  function focusedInput(type = 'text'): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  function drawTwoVertices(): void {
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('2');
  }

  it('Ctrl+Z with a text input focused does NOT undo a vertex and does NOT preventDefault (#3)', () => {
    mountApp();
    drawTwoVertices();
    const input = focusedInput('number'); // e.g. the timeline year field
    const ev = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    // The vertex count is untouched (native per-field undo, not draft-vertex undo)…
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('2');
    // …and the event was NOT prevented, so the browser's own text undo runs.
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
  });

  it('Escape は文字の欄の中でも道具が受ける（A2 で #6 の契約が変わった）', () => {
    // **旧い契約はここを「道具は受けない」に固定していた**。だが形を確定して名前を
    // 打つ局面では、大域の側も `focus-guard` で降りるので **Escape を誰も受けない**
    // （押しても何も起きない）状態ができていた ―― §D.4 の「連打すれば必ず素の状態に
    // 戻る」が、いちばん抜けにくい局面で破れていた。
    //
    // いまは道具が受ける。ただし **打ちかけのある欄では 1 度聞いてから**捨てる
    // （打った文字を黙って失わない）。欄が `data-pristine` を名乗らないときは
    // 「打ちかけがある」側に倒す。
    mountApp();
    drawTwoVertices();
    const input = focusedInputWith({ type: 'text' });
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    act(() => {
      input.dispatchEvent(ev);
    });
    // 打った点はまだ残っている（黙って消さない）。
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('2');
    expect(confirmShown()).toBe(true);
    // 道具が受けたので、欄の native な Escape は走らせない。
    expect(ev.defaultPrevented).toBe(true);
    input.remove();
  });

  it('打ちかけの無い欄（data-pristine="true"）からの Escape は、聞かずにやめる（A2）', () => {
    // 素性欄の Enter は「保存して次へ」なので、送ったあとは次の名前欄に焦点が入った
    // ままになる。そこで押した Escape に確認が出ると、**打っていないのに聞かれる**。
    mountApp();
    drawTwoVertices();
    const input = focusedInputWith({ type: 'text', pristine: true });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }));
    });
    expect(confirmShown()).toBe(false);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
    input.remove();
  });

  it('Escape / Ctrl+Z from a NON-editable focus still cancels / undoes (no regression)', () => {
    mountApp();
    drawTwoVertices();
    // A non-editable element (button) focused: the tool keys keep working.
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    act(() => fireEvent.keyDown(button, { key: 'z', ctrlKey: true }));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('1');
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
    button.remove();
  });
});

// --- 増分 3: オプションバーへの押し込みと「新規の姿」-------------------------

describe('U23 integration: 道具の帯（設計書 §C.4 / 増分 3）', () => {
  it('道具を構えると、道具名・対象・次の一手・確定が帯に出る', () => {
    mountApp();
    selectTool('tool-add.area');
    expect(screen.getByTestId('option-bar-tool')).toHaveTextContent('面を描く');
    expect(screen.getByTestId('option-bar-target')).toHaveTextContent('頂点 0 個（未確定）');
    expect(screen.getByTestId('option-bar-next-step')).toHaveTextContent('地図をクリック');
    expect(screen.getByTestId('add-complete')).toBeInTheDocument();
    expect(screen.getByTestId('add-cancel')).toBeInTheDocument();
  });

  it('頂点を打つと対象欄の数が増える（帯の中身が道具の状況を映す）', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    expect(screen.getByTestId('option-bar-target')).toHaveTextContent('頂点 2 個（未確定）');
  });

  it('設定欄に「吸着 ▾」が差し込まれ、辺・交点は押せない形で理由が出る（§N-6 裁定待ち）', () => {
    mountApp();
    selectTool('tool-add.area');
    expect(screen.getByTestId('option-snap-button')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByTestId('option-snap-button')));
    expect(screen.getByTestId('snap-vertex')).toBeEnabled();
    expect(screen.getByTestId('snap-edge')).toBeDisabled();
    expect(screen.getByTestId('snap-intersection')).toBeDisabled();
    expect(screen.getByTestId('option-snap-panel')).toHaveTextContent('まだ使えません');
  });

  it('許容 px を変えるとセッションの設定が変わる（保存ファイルは汚さない）', () => {
    const h = mountApp();
    selectTool('tool-add.area');
    act(() => fireEvent.click(screen.getByTestId('option-snap-button')));
    act(() => fireEvent.change(screen.getByTestId('snap-tolerance'), { target: { value: '20' } }));
    expect(h.store.getState().snapSettings.tolerancePx).toBe(20);
    expect(h.store.getState().projectDirty).toBe(false);
  });

  it('道具を降りると帯が空へ戻る（教訓 5.2: 一時状態は全経路で破棄）', () => {
    mountApp();
    selectTool('tool-add.area');
    expect(screen.getByTestId('option-bar-tool')).toHaveTextContent('面を描く');
    selectTool('tool-add.area'); // トグルなので外れる
    expect(screen.getByTestId('option-bar-tool')).not.toHaveTextContent('面を描く');
    expect(screen.queryByTestId('add-complete')).toBeNull();
  });

  it('確定すると「新規の姿」が素性欄の位置に出る（N-15: 地図の上には出ない）', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    const form = screen.getByTestId('add-property-form');
    expect(form).toBeInTheDocument();
    // 地図セルの覆い（app-shell-overlay）の中には無い ＝ いま描いた形を覆わない。
    expect(screen.getByTestId('app-shell-overlay').contains(form)).toBe(false);
    // G-8: 年代は「いま見ている年」を継ぐ（現在時刻は 1500 年）。
    expect(screen.getByTestId('add-era')).toHaveTextContent('1500年');
    // R5: 種別ラベルの欄がある。
    expect(screen.getByTestId('add-kind-label')).toBeInTheDocument();
  });

  it('種別ラベルを入れると提案に載る（R5）', () => {
    const h = mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    act(() => fireEvent.change(screen.getByTestId('add-kind-label'), { target: { value: '国' } }));
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    expect(h.proposals[0]?.snapshot.feature.kindLabel).toBe('国');
  });

  it('年代は現在時刻の年を継ぐ（G-8: 0 年固定をやめた）', () => {
    const h = mountApp();
    selectTool('tool-add.point');
    clickMap(1, 1);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    expect(h.proposals[0]?.snapshot.feature.attributes.startYear).toBe(1500);
  });
});

describe('U23 integration: 確定したことを状態行へ伝える（増分 3 / 設計書 §H.5）', () => {
  it('吸着していないときは共有 0 件として伝える', () => {
    const h = mountApp();
    selectTool('tool-add.point');
    clickMap(1, 1);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    expect(h.committedInfo).toEqual([{ sharedVertexCount: 0 }]);
  });
});

// --- 増分 3 の手直し: 局面に応じた帯（C2 / C3）と、保存後の待機（D3）と、
//     カーソル移動のまとめ（D9）----------------------------------------------

describe('U23 手直し: 局面に応じた帯（C2 / C3）', () => {
  it('素性を入力している間は、対象欄が「確定済み」・次の一手が「名前を入れて…」になる', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    // 確定前は「未確定」で、次の一手は作図の案内。
    expect(screen.getByTestId('option-bar-target')).toHaveTextContent('頂点 3 個（未確定）');
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    // 確定後は局面が変わる（もう頂点は打てないし、確定は済んでいる）。
    expect(screen.getByTestId('option-bar-target')).toHaveTextContent('頂点 3 個（確定済み）');
    expect(screen.getByTestId('option-bar-next-step')).toHaveTextContent(
      '名前を入れて［保存］を押してください',
    );
  });

  it('素性を入力している間も確定欄に［やめる］が残る（下書きを捨てる手が画面から消えない）', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    const cancel = screen.getByTestId('add-cancel');
    expect(cancel).toBeInTheDocument();
    // ［確定］は消える（もう確定は済んでいる）。
    expect(screen.queryByTestId('add-complete')).toBeNull();
    act(() => fireEvent.click(cancel));
    expect(screen.queryByTestId('add-property-form')).toBeNull();
  });

  it('設定欄に「記録する年」が出る（何年の姿になるかを押す前に見せる）', () => {
    mountApp();
    selectTool('tool-add.area');
    expect(screen.getByTestId('add-record-year')).toHaveTextContent('記録する年: 1500年');
  });
});

describe('U23 手直し D3: 保存のあとは待機に戻る（GPT #9）', () => {
  it('保存の直後は作図中ではない（大域の取り消しを占有しない）', () => {
    const drawing: boolean[] = [];
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: { mode: EDIT_MODE.Add, currentTime: timePointYearMonthDay(1500, 6, 20) },
    });
    const optionBar = new OptionBarStore();
    const addDraft = new AddDraftStore();
    let f = 0;
    let v = 0;
    let r = 0;
    render(
      <AppShell
        store={store}
        optionBar={<OptionBar store={optionBar} />}
        sidebar={{ propertiesContent: <AddDraftForm store={addDraft} /> }}
        overlay={
          <AddToolController<S>
            store={store}
            startProcess={() => committed}
            ids={{
              nextFeatureId: () => asFeatureId(`f${++f}`),
              nextVertexId: () => asVertexId(`v${++v}`),
            }}
            nextRingId={() => asRingId(`r${++r}`)}
            screenToWorld={screenToWorld}
            drawSink={{ drawAdd: () => undefined }}
            optionBar={optionBar}
            addDraft={addDraft}
            onDrawingChange={(d) => drawing.push(d)}
            onCommitted={(result, id) => hostCommit(store)(result, id)}
          />
        }
      />,
    );
    selectTool('tool-add.point');
    clickMap(1, 1);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    // **最後の報告が false**（＝待機。保存直後の Ctrl+Z が大域へ届く）。
    expect(drawing[drawing.length - 1]).toBe(false);
  });

  it('待機のまま地図を押すと、その 1 点目から作図が始まる（受け入れ基準 6）', () => {
    mountApp();
    selectTool('tool-add.point');
    clickMap(1, 1);
    act(() => fireEvent.click(screen.getByTestId('add-complete')));
    act(() => fireEvent.click(screen.getByTestId('add-save')));
    // 保存後は下書きが 0 個で待機している。
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
    // 1 点目を打つと作図が始まり、その点が落ちない（写しを先に更新している）。
    clickMap(9, 9);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('1');
  });
});

describe('U23 手直し D9: カーソル移動は 1 フレームに 1 回へまとめる', () => {
  it('続けざまの移動でも、予告の解決は次の描画フレームで 1 回だけ走る', () => {
    installFrameStub();
    const resolved: number[] = [];
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: { mode: EDIT_MODE.Add, currentTime: timePointYearMonthDay(1500, 6, 20) },
    });
    const optionBar = new OptionBarStore();
    const addDraft = new AddDraftStore();
    let f = 0;
    let v = 0;
    let r = 0;
    render(
      <AppShell
        store={store}
        optionBar={<OptionBar store={optionBar} />}
        sidebar={{ propertiesContent: <AddDraftForm store={addDraft} /> }}
        overlay={
          <AddToolController<S>
            store={store}
            startProcess={() => committed}
            ids={{
              nextFeatureId: () => asFeatureId(`f${++f}`),
              nextVertexId: () => asVertexId(`v${++v}`),
            }}
            nextRingId={() => asRingId(`r${++r}`)}
            screenToWorld={screenToWorld}
            drawSink={{ drawAdd: () => undefined }}
            optionBar={optionBar}
            addDraft={addDraft}
            resolveProximity={(raw) => {
              resolved.push(raw.lon);
              return null;
            }}
            onCommitted={(result, id) => hostCommit(store)(result, id)}
          />
        }
      />,
    );
    selectTool('tool-add.area');
    clickMap(0, 0); // 作図を始める（クリックの経路は間引かない）
    const before = resolved.length;
    const layer = screen.getByTestId('add-input-layer');
    act(() => {
      for (let i = 0; i < 20; i += 1) {
        fireEvent.pointerMove(layer, { clientX: 10 + i, clientY: 10 });
      }
    });
    // フレームが来るまでは 1 件も解いていない。
    expect(resolved.length).toBe(before);
    // 予約されたフレームを 1 回だけ流す。
    act(() => {
      runFrames();
    });
    expect(resolved.length).toBe(before + 1);
    // 解いたのは **最後の 1 件**（取りこぼさない）。
    expect(resolved[resolved.length - 1]).toBe(29);
  });
});

describe('U23 手直し D1: 打ちかけの下書きを黙って消さない', () => {
  it('Escape は 3 点以上の打ちかけを確認してから捨てる', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    // まだ捨てていない（確認が出ている）。
    expect(screen.getByTestId('add-draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    // ［続ける］で下書きは残る。
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-no')));
    expect(screen.queryByTestId('add-draft-discard-confirm')).toBeNull();
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    // ［捨てる］で初めて消える。
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-yes')));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
  });

  it('自分の Escape で出した板は、もう一度の Escape で「捨てる」（A2）', () => {
    // **旧い契約はここを「このままにする」に固定していた**。それだと Escape を押す
    // たびに板が開いては閉じるだけで、**いつまでも素の状態に戻れない**（§D.4 の
    // 「連打すれば必ず素へ戻る」が破れる）。利用者自身が「やめる」と言ったために
    // 出ている板なので、2 回目の Escape は「はい、捨てる」である。
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    pressEscape();
    expect(confirmShown()).toBe(true);
    pressEscape();
    expect(confirmShown()).toBe(false);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
  });

  it('1〜2 点の打ちかけは聞かずに捨てる（押し直せば済む量）', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('add-draft-discard-confirm')).toBeNull();
    // 捨てたあとは **待機**（道具は構えたまま、頂点 0 個）。次の 1 点で作図が始まる（D3）。
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
  });

  it('道具を切り替えて打ちかけが消えるときは、捨てた数を報せる', () => {
    const discarded: number[] = [];
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: { mode: EDIT_MODE.Add, currentTime: timePointYearMonthDay(1500, 6, 20) },
    });
    const optionBar = new OptionBarStore();
    const addDraft = new AddDraftStore();
    let f = 0;
    let v = 0;
    let r = 0;
    render(
      <AppShell
        store={store}
        optionBar={<OptionBar store={optionBar} />}
        sidebar={{ propertiesContent: <AddDraftForm store={addDraft} /> }}
        overlay={
          <AddToolController<S>
            store={store}
            startProcess={() => committed}
            ids={{
              nextFeatureId: () => asFeatureId(`f${++f}`),
              nextVertexId: () => asVertexId(`v${++v}`),
            }}
            nextRingId={() => asRingId(`r${++r}`)}
            screenToWorld={screenToWorld}
            drawSink={{ drawAdd: () => undefined }}
            optionBar={optionBar}
            addDraft={addDraft}
            onDraftDiscarded={(n) => discarded.push(n)}
            onCommitted={(result, id) => hostCommit(store)(result, id)}
          />
        }
      />,
    );
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    // **A3 で契約が変わった**: 確定できる点数（面は 3 点）まで打っていたら、道具を
    // 持ち替えても黙って捨てず 1 度聞く。だから「聞かずに捨てて報せる」のは
    // **確定に届いていない量**のときである。
    selectTool('tool-add.point'); // 別の道具へ切り替える
    expect(discarded).toEqual([2]);
  });
});

describe('U23 手直し: 置く動作は、予約されたカーソル移動より後に効かない', () => {
  it('断りの理由が、あとから走るカーソル移動に消されない（D9 と D1 の順序）', () => {
    installFrameStub();
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: { mode: EDIT_MODE.Add, currentTime: timePointYearMonthDay(1500, 6, 20) },
    });
    const optionBar = new OptionBarStore();
    const addDraft = new AddDraftStore();
    let f = 0;
    let v = 0;
    let r = 0;
    render(
      <AppShell
        store={store}
        optionBar={<OptionBar store={optionBar} />}
        sidebar={{ propertiesContent: <AddDraftForm store={addDraft} /> }}
        overlay={
          <AddToolController<S>
            store={store}
            startProcess={() => committed}
            ids={{
              nextFeatureId: () => asFeatureId(`f${++f}`),
              nextVertexId: () => asVertexId(`v${++v}`),
            }}
            nextRingId={() => asRingId(`r${++r}`)}
            screenToWorld={screenToWorld}
            drawSink={{ drawAdd: () => undefined }}
            optionBar={optionBar}
            addDraft={addDraft}
            onCommitted={(result, id) => hostCommit(store)(result, id)}
          />
        }
      />,
    );
    selectTool('tool-add.area');
    clickMap(0, 0);
    // カーソルを動かして 1 フレーム分を予約したまま、緯度の外を押して断らせる。
    const layer = screen.getByTestId('add-input-layer');
    act(() => {
      fireEvent.pointerMove(layer, { clientX: 5, clientY: 5 });
    });
    act(() => {
      fireEvent.pointerDown(layer, { clientX: 0, clientY: 200, button: 0 });
    });
    expect(screen.getByTestId('option-bar-next-step')).toHaveTextContent('世界の外');
    // 予約が残っていれば、ここで走って理由を消してしまう。捨てているので消えない。
    act(() => {
      runFrames();
    });
    expect(screen.getByTestId('option-bar-next-step')).toHaveTextContent('世界の外');
  });
});

// --- 2 回目の手直し D1: 年が動く / 一覧で選び直す（設計書 §D.2）------------------
//
// どちらも作図の外側で起きる遷移で、打ちかけの下書きはその年・その選択のもとで打たれて
// いる。閾値は **確定できる点数** ―― それ以上なら聞き、それ未満なら報せて片付ける。

describe('U23 手直し 2 回目 D1: 年が動いたときの下書き', () => {
  it('確定できる点数まで打っていたら、年を動かす前に確認する（「続ける」で年も戻る）', () => {
    const h = mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5); // 3 点＝面は確定できる
    act(() => {
      h.store.getState().setCurrentTime(timePointYearMonthDay(1800, 1, 1), 'numericJump');
    });
    expect(screen.getByTestId('add-draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('add-draft-discard-confirm').textContent).toContain('年を動かす');
    // 「続ける」＝下書きを残し、**年も元へ戻す**（打った頂点はいまの年のものだから）。
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-no')));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    expect(h.store.getState().currentTime.year).toBe(1500);
    // **板は閉じたままである**（3 回目の手直し）。年を戻したこと自体を見張りが
    // 「新しい年の変化」と読むと板が開き直し、年が 1500 ⇄ 1800 を往復して
    // 「捨てる」以外に抜け道が無くなる（実測 r2d）。
    expect(screen.queryByTestId('add-draft-discard-confirm')).toBeNull();
  });

  it('「続ける」を何度繰り返しても板は開き直らない（年が往復しない）', () => {
    const h = mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        h.store.getState().setCurrentTime(timePointYearMonthDay(1800, 1, 1), 'numericJump');
      });
      expect(screen.getByTestId('add-draft-discard-confirm')).toBeInTheDocument();
      act(() => fireEvent.click(screen.getByTestId('add-draft-discard-no')));
      expect(screen.queryByTestId('add-draft-discard-confirm')).toBeNull();
      expect(h.store.getState().currentTime.year).toBe(1500);
    }
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
  });

  it('確定できる点数に届いていなければ、聞かずに捨てて報せる', () => {
    const discarded: number[] = [];
    const h = mountApp(undefined, { onDraftDiscarded: (n) => discarded.push(n) });
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0); // 2 点＝まだ確定できない
    act(() => {
      h.store.getState().setCurrentTime(timePointYearMonthDay(1800, 1, 1), 'numericJump');
    });
    expect(screen.queryByTestId('add-draft-discard-confirm')).toBeNull();
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
    expect(discarded).toEqual([2]);
    // 年は進んだまま（利用者がやりたかったのは年を動かすことである）。
    expect(h.store.getState().currentTime.year).toBe(1800);
  });
});

describe('U23 手直し 2 回目 D1: 一覧で別の地物を選んだときの下書き', () => {
  it('確定できる点数まで打っていたら確認し、捨てたら視点を合わせる', () => {
    const focused: number[] = [];
    const h = mountApp(undefined, { onFocusSelection: () => focused.push(1) });
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    act(() => {
      h.store.getState().setActiveFeature(asFeatureId('f-other'));
    });
    expect(screen.getByTestId('add-draft-discard-confirm').textContent).toContain('一覧で別の地物');
    expect(focused).toHaveLength(0); // まだ視点は動かさない
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-yes')));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
    expect(focused).toHaveLength(1); // 片付けてから合わせる
  });

  it('「続ける」で選択を戻したとき、板は閉じたままで選択も往復しない', () => {
    const h = mountApp();
    selectTool('tool-add.area');
    // **道具を構えたあとに別の地物を選んでおく**（道具を構えると選択は外れるので、
    // 先に選んでも消える。選択が null → A のときは「選択を外しただけ」の枝を通って
    // しまい、往復が起きない ―― 往復は「戻した先も実在する選択」のときに出る）。
    act(() => {
      h.store.getState().setActiveFeature(asFeatureId('f-first'));
    });
    clickMap(0, 0);
    clickMap(5, 0);
    clickMap(5, 5);
    act(() => {
      h.store.getState().setActiveFeature(asFeatureId('f-other'));
    });
    expect(screen.getByTestId('add-draft-discard-confirm')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-no')));
    // 年の経路と同じ理由（見張りが自分の後始末を新しい出来事と読まない）。
    expect(screen.queryByTestId('add-draft-discard-confirm')).toBeNull();
    expect(h.store.getState().activeFeature).toBe(asFeatureId('f-first'));
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
  });

  it('確定できる点数に届いていなければ、捨てて報せて、そのまま視点を合わせる', () => {
    const focused: number[] = [];
    const discarded: number[] = [];
    const h = mountApp(undefined, {
      onFocusSelection: () => focused.push(1),
      onDraftDiscarded: (n) => discarded.push(n),
    });
    selectTool('tool-add.area');
    clickMap(0, 0);
    act(() => {
      h.store.getState().setActiveFeature(asFeatureId('f-other'));
    });
    expect(screen.queryByTestId('add-draft-discard-confirm')).toBeNull();
    expect(discarded).toEqual([1]);
    expect(focused).toHaveLength(1);
  });
});

// ============================================================================
// A2 / A3: 素性入力の局面でも Escape が効く／道具の持ち替えと鍵で黙って捨てない
// ============================================================================
//
// 増分 5 の手直し A2・A3（バグ狩り #3 / 設計書 §D.4・§D.7）。
//
// **A2**: Escape のリスナーは `Drawing` の局面にしか居なかった。形を確定して名前を
// 打つ局面（`PropertyForm`）では **道具も大域も Escape を受けない** ―― 大域の側は
// 焦点が入力欄にあると `focus-guard` が降りるからである。押しても何も起きないので、
// §D.4 の「連打すれば必ず素の状態に戻る」が、いちばん抜けにくい局面で破れていた。
//
// **A3**: 道具を持ち替える・鍵を閉じる、のどちらでも、確定できる点数まで打った下書きが
// **黙って消えていた**。年や一覧の選択と同じ扱い（＝作図の外側で起きた遷移なので 1 度
// 聞く）にする。「このままにする」を選べば道具（と鍵）を元へ戻す。

/** 面を 3 点まで打つ（＝確定できる量の打ちかけ）。 */
function drawCompletableFace(): void {
  selectTool('tool-add.area');
  clickMap(0, 0);
  clickMap(5, 0);
  clickMap(5, 5);
  expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
}

/** 形を確定して素性入力の局面へ進む。 */
function completeIntoPropertyForm(): void {
  act(() => fireEvent.click(screen.getByTestId('add-complete')));
  expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
}

/** いま焦点のある要素から焦点を外す（欄の外で打鍵したい局面を作る）。 */
function blurActive(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement) el.blur();
}

describe('U23 手直し A2: 素性を入力している局面でも Escape が効く', () => {
  it('欄の外から押した Escape は、その場で「やめる」（板は出ない）', () => {
    // 形は確定済み・欄には何も打っていない局面。ここで形の確認をもう一度出すと、
    // 欄を空にしただけの利用者が抜けられなくなる（設計書 §D.4 の階段は 1 段ずつ）。
    mountApp();
    drawCompletableFace();
    completeIntoPropertyForm();
    blurActive(); // 名前欄の autoFocus を外す
    pressEscape();
    expect(confirmShown()).toBe(false);
    expect(currentPhase()).toBe(ADD_PHASE.Idle);
  });

  it('名前欄に焦点があっても道具が Escape を受ける（旧版は誰も受けなかった）', () => {
    mountApp();
    drawCompletableFace();
    completeIntoPropertyForm();
    // **何も起きない、にはならない**のがここの要点である。名前欄は空のまま
    // （`data-pristine="true"` を名乗る）なので、聞かずにそのまま「やめる」。
    pressEscape();
    expect(confirmShown()).toBe(false);
    expect(currentPhase()).toBe(ADD_PHASE.Idle);
  });

  it('名前を打ちかけたまま Escape を押すと 1 度聞く（打った文字を黙って失わない）', () => {
    // `data-pristine` が `"false"` になる ―― 欄が自分で「打ちかけがある」と名乗る。
    // 判定は素性欄と同じ 1 本の述語を読む（教訓 5.13）。
    mountApp();
    drawCompletableFace();
    completeIntoPropertyForm();
    const name = document.querySelector('[data-testid="add-name"]');
    if (!(name instanceof HTMLInputElement)) throw new Error('名前欄が無い');
    act(() => {
      fireEvent.change(name, { target: { value: 'アアウ' } });
    });
    name.focus();
    pressEscape();
    expect(confirmShown()).toBe(true);
  });

  it('Escape を連打すれば必ず素の状態へ戻る ―― 素性入力の局面（上限 5 回）', () => {
    mountApp();
    drawCompletableFace();
    completeIntoPropertyForm();
    let presses = 0;
    while (currentPhase() !== ADD_PHASE.Idle && presses < 5) {
      pressEscape();
      presses += 1;
    }
    expect({ phase: currentPhase(), confirm: confirmShown() }).toEqual({
      phase: ADD_PHASE.Idle,
      confirm: false,
    });
    expect(presses).toBeLessThanOrEqual(5);
  });

  it('Escape を連打すれば必ず素の状態へ戻る ―― 作図中（確定できる点数あり、上限 5 回）', () => {
    mountApp();
    drawCompletableFace();
    let presses = 0;
    while (screen.getByTestId('add-vertex-count').textContent !== '0' && presses < 5) {
      pressEscape();
      presses += 1;
    }
    expect({
      vertices: screen.getByTestId('add-vertex-count').textContent,
      confirm: confirmShown(),
    }).toEqual({ vertices: '0', confirm: false });
    expect(presses).toBeLessThanOrEqual(5);
  });

  it('自分の Escape で出した板は、Escape で捨てる（reason=escape だけの扱い）', () => {
    mountApp();
    drawCompletableFace();
    pressEscape();
    expect(confirmShown()).toBe(true);
    pressEscape();
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
  });

  it('年が動いて出た板は、従来どおり Escape ＝「このままにする」（年も戻る）', () => {
    // 外で起きたことを取り消すのが Escape の意味なので、こちらは「捨てる」にしない。
    // 自分の Escape で出した板（上の it）とは扱いが違う ―― 同じにすると、どちらかが
    // 必ず壊れる（片方は永久に戻れない／片方は打ちかけが消える）。
    const h = mountApp();
    drawCompletableFace();
    act(() => {
      h.store.getState().setCurrentTime(timePointYearMonthDay(1800, 1, 1), 'numericJump');
    });
    expect(confirmShown()).toBe(true);
    pressEscape();
    expect(confirmShown()).toBe(false);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3'); // 残る
    expect(h.store.getState().currentTime.year).toBe(1500); // 年も戻る
  });
});

describe('U23 手直し A3: 道具の持ち替えと鍵でも、黙って捨てない', () => {
  it('道具を持ち替えたら聞く。［このままにする］で道具が元へ戻る', () => {
    const h = mountApp();
    drawCompletableFace();
    act(() => fireEvent.click(screen.getByTestId('tool-edit.knife')));
    expect(confirmShown()).toBe(true);
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-no')));
    expect(confirmShown()).toBe(false);
    // 打ちかけは残り、道具も元（面）へ戻っている ―― 戻さないと「続ける」を選んだのに
    // 描き続けられない。
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    expect(h.store.getState().activeTool).toBe(TOOL_ID.AddArea);
  });

  it('道具の板は Escape でも「このままにする」（外で起きた遷移だから）', () => {
    const h = mountApp();
    drawCompletableFace();
    act(() => fireEvent.click(screen.getByTestId('tool-edit.knife')));
    expect(confirmShown()).toBe(true);
    pressEscape();
    expect(confirmShown()).toBe(false);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    expect(h.store.getState().activeTool).toBe(TOOL_ID.AddArea);
  });

  it('道具の板で［捨てる］を選べば、捨てた数を報せる', () => {
    const discarded: number[] = [];
    mountApp(undefined, { onDraftDiscarded: (n) => discarded.push(n) });
    drawCompletableFace();
    act(() => fireEvent.click(screen.getByTestId('tool-edit.knife')));
    expect(discarded).toEqual([]); // まだ捨てていないので何も言わない
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-yes')));
    expect(discarded).toEqual([3]);
  });

  it('鍵を閉じたら聞く。［このままにする］で鍵が開き直り、道具も戻る', () => {
    const h = mountApp();
    drawCompletableFace();
    act(() => {
      h.store.getState().setMode(EDIT_MODE.View); // 鍵を閉じる（シェルの鍵と同じ口）
    });
    expect(confirmShown()).toBe(true);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-no')));
    expect(h.store.getState().mode).toBe(EDIT_MODE.Add); // 面の道具が戻る＝導出は追加
    expect(h.store.getState().activeTool).toBe(TOOL_ID.AddArea);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
  });

  it('鍵を閉じている間、板の裏で地図クリックが効かない（K-6 の抜け道を塞ぐ）', () => {
    // 道具が外れているあいだ、地図を覆う入力層は出さない。出したままだと
    // **鍵を閉じたのに地図クリックで頂点が置ける**。
    const h = mountApp();
    drawCompletableFace();
    act(() => {
      h.store.getState().setMode(EDIT_MODE.View);
    });
    expect(confirmShown()).toBe(true);
    expect(screen.queryByTestId('add-input-layer')).toBeNull();
  });

  it('編集の道具へ移った板の裏でも、下書きは生きていて入力層も残る', () => {
    // **入力層を外すのは鍵を閉じたときだけ**である（実装したときに決めた。2026-09-06）。
    // 「道具を構えているか」で外すと、板が出ているあいだ `activeKind` が一時的に null に
    // なるので **確認に答えるまで地図が死ぬ** ―― 実データの探索で、面の道具が押されて
    // いるのに入力層がどこにも無い状態を踏んだ。板は `role="alertdialog"` の本物の
    // モーダルとして数えているので、打鍵は板のものである。
    mountApp();
    drawCompletableFace();
    act(() => fireEvent.click(screen.getByTestId('tool-edit.knife')));
    expect(confirmShown()).toBe(true);
    expect(screen.queryByTestId('add-input-layer')).not.toBeNull();
  });

  it('確定に届かない量なら、道具の持ち替えでも鍵でも聞かずに捨てる（押し直せば済む）', () => {
    const h = mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(5, 0);
    act(() => {
      h.store.getState().setMode(EDIT_MODE.View);
    });
    // 聞かずに捨てる＝板は出ず、打ちかけも残っていない（道具ごと降りている）。
    expect(confirmShown()).toBe(false);
    expect(screen.queryByTestId('add-tool')).toBeNull();
    expect(h.store.getState().mode).toBe(EDIT_MODE.View);
  });
});

describe('U23 手直し A4: 確認の板が出ているあいだは「ダイアログが出ている」と報せる', () => {
  it('板が開いたら true、閉じたら false を報せる（背後で保存や新規が走らない）', () => {
    const modal: boolean[] = [];
    mountApp(undefined, { onModalChange: (open) => modal.push(open) });
    drawCompletableFace();
    // 開くまでは false 以外を報せていない（初回の false は購読の初期通知）。
    expect(modal.includes(true)).toBe(false);
    pressEscape();
    expect(modal.at(-1)).toBe(true);
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-no')));
    expect(modal.at(-1)).toBe(false);
  });

  it('［捨てる］で閉じたときも false を報せる（閉じ方で報せ漏れが出ない）', () => {
    const modal: boolean[] = [];
    mountApp(undefined, { onModalChange: (open) => modal.push(open) });
    drawCompletableFace();
    pressEscape();
    expect(modal.at(-1)).toBe(true);
    act(() => fireEvent.click(screen.getByTestId('add-draft-discard-yes')));
    expect(modal.at(-1)).toBe(false);
  });

  it('Escape で捨てて閉じたときも false を報せる', () => {
    const modal: boolean[] = [];
    mountApp(undefined, { onModalChange: (open) => modal.push(open) });
    drawCompletableFace();
    pressEscape();
    expect(modal.at(-1)).toBe(true);
    pressEscape(); // reason=escape なので 2 回目は「捨てる」
    expect(modal.at(-1)).toBe(false);
  });
});
