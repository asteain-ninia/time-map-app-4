// U20 — useShortcuts suspension contract (bughunt3).
//
// The global window-keydown shortcut dispatcher MUST stand down when something else
// owns the keyboard (a modal is open, or an Add/Knife tool is mid-drawing). The hook
// already has a `suspended` option; these tests lock that contract: while suspended
// it dispatches NOTHING and never preventDefaults, and it re-arms the moment the flag
// clears. This is the single mechanism that fixes BOTH H1 (undo through a modal) and
// H2 (Ctrl+Z double-fire during drawing) — proven robust against listener order
// because the global listener never runs at all while suspended (no reliance on
// stopImmediatePropagation in a later-registered handler).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useShortcuts } from './useShortcuts';
import { CommandRegistry, COMMAND_ID } from './commands';
import { buildDefaultKeymap } from './default-keymap';
import { EDIT_MODE } from '../state/session';

function makeRegistry(): { registry: CommandRegistry; run: ReturnType<typeof vi.fn> } {
  const registry = new CommandRegistry();
  const run = vi.fn();
  registry.register(COMMAND_ID.EditUndo, { run });
  return { registry, run };
}

function makeEditRegistry(): {
  registry: CommandRegistry;
  undo: ReturnType<typeof vi.fn>;
  redo: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const registry = new CommandRegistry();
  const undo = vi.fn();
  const redo = vi.fn();
  const del = vi.fn();
  registry.register(COMMAND_ID.EditUndo, { run: undo });
  registry.register(COMMAND_ID.EditRedo, { run: redo });
  registry.register(COMMAND_ID.EditDelete, { run: del });
  return { registry, undo, redo, del };
}

