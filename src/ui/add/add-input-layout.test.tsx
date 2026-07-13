// U23 — LAYOUT regression for the add-tool map-input bridge (受け入れ基準 1 / 6 / 7,
// 教訓 5.14 / 5.29).
//
// WHY THIS EXISTS: the integration test (AddToolController.test.tsx) drives the
// flow in jsdom by dispatching pointer events DIRECTLY onto the bridge element. It
// never lays out the page, so it stays green even if the bridge has NO geometry —
// a classic「テスト緑・実アプリ壊れ」gap. host-ports.screenToWorld converts pointer
// coords against the CANVAS rect, so the bridge MUST share that rect or
// "clicked here ≠ placed here" (教訓 5.29).
//
// THE CONTRACT (第6工程 map-anchored design): the add-tool scaffold is mounted
// through AppShell's `mapOverlay` slot INSIDE the real map cell (.map-area__overlay,
// inset:0 of .app-shell__map). The scaffold and its input bridge are `inset:0`, so
// the bridge inherits the canvas box BY CONSTRUCTION.
//
// The PREVIOUS contract (a full-shell overlay grid that MIRRORED the shell's
// rows/columns) was structurally broken and is deliberately LOCKED OUT here: the
// mirror's empty `auto` rows collapse to 0, so the "map cell" spanned the whole
// shell height — the transparent bridge covered the 上部バー band (stealing the
// 階層深度 button clicks, depth-control e2e) and the timeline band (実測 y=0..800
// vs map 32..569). This test now FAILS if anyone reintroduces a grid mirror on the
// scaffold or drops the map-anchored inset contract.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const shellCss = readFileSync(resolve(here, '../shell/shell.css'), 'utf8');

/** Extract the body `{ ... }` of the FIRST rule whose selector exactly matches. */
function ruleBody(selector: string): string {
  // Escape regex metacharacters in the selector, then match `selector { body }`.
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(shellCss);
  if (m === null) throw new Error(`CSS rule not found: ${selector}`);
  return m[1] ?? '';
}

/** Read a `prop: value;` declaration from a rule body (normalised whitespace). */
function decl(body: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`, 'm');
  const m = re.exec(body);
  return m ? m[1]?.replace(/\s+/g, ' ').trim() : undefined;
}

describe('U23 add-input bridge layout contract (教訓 5.14 / 5.29, 第6工程 map-anchored)', () => {
  it('defines the .add-tool and .add-tool__input rules (the missing-CSS blocker)', () => {
    expect(() => ruleBody('.add-tool')).not.toThrow();
    expect(() => ruleBody('.add-tool__input')).not.toThrow();
  });

  it('.add-tool is a map-anchored inset:0 scaffold — NEVER a shell-grid mirror', () => {
    const addTool = ruleBody('.add-tool');

    // Fills its mount (.map-area__overlay, which is inset:0 of the map cell).
    expect(decl(addTool, 'position')).toBe('absolute');
    expect(decl(addTool, 'inset')).toBe('0');

    // The broken mirror-grid design is locked OUT: a display:grid scaffold with
    // shell-mirroring templates put the bridge over the 上部バー / timeline bands
    // (empty auto rows collapse to 0 — the depth-control interception root).
    expect(decl(addTool, 'display')).toBeUndefined();
    expect(decl(addTool, 'grid-template-rows')).toBeUndefined();
    expect(decl(addTool, 'grid-template-columns')).toBeUndefined();

    // The scaffold itself is transparent to input; only its children take events.
    expect(decl(addTool, 'pointer-events')).toBe('none');
  });

  it('.add-tool__input fills the scaffold (inset:0) and takes input', () => {
    const input = ruleBody('.add-tool__input');
    expect(decl(input, 'position')).toBe('absolute');
    expect(decl(input, 'inset')).toBe('0');
    expect(decl(input, 'grid-row')).toBeUndefined();
    expect(decl(input, 'grid-column')).toBeUndefined();

    // It must actually receive pointer events (placeAt / preview), and not let the
    // browser swallow drawing strokes as pan/zoom gestures.
    expect(decl(input, 'pointer-events')).toBe('auto');
    expect(decl(input, 'touch-action')).toBe('none');
  });

  it('the map-anchored mount exists and the scaffold stays pass-through inside it', () => {
    // .map-area__overlay is the map-cell-scoped mount (inset:0 of .map-area).
    const overlay = ruleBody('.map-area__overlay');
    expect(decl(overlay, 'position')).toBe('absolute');
    expect(decl(overlay, 'inset')).toBe('0');

    // The generic `.map-area__overlay > *` opt-in re-enables pointer events on every
    // overlay child; the TOOL SCAFFOLD exception must win over it, or the transparent
    // scaffold becomes a click shield over the whole map (教訓 5.14).
    const exception =
      /\.map-area__overlay\s*>\s*\.add-tool[^{]*\{[^}]*pointer-events:\s*none/m;
    expect(exception.test(shellCss)).toBe(true);
  });
});
