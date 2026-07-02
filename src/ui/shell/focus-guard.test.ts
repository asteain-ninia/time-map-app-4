// U20 pure-logic tests: the keyboard focus-target guard (バグハント第10波 #1/#4).
//
// A window-level keydown dispatcher must STAND DOWN when a text-editing element
// owns the focus — otherwise Delete/Backspace deletes the selected feature's
// anchors and Ctrl+Z/Ctrl+Y fire domain undo/redo instead of native input
// editing. `isEditableTarget` is the pure predicate; it is DOM-free (takes a
// minimal descriptor) so it is unit-tested without a document (教訓 5.41).

import { describe, expect, it } from 'vitest';

import { isEditableTarget, type EditableTargetDescriptor } from './focus-guard';

function target(over: Partial<EditableTargetDescriptor>): EditableTargetDescriptor {
  return { tagName: 'DIV', inputType: null, isContentEditable: false, ...over };
}

describe('isEditableTarget (focus guard for global shortcuts)', () => {
  it('treats a plain <input> (default text) as editable', () => {
    expect(isEditableTarget(target({ tagName: 'INPUT', inputType: null }))).toBe(true);
  });

  it('treats text-family <input> types as editable', () => {
    for (const inputType of ['text', 'number', 'search', 'url', 'email', 'tel', 'password']) {
      expect(isEditableTarget(target({ tagName: 'INPUT', inputType }))).toBe(true);
    }
  });

  it('is case-insensitive on the input type', () => {
    expect(isEditableTarget(target({ tagName: 'INPUT', inputType: 'TEXT' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'INPUT', inputType: 'Number' }))).toBe(true);
  });

  it('treats <textarea> and <select> as editable', () => {
    expect(isEditableTarget(target({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'SELECT' }))).toBe(true);
  });

  it('treats a contenteditable element as editable regardless of tag', () => {
    expect(isEditableTarget(target({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'SPAN', isContentEditable: true }))).toBe(true);
  });

  it('does NOT treat non-text <input> types as editable (range/checkbox/radio/button)', () => {
    for (const inputType of ['range', 'checkbox', 'radio', 'button', 'submit', 'color']) {
      expect(isEditableTarget(target({ tagName: 'INPUT', inputType }))).toBe(false);
    }
  });

  it('does NOT treat ordinary elements as editable', () => {
    expect(isEditableTarget(target({ tagName: 'DIV' }))).toBe(false);
    expect(isEditableTarget(target({ tagName: 'BUTTON' }))).toBe(false);
    expect(isEditableTarget(target({ tagName: 'BODY' }))).toBe(false);
  });

  it('treats a null / missing descriptor as NOT editable (no focus context)', () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});
