// 地図に焦点があるときだけ効く打鍵（増分 8C の手直し / GPT #2。設計書 §I.2）と、押しっぱなしで
// 繰り返さない打鍵（反証 #5）。
//
// 固定すること:
//   - `U`（測る）は、焦点がどこにも無い・地図の区画・道具のレールにあるときだけ効く。
//   - 一覧・素性欄など、それ以外の区画に焦点があるときは効かず、打鍵も飲み込まない。
//   - 押しっぱなし（`repeat`）の 2 打目以降は走らない（切り替えの偶奇で状態が変わらない）。
//   - ほかの打鍵（Ctrl+Z など）は焦点の場所で止めない（従来どおり）。

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { COMMAND_ID, CommandRegistry } from './commands';
import { buildDefaultKeymap } from './default-keymap';
import { focusIsOnMap } from './map-focus-scope';
import { useShortcuts } from './useShortcuts';

afterEach(() => {
  document.body.innerHTML = '';
});

function setup() {
  const registry = new CommandRegistry();
  const survey = vi.fn();
  const undo = vi.fn();
  registry.register(COMMAND_ID.ToolsSurvey, { run: survey });
  registry.register(COMMAND_ID.EditUndo, { run: undo });
  renderHook(() =>
    useShortcuts({ keymap: buildDefaultKeymap(), registry, mode: EDIT_MODE.Edit }),
  );
  return { survey, undo };
}

/** 区画の中に焦点を持てるボタンを 1 つ置いて返す。 */
function focusableIn(className: string): HTMLButtonElement {
  const region = document.createElement('div');
  region.className = className;
  const button = document.createElement('button');
  region.appendChild(button);
  document.body.appendChild(region);
  return button;
}

describe('focusIsOnMap', () => {
  it('焦点がどこにも無い（本文・文書・null）は地図とみなす', () => {
    expect(focusIsOnMap(null)).toBe(true);
    expect(focusIsOnMap(document.body)).toBe(true);
    expect(focusIsOnMap(document.documentElement)).toBe(true);
  });

  it('地図の区画と道具のレールの中は地図とみなす。それ以外の区画は違う', () => {
    expect(focusIsOnMap(focusableIn('map-area'))).toBe(true);
    expect(focusIsOnMap(focusableIn('toolbar'))).toBe(true);
    expect(focusIsOnMap(focusableIn('unified-list'))).toBe(false);
    expect(focusIsOnMap(focusableIn('inspector'))).toBe(false);
  });
});

describe('useShortcuts — U は地図に焦点があるときだけ効く', () => {
  it('焦点が無ければ効く', () => {
    const { survey } = setup();
    fireEvent.keyDown(document.body, { key: 'u' });
    expect(survey).toHaveBeenCalledTimes(1);
  });

  it('地図の区画・道具のレールに焦点があれば効く', () => {
    const { survey } = setup();
    fireEvent.keyDown(focusableIn('map-area'), { key: 'u' });
    fireEvent.keyDown(focusableIn('toolbar'), { key: 'u' });
    expect(survey).toHaveBeenCalledTimes(2);
  });

  it('一覧の行などほかの区画に焦点があれば効かず、打鍵も飲み込まない', () => {
    const { survey } = setup();
    const row = focusableIn('unified-list');
    const ev = new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    expect(survey).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('ほかの打鍵（Ctrl+Z）は焦点の場所で止めない', () => {
    const { undo } = setup();
    fireEvent.keyDown(focusableIn('unified-list'), { key: 'z', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });
});

describe('useShortcuts — U の押しっぱなし（反証 #5）', () => {
  it('repeat の打鍵では走らない（最初の 1 打だけ）', () => {
    const { survey } = setup();
    fireEvent.keyDown(document.body, { key: 'u' });
    fireEvent.keyDown(document.body, { key: 'u', repeat: true });
    fireEvent.keyDown(document.body, { key: 'u', repeat: true });
    expect(survey).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z の押しっぱなしは従来どおり繰り返す', () => {
    const { undo } = setup();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, repeat: true });
    expect(undo).toHaveBeenCalledTimes(2);
  });
});
