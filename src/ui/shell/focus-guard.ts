// UI layer (U20 / shell): the keyboard focus-target guard (バグハント第10波 #1/#4).
//
// The global window-keydown dispatcher (useShortcuts) must STAND DOWN when a
// TEXT-EDITING element owns the focus — otherwise the domain shortcuts fire
// THROUGH native input editing: Delete/Backspace deletes the selected feature's
// anchors instead of a character (#1), and Ctrl+Z/Ctrl+Y invoke domain undo/redo
// instead of the browser's per-field text undo (#4), which preventDefault then
// blocks entirely. The `suspended` signal (App.tsx) only covers modals/tool-
// drawing; sidebar (BasicInfoForm) and timeline (YearMonthDayInput) inputs are
// live at all times, so the guard belongs at the SINGLE dispatch chokepoint
// (教訓 5.13: one shared gate, no per-input onKeyDown duplication).
//
// The predicate is a pure function over a minimal descriptor so it is unit-
// testable without a DOM (教訓 5.41); a tiny DOM reader extracts the descriptor
// from the key event, mirroring keyChordFromEvent in shortcuts.ts.

/**
 * The minimal shape the guard inspects, extracted from the focused element.
 * `inputType` is the lower/any-cased `<input type>` (or null for non-inputs /
 * an <input> with no explicit type, which defaults to text).
 */
export interface EditableTargetDescriptor {
  /** Upper-case tag name (`el.tagName`), e.g. 'INPUT', 'TEXTAREA', 'DIV'. */
  readonly tagName: string;
  /** The `<input type>` for INPUT elements, else null. */
  readonly inputType: string | null;
  /** Whether the element (or an ancestor) is contenteditable. */
  readonly isContentEditable: boolean;
}

/**
 * `<input type>` values that host free text the user edits with the same keys
 * our domain shortcuts bind (Delete/Backspace/Ctrl+Z/Ctrl+Y). A bare `<input>`
 * with no type defaults to text and is included via the null branch below.
 * Non-text inputs (range/checkbox/radio/button/color/…) do NOT edit text, so
 * they stay OUTSIDE this set — a Delete over a slider is not a native edit and
 * the shortcut still runs (受け入れ基準: 非テキスト input は従来通り).
 */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'search',
  'url',
  'email',
  'tel',
  'password',
]);

/**
 * True iff the focused target is a text-editing surface that must own the
 * keyboard: a text-family <input>, a <textarea>, a <select>, or any
 * contenteditable element. Pure — no DOM access — so it is unit-tested against a
 * descriptor. A null descriptor (no focus context) is NOT editable.
 */
export function isEditableTarget(target: EditableTargetDescriptor | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable) return true;
  switch (target.tagName) {
    case 'TEXTAREA':
    case 'SELECT':
      return true;
    case 'INPUT':
      // A bare <input> (no type) defaults to text and is editable; otherwise
      // only the text-family types are.
      return target.inputType === null || TEXT_INPUT_TYPES.has(target.inputType.toLowerCase());
    default:
      return false;
  }
}

/**
 * Read the focused editable descriptor from a key event. Prefers `e.target`
 * (the element that received the keydown); falls back to `document.activeElement`
 * when the event target is not an element (e.g. the event fired on window/document).
 * Returns null when no element context is available. Kept tiny and DOM-isolated so
 * the predicate above stays DOM-free and unit-testable (教訓 5.41).
 */
export function editableTargetFromEvent(e: KeyboardEvent): EditableTargetDescriptor | null {
  const raw =
    e.target instanceof Element
      ? e.target
      : typeof document !== 'undefined'
        ? document.activeElement
        : null;
  if (!(raw instanceof Element)) return null;
  const inputType =
    raw instanceof HTMLInputElement ? raw.getAttribute('type') : null;
  return {
    tagName: raw.tagName,
    inputType,
    isContentEditable: readContentEditable(raw),
  };
}

/**
 * Whether an element is content-editable. Prefers the resolved DOM property
 * (`isContentEditable`, which accounts for inherited `contenteditable=inherit`),
 * but falls back to the attribute (`contenteditable` = "" | "true" | "plaintext-only")
 * because some DOM environments (notably jsdom under vitest) do not implement the
 * resolved property. Either signal marks a text-editing surface.
 */
function readContentEditable(el: Element): boolean {
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const attr = el.getAttribute('contenteditable');
  if (attr === null) return false;
  const value = attr.toLowerCase();
  return value === '' || value === 'true' || value === 'plaintext-only';
}
