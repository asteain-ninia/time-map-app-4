// U23 — LAYOUT regression for the add-tool map-input bridge (受け入れ基準 1 / 6 / 7,
// 教訓 5.14 / 5.29).
//
// WHY THIS EXISTS: the integration test (AddToolController.test.tsx) drives the
// flow in jsdom by dispatching pointer events DIRECTLY onto the bridge element. It
// never lays out the page, so it stays green even if the bridge has NO geometry and
// would, in the real Electron app, sit as a 0×0 block in the corner instead of over
// the map — a classic「テスト緑・実アプリ壊れ」gap. host-ports.screenToWorld converts
// pointer coords against the CANVAS rect, so the bridge MUST share that rect or
// "clicked here ≠ placed here" (教訓 5.29).
//
// This test pins the CSS contract that guarantees the alignment WITHOUT a browser:
// the add overlay mirrors the shell grid and the input bridge is placed on the SAME
// cell as the canvas. It fails if the .add-tool / .add-tool__input rules are removed
// or drift away from the shell's map cell — exactly the blocker that was filed.

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

describe('U23 add-input bridge layout contract (教訓 5.14 / 5.29)', () => {
  it('defines the .add-tool and .add-tool__input rules (the missing-CSS blocker)', () => {
    // The blocker filed: no CSS for .add-tool / .add-tool__input anywhere in src.
    expect(() => ruleBody('.add-tool')).not.toThrow();
    expect(() => ruleBody('.add-tool__input')).not.toThrow();
  });

  it('.add-tool overlays the shell and mirrors the shell map-cell grid exactly', () => {
    const addTool = ruleBody('.add-tool');
    const shell = ruleBody('.app-shell');
    const main = ruleBody('.app-shell__main');

    // It must fill the overlay (which is inset:0 over the whole shell).
    expect(decl(addTool, 'position')).toBe('absolute');
    expect(decl(addTool, 'inset')).toBe('0');
    expect(decl(addTool, 'display')).toBe('grid');

    // The map cell's box = shell ROW geometry × main-row COLUMN geometry. The add
    // overlay must reproduce BOTH or the "map cell" won't coincide with
    // .app-shell__map (and therefore the canvas) — 教訓 5.29.
    expect(decl(addTool, 'grid-template-rows')).toBe(decl(shell, 'grid-template-rows'));
    expect(decl(addTool, 'grid-template-columns')).toBe(decl(main, 'grid-template-columns'));

    // The scaffold itself is transparent to input; only its children take events.
    expect(decl(addTool, 'pointer-events')).toBe('none');
  });

  it('.add-tool__input sits on the SAME grid cell as .app-shell__map and takes input', () => {
    const input = ruleBody('.add-tool__input');
    const map = ruleBody('.app-shell__map');

    // .app-shell__map is grid-column 2 (the fluid central map column), grid-row 2
    // (the main row). The bridge MUST occupy the identical cell so its client rect
    // equals the canvas rect to the pixel.
    expect(decl(map, 'grid-column')).toBe('2');
    expect(decl(input, 'grid-column')).toBe('2');
    expect(decl(input, 'grid-row')).toBe('2');

    // It must actually receive pointer events (placeAt / preview), and not let the
    // browser swallow drawing strokes as pan/zoom gestures.
    expect(decl(input, 'pointer-events')).toBe('auto');
    expect(decl(input, 'touch-action')).toBe('none');
  });

  it('the shell map cell is the fluid central column (origin shared with the canvas)', () => {
    // Guards the precondition the bridge relies on: the map cell is column 2 of the
    // main row, and host-ports converts against the canvas inside that cell.
    const main = ruleBody('.app-shell__main');
    expect(decl(main, 'grid-template-columns')).toContain('1fr');
  });
});
