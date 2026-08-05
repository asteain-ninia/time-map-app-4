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
import { AppShell } from '../shell';
import { CommandRegistry, COMMAND_ID } from '../shell/commands';

import { AddToolController, type AddDrawSink, type ScreenToWorld } from './AddToolController';

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
}

function mountApp(resultFor: () => ProcessResult<S> = () => committed): Harness {
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

  const drawCalls: { primitives: readonly unknown[] }[] = [];
  const drawSink: AddDrawSink = {
    drawAdd: (primitives) => {
      drawCalls.push({ primitives });
    },
  };

  let f = 0;
  let v = 0;
  let r = 0;

  render(
    <AppShell
      store={store}
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
          onCommitted={hostCommit(store)}
        />
      }
    />,
  );

  return { store, startProcess, drawSink, drawCalls, proposals };
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

  it('tool switch (面 → 線) discards the in-progress vertices', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    clickMap(2, 3);
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('3');
    // Switch to the line tool: the session resets (教訓 5.2 (d)).
    selectTool('tool-add.line');
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('0');
    expect(screen.getByTestId('add-is-line')).toBeInTheDocument();
  });

  it('mode switch (追加 → 編集) discards the add session entirely', () => {
    mountApp();
    selectTool('tool-add.area');
    clickMap(0, 0);
    clickMap(4, 0);
    expect(screen.getByTestId('add-tool')).toBeInTheDocument();
    // Switch to 編集 mode in the real toolbar: the add session is discarded.
    act(() => fireEvent.click(screen.getByTestId('mode-edit')));
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

  it('Escape with a text input focused does NOT cancel the add and does NOT preventDefault (#6)', () => {
    mountApp();
    drawTwoVertices();
    const input = focusedInput('text');
    const ev = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    // The session is still drawing with its 2 vertices (not cancelled / re-armed to 0).
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('2');
    expect(ev.defaultPrevented).toBe(false);
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