describe('useShortcuts suspension (bughunt3 — single source for H1/H2)', () => {
  it('dispatches Ctrl+Z (EditUndo) when NOT suspended and editable', () => {
    const { registry, run } = makeRegistry();
    renderHook(() =>
      useShortcuts({ keymap: buildDefaultKeymap(), registry, mode: EDIT_MODE.Edit }),
    );
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('dispatches NOTHING while suspended (modal open / tool drawing)', () => {
    const { registry, run } = makeRegistry();
    renderHook(() =>
      useShortcuts({
        keymap: buildDefaultKeymap(),
        registry,
        mode: EDIT_MODE.Edit,
        suspended: true,
      }),
    );
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('does NOT preventDefault a bound chord while suspended (event passes through)', () => {
    const { registry } = makeRegistry();
    renderHook(() =>
      useShortcuts({
        keymap: buildDefaultKeymap(),
        registry,
        mode: EDIT_MODE.Edit,
        suspended: true,
      }),
    );
    const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('re-arms when suspended flips back to false', () => {
    const { registry, run } = makeRegistry();
    const keymap = buildDefaultKeymap();
    const { rerender } = renderHook(
      ({ suspended }: { suspended: boolean }) =>
        useShortcuts({ keymap, registry, mode: EDIT_MODE.Edit, suspended }),
      { initialProps: { suspended: true } },
    );
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();

    rerender({ suspended: false });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('useShortcuts focus guard (バグハント第10波 #1 Delete / #4 Ctrl+Z through text input)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mountFocused(
    el: HTMLElement,
  ): { registry: CommandRegistry; undo: ReturnType<typeof vi.fn>; redo: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } {
    const parts = makeEditRegistry();
    document.body.appendChild(el);
    el.focus();
    renderHook(() =>
      useShortcuts({ keymap: buildDefaultKeymap(), registry: parts.registry, mode: EDIT_MODE.Edit }),
    );
    return parts;
  }

  it('does NOT dispatch EditDelete when a text <input> is focused (#1: anchors survive)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const { del } = mountFocused(input);
    fireEvent.keyDown(input, { key: 'Delete' });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(del).not.toHaveBeenCalled();
  });

  it('does NOT preventDefault Delete on a focused input (native edit passes through)', () => {
    const input = document.createElement('input');
    input.type = 'number';
    mountFocused(input);
    const ev = new KeyboardEvent('keydown', { key: 'Delete', cancelable: true, bubbles: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does NOT dispatch EditUndo / EditRedo when a text <input> is focused (#4)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const { undo, redo } = mountFocused(input);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'y', ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
  });

  it('does NOT preventDefault Ctrl+Z on a focused input (native undo passes through)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    mountFocused(input);
    const ev = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does NOT dispatch when a <textarea> is focused', () => {
    const ta = document.createElement('textarea');
    const { undo, del } = mountFocused(ta);
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'Delete' });
    expect(undo).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when a contenteditable element is focused', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.tabIndex = 0;
    const { undo, del } = mountFocused(div);
    fireEvent.keyDown(div, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(div, { key: 'Delete' });
    expect(undo).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  // --- 打ちかけの無い欄では、決めた少数の打鍵だけ通す（2026-09-06、2 回目の手直し）---
  //
  // 素性欄の Enter は「保存して次へ」なので、送ったあとの焦点は **次の地物の名前欄**に
  // 入ったままである。そこで Ctrl+Z を押しても「焦点が入力欄にある」というだけで止まり、
  // **押しても何も起きなかった**（実測）。220 件を順に片付ける流れの中で「取り消したければ
  // 焦点を外してから」と言うのは、作業の背骨（設計書 §E.1 の V5）を折る。
  it('打ちかけの無い欄（data-pristine="true"）では Ctrl+Z が大域へ通る', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-pristine', 'true');
    const { undo, redo } = mountFocused(input);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'y', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it('打ちかけがある欄（data-pristine="false"）では、いまも止める', () => {
    // 打った文字の取り消しが地物の取り消しに化けるのが、この guard を作った理由
    // （バグハント第 10 波 #4）である。名乗りが偽なら従来どおり止める。
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-pristine', 'false');
    const { undo } = mountFocused(input);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
  });

  it('打ちかけの無い欄でも、削除（Delete）は通さない（取り返しがつかない側）', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-pristine', 'true');
    const { del } = mountFocused(input);
    fireEvent.keyDown(input, { key: 'Delete' });
    expect(del).not.toHaveBeenCalled();
  });

  it('STILL dispatches from a non-editable focused element (button — no regression)', () => {
    const button = document.createElement('button');
    const { del } = mountFocused(button);
    fireEvent.keyDown(button, { key: 'Delete' });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('つまみ（range）に焦点があるあいだは大域の打鍵を通さない（増分 5 の手直し A4）', () => {
    // 設計書 §D.4 が明示していたのに実装から落ちていた（GPT #6）。つまみは矢印・
    // Home / End を自分で使う control で、深さ・不透明度・経度シフトを触っている
    // つもりで背後の地物が消えるのは事故である。**「文字を編集できるか」とは別の問い**
    // なので、述語も別にしてある（`blocksGlobalShortcuts`）。
    const slider = document.createElement('input');
    slider.type = 'range';
    const { del } = mountFocused(slider);
    fireEvent.keyDown(slider, { key: 'Delete' });
    expect(del).not.toHaveBeenCalled();
  });

  it('つまみからは Escape で抜けられる（出口を必ず 1 つ残す）', () => {
    const slider = document.createElement('input');
    slider.type = 'range';
    mountFocused(slider);
    slider.focus();
    expect(document.activeElement).toBe(slider);
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(document.activeElement).not.toBe(slider);
  });
});

// --- 増分 3 の手直し D4（GPT #10）: 文字を打っている最中でも保存だけは通す -------
//
// 焦点が名前欄にあるあいだ、シェルの割り振りは原則として何もしない（native の文字編集を
// 邪魔しないため）。ところが **保存だけは例外**にしないと、「形を描く → 名前を打つ →
// 保存」という流れの途中でだけ Ctrl+S が死ぬ。文字編集が使う打鍵とは重ならない。

describe('useShortcuts: 文字を打っている最中でも保存は通す（D4 / GPT #10）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mountWithSave(): { save: ReturnType<typeof vi.fn>; undo: ReturnType<typeof vi.fn>; input: HTMLInputElement } {
    const registry = new CommandRegistry();
    const save = vi.fn();
    const undo = vi.fn();
    registry.register(COMMAND_ID.FileSave, { run: save });
    registry.register(COMMAND_ID.EditUndo, { run: undo });
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    renderHook(() =>
      useShortcuts({ keymap: buildDefaultKeymap(), registry, mode: EDIT_MODE.Edit }),
    );
    return { save, undo, input };
  }

  it('名前欄に焦点があっても Ctrl+S はプロジェクト保存へ届く', () => {
    const { save, input } = mountWithSave();
    fireEvent.keyDown(input, { key: 's', ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('保存以外は今までどおり通さない（native の文字編集を邪魔しない）', () => {
    const { undo, input } = mountWithSave();
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
  });

  it('道具が鍵盤を持って止めているあいだは、通す集合に入っているときだけ届く', () => {
    const registry = new CommandRegistry();
    const save = vi.fn();
    registry.register(COMMAND_ID.FileSave, { run: save });
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    const { rerender } = renderHook(
      ({ allowed }: { allowed: ReadonlySet<typeof COMMAND_ID.FileSave> | undefined }) =>
        useShortcuts({
          keymap: buildDefaultKeymap(),
          registry,
          mode: EDIT_MODE.Edit,
          suspended: true,
          ...(allowed === undefined ? {} : { alwaysAllowed: allowed }),
        }),
      { initialProps: { allowed: undefined as ReadonlySet<typeof COMMAND_ID.FileSave> | undefined } },
    );
    fireEvent.keyDown(input, { key: 's', ctrlKey: true });
    expect(save).not.toHaveBeenCalled();

    rerender({ allowed: new Set([COMMAND_ID.FileSave]) });
    fireEvent.keyDown(input, { key: 's', ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('B64: 止めている間に通す取り消しは、押しっぱなしの続きでは走らない', () => {
    const registry = new CommandRegistry();
    const undo = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run: undo });
    renderHook(() =>
      useShortcuts({
        keymap: buildDefaultKeymap(),
        registry,
        mode: EDIT_MODE.Edit,
        suspended: true,
        alwaysAllowed: new Set([COMMAND_ID.EditUndo]),
      }),
    );
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, repeat: true });
    expect(undo).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
