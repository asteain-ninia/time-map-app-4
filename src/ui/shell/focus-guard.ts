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
  /**
   * 「この欄はまだ何も打ちかけていない」と欄が自分で名乗っているか
   * （`data-pristine="true"`。2026-09-06、2 回目の手直し）。
   *
   * **なぜ要るか**: 素性欄の Enter は「保存して次へ」なので、送ったあとは **次の地物の
   * 名前欄に焦点が入ったまま**になる。ここで Ctrl+Z を押しても、焦点が入力欄にある
   * というだけで大域の取り消しが止まり、**押しても何も起きない**（実測。Alt+↑/↓ の
   * 送りも同じ）。焦点を外してから押す、では作業の流れが切れる。
   *
   * ただし「打ちかけがあるのに大域へ通す」のは駄目である（打った文字の取り消しが
   * 地物の取り消しに化ける ＝ この guard を作った理由そのもの）。そこで **欄の側が
   * 「いま打ちかけは無い」と名乗っているときだけ**、決めた少数の打鍵を通す。
   */
  readonly pristine: boolean;
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
 * **文字は打たないが、大域の割り振りを止めなければならない control**（増分 5 の手直し
 * A4 / GPT #6。設計書 §D.4 が明示していたのに実装から落ちていた）。
 *
 * つまみ（`input[type=range]`）は矢印・Home / End・PageUp / PageDown を **自分で使う**。
 * 文字は打たないので {@link isEditableTarget} には入らないが、焦点がそこにある間に
 * Delete や Ctrl+Z が大域へ抜けると、**深さ・不透明度・経度シフトのつまみを触っている
 * つもりで背後の地物が消える**。
 *
 * **「文字を編集できるか」と「大域の打鍵を遮るか」は別の問い**である（教訓 5.30: 制約が
 * 違うものを同じ述語で決めない）。前者は native の文字編集を邪魔しないための問いで、
 * 後者は「この control が鍵盤を使っているか」の問いである。
 */
const SHORTCUT_BLOCKING_INPUT_TYPES: ReadonlySet<string> = new Set(['range']);

/**
 * True iff the focused target must own the keyboard for the GLOBAL shortcut
 * dispatcher's purposes: every text-editing surface ({@link isEditableTarget}) plus the
 * non-text controls that consume the same keys ({@link SHORTCUT_BLOCKING_INPUT_TYPES}).
 * Pure — unit-tested against a descriptor.
 */
export function blocksGlobalShortcuts(target: EditableTargetDescriptor | null): boolean {
  if (target === null) return false;
  if (isEditableTarget(target)) return true;
  if (target.tagName !== 'INPUT') return false;
  return (
    target.inputType !== null &&
    SHORTCUT_BLOCKING_INPUT_TYPES.has(target.inputType.toLowerCase())
  );
}

/**
 * **空白キーを native に食う control**（増分 6。設計書 §I.2 の `Space` ＝ 再生／一時停止）。
 *
 * ボタンやリンク・チェックボックスは、焦点があるあいだ空白キーで **自分が押される**。
 * そこへ大域の「再生／一時停止」を重ねると、**1 回の空白で 2 つ起きる**（ボタンが押され、
 * ついでに再生が始まる）。文字を打つわけではないので {@link blocksGlobalShortcuts} には
 * 入らず、かといって全部の打鍵を止めるのも行き過ぎである ―― **空白のときだけ**見る。
 *
 * 判定は打鍵の入口 1 か所（`useShortcuts`）から呼ぶ（教訓 5.75: 打鍵ごとの分岐の中に
 * 書かない）。
 */
const SPACE_ACTIVATED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'file',
  'color',
]);

export function consumesSpaceNatively(target: EditableTargetDescriptor | null): boolean {
  if (target === null) return false;
  switch (target.tagName) {
    case 'BUTTON':
    case 'A':
    case 'SUMMARY':
      return true;
    case 'INPUT':
      return (
        target.inputType !== null &&
        SPACE_ACTIVATED_INPUT_TYPES.has(target.inputType.toLowerCase())
      );
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
    pristine: raw.getAttribute('data-pristine') === 'true',
  };
}

/**
 * DOM の要素そのものが「文字を打つ欄」かどうか（上の述語の DOM 側の入口）。
 *
 * 一覧の器のように **中の入力欄から浮き上がってくる鍵盤**を自分で処理する場所が、
 * 「いま打っているのか」を同じ 1 本の規則で判定するために使う（教訓 5.13: 同じ判断は
 * 1 か所に置き、`tagName === 'INPUT'` のような写しを増やさない）。
 */
export function isTextEntryElement(el: Element): boolean {
  const inputType = el instanceof HTMLInputElement ? el.getAttribute('type') : null;
  return isEditableTarget({
    tagName: el.tagName,
    inputType,
    isContentEditable: readContentEditable(el),
    pristine: false,
  });
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
