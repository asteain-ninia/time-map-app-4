// UI layer (U20 / shell): keyboard shortcut registration, resolution, dispatch.
//
// Three separated stages (技術方針 5.5「ショートカット → コマンド ID → コマンド
// 実体の三段を分離」): a keymap (shortcut -> command id), the command registry
// (command id -> handler, commands.ts), and dispatch. This unit owns the keymap
// and the resolve/dispatch枠組み; later units register the handlers. The same
// enabled judgement used by menu items also gates shortcuts (教訓 5.13): an
// editing shortcut and its menu item disable TOGETHER — no path where the menu
// is greyed but the key still fires.

import { COMMAND_REFUSAL, CommandRegistry, type CommandId } from './commands';
import { isViewOnlyRefusal, resolveCommandEnabled } from './permissions';
import type { EditMode } from '../state/session';

/**
 * A platform-neutral shortcut. `ctrlOrMeta` matches Ctrl on Windows/Linux and
 * Cmd on macOS, so the keymap is declared once (教訓 5.19: no per-platform
 * literal branching). `key` is `KeyboardEvent.key` (case-insensitive for
 * letters; e.g. 'z', 's', 'Delete', '='); modifiers are explicit.
 */
export interface Shortcut {
  readonly key: string;
  readonly ctrlOrMeta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/**
 * Normalise a Shortcut to a canonical chord string used as the keymap lookup
 * key. Letters are lower-cased so 'Z' and 'z' chord identically; named keys
 * (Delete, ArrowLeft) keep their case. Modifier order is fixed for determinism.
 */
export function chordOf(s: Shortcut): string {
  const key = s.key.length === 1 ? s.key.toLowerCase() : s.key;
  const parts: string[] = [];
  if (s.ctrlOrMeta === true) parts.push('mod');
  if (s.alt === true) parts.push('alt');
  if (s.shift === true) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * HB-2 — platform解決. The keymap stays platform-neutral (`ctrlOrMeta`), but the
 * DISPLAYED accelerator must read in the user's OS idiom: "Ctrl" on Windows/Linux,
 * "⌘" on macOS (教訓 5.19: no per-platform literal branching IN the keymap — the
 * branch lives ONLY in the display formatter). `chordOf` produces the lookup chord
 * ("mod+s") and must NEVER be shown to the user; `formatShortcut` is the单一の
 * 表示整形 (§4 単一の真実源 for the human-facing label).
 */
export type Platform = 'mac' | 'other';

/**
 * Detect the renderer platform from the DOM. macOS reports "Mac" in
 * `navigator.platform` (and `userAgentData.platform === 'macOS'` on newer engines);
 * everything else (Windows, Linux) resolves to 'other' → "Ctrl". Kept tiny and DOM-
 * isolated so the rest of the module stays unit-testable (教訓 5.41); the pure
 * `formatShortcut(shortcut, platform)` takes the resolved value so tests need no DOM.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const uaPlatform = (
    navigator as unknown as { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  const probe = `${uaPlatform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /mac/i.test(probe) ? 'mac' : 'other';
}

/**
 * Per-platform label for each modifier / key part. The chord-key tokens
 * (lower-cased letters, named keys) are normalised back into a human label here.
 */
const KEY_DISPLAY: Readonly<Record<string, string>> = {
  '=': '+',
  // 空白は文字として見せると「何も書いていない」ようにしか読めない（増分 6）。
  ' ': 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
};

function displayKey(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_DISPLAY[lower] !== undefined) return KEY_DISPLAY[lower]!;
  // Single letters render upper-case ("S", not "s"); named keys keep their name.
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Format a Shortcut into the OS-idiomatic accelerator label shown in menus / the
 * shortcut help (HB-2 根本対応). `ctrlOrMeta` resolves to the PLATFORM key —
 * "Ctrl" on Windows/Linux, "⌘" on macOS — never the placeholder "Mod". The
 * dispatch-side key判定 (chordOf / Keymap) is untouched: only the displayed text
 * changes. Pure (platform is a parameter) so it is unit-tested without a DOM.
 */
export function formatShortcut(shortcut: Shortcut, platform: Platform): string {
  const mod = platform === 'mac' ? '⌘' : 'Ctrl';
  const sep = platform === 'mac' ? '' : '+';
  const parts: string[] = [];
  if (shortcut.ctrlOrMeta === true) parts.push(mod);
  if (shortcut.alt === true) parts.push(platform === 'mac' ? '⌥' : 'Alt');
  if (shortcut.shift === true) parts.push(platform === 'mac' ? '⇧' : 'Shift');
  parts.push(displayKey(shortcut.key));
  return parts.join(sep);
}

/** A minimal keyboard-event shape (so resolution is testable without the DOM). */
export interface KeyChord {
  readonly key: string;
  /** Either ctrlKey or metaKey was held. */
  readonly ctrlOrMeta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** Build a normalised chord string from a key event (or KeyChord). */
export function chordOfEvent(e: KeyChord): string {
  return chordOf({
    key: e.key,
    ctrlOrMeta: e.ctrlOrMeta,
    shift: e.shift,
    alt: e.alt,
  });
}

/**
 * Read a DOM KeyboardEvent into the neutral KeyChord shape (ctrlKey OR metaKey
 * collapse to `ctrlOrMeta`). Kept tiny so the rest of the module is DOM-free
 * and unit-testable (教訓 5.41).
 */
export function keyChordFromEvent(e: KeyboardEvent): KeyChord {
  return {
    key: e.key,
    ctrlOrMeta: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

/**
 * The keymap: chord string -> command id. Built from a Shortcut list. Last
 * binding for a chord wins (deterministic). This is the single source for
 * "which command does this key invoke" (§4 単一の真実源).
 */
export class Keymap {
  private readonly byChord = new Map<string, CommandId>();

  /** Bind a shortcut to a command id. */
  bind(shortcut: Shortcut, commandId: CommandId): void {
    this.byChord.set(chordOf(shortcut), commandId);
  }

  /** Resolve a chord (from a key event) to a command id, or undefined. */
  resolve(chord: KeyChord): CommandId | undefined {
    return this.byChord.get(chordOfEvent(chord));
  }
}

/**
 * Build the default keymap from a list of (shortcut, command) pairs — the SAME
 * pairs the menu declares (menu.ts), so accelerators and dispatch never drift
 * (教訓 5.33). Callers derive this from STANDARD_MENUS to keep one source.
 */
export function buildKeymap(
  bindings: readonly { readonly shortcut: Shortcut; readonly commandId: CommandId }[],
): Keymap {
  const map = new Keymap();
  for (const b of bindings) map.bind(b.shortcut, b.commandId);
  return map;
}

/** The result of dispatching a key chord. */
export const DISPATCH_RESULT = {
  /** No shortcut bound to this chord — let the event pass through. */
  Unbound: 'unbound',
  /** Bound, but the command is disabled (unregistered / gated) — consumed, no-op. */
  Disabled: 'disabled',
  /** Bound and ran. */
  Ran: 'ran',
} as const;

export type DispatchResult = (typeof DISPATCH_RESULT)[keyof typeof DISPATCH_RESULT];

/**
 * Resolve a key chord through the keymap, gate it through the SAME enabled
 * judgement menu items use (permissions.resolveCommandEnabled), and dispatch via
 * the command registry. An unregistered command's shortcut is a safe no-op
 * (Disabled), never an error (spec スコープ). An editing shortcut in view-only
 * mode is Disabled — the right-click / keyboard edit path is closed together
 * with the menu (教訓 5.13, 受け入れ基準 9).
 */
export function dispatchChord(
  chord: KeyChord,
  keymap: Keymap,
  registry: CommandRegistry,
  mode: EditMode,
): DispatchResult {
  const commandId = keymap.resolve(chord);
  if (commandId === undefined) return DISPATCH_RESULT.Unbound;

  const runnable = registry.isRunnable(commandId);
  const enabled = resolveCommandEnabled(commandId, { runnable, mode });
  if (!enabled) {
    // 鍵盤には「灰色の項目」が無いので、断ったこと自体が見えない。コマンドの
    // 持ち主が理由の口を出していれば、そこへ伝える（増分 2 の手直し A5 /
    // バグ狩り #2。可否の判定は増やさない — ここは結果を伝えるだけ）。
    //
    // **理由の優先順位は「読むだけ」が先**（増分 5 の手直し E3 / バグ狩り #14）。
    // 旧版は `runnable`（＝コマンド自身の `canRun`）を先に見ていたので、鍵を閉じた
    // ままの Ctrl+K が **「0 年にはすでに錨があります」**と答えた ―― 本当の理由は
    // 「読むだけだから」で、鍵を開ければ話が変わる。**利用者が次に打てる手が変わる
    // ほうの理由**を先に言う（設計書 §H.5「次の一手を見せる」）。
    registry.reportRefusal(
      commandId,
      isViewOnlyRefusal(commandId, mode) ? COMMAND_REFUSAL.ViewOnly : COMMAND_REFUSAL.NotRunnable,
    );
    return DISPATCH_RESULT.Disabled;
  }

  registry.dispatch(commandId);
  return DISPATCH_RESULT.Ran;
}
