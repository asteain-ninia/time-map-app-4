// FR-109 follow-up — the store's NARROW palette mirror (readDomainPalette) at the
// applyCommandResult / applyUndoRedoResult seams. A palette command writes the palette
// into the domain (root.uiSettings); the store reflects ONLY the two palette fields back
// into the live projectSettings so the settings dialog draft + the save-time overlay
// read the SAME palette the recolor engine used — WITHOUT clobbering any other field,
// and SYMMETRICALLY across commit / undo / redo (教訓 5.23).

import { describe, expect, it } from 'vitest';

import { EMPTY_COMMAND_RESULT } from '../../domain/command/index';

import { createSessionStore } from './store';
import { DEFAULT_PROJECT_SETTINGS, type PaletteSelection } from './settings';

/** An opaque test domain that carries an optional palette (like uiSettings.project). */
interface TestDomain {
  readonly tag: string;
  readonly palette?: PaletteSelection;
}

const P0: PaletteSelection = { defaultPaletteTheme: 'default', customPalette: [] };
const P1: PaletteSelection = { defaultPaletteTheme: 'ocean', customPalette: ['#112244', '#334466'] };

/** A store whose readDomainPalette reads the domain's optional palette (App's shape). */
function makeStore(initialDomain: TestDomain) {
  return createSessionStore<TestDomain>({
    initialDomain,
    domainEquals: (a, b) => a === b,
    readDomainPalette: (d) => d.palette,
    // Seed projectSettings with a non-default grid so a clobber of a NON-palette field
    // is observable, and palette P0.
    initial: {
      projectSettings: {
        ...DEFAULT_PROJECT_SETTINGS,
        gridSpacingDeg: 30,
        defaultPaletteTheme: P0.defaultPaletteTheme,
        customPalette: [...P0.customPalette],
      },
    },
  });
}

describe('applyCommandResult — mirrors a committed palette into projectSettings (FR-109)', () => {
  it('reflects the 2 palette fields and touches NOTHING else', () => {
    const store = makeStore({ tag: 'd0', palette: P0 });
    store.getState().applyCommandResult({ tag: 'd1', palette: P1 }, EMPTY_COMMAND_RESULT, undefined);

    const s = store.getState();
    expect(s.projectSettings.defaultPaletteTheme).toBe('ocean');
    expect(s.projectSettings.customPalette).toEqual(['#112244', '#334466']);
    // NON-palette fields are store-owned — never clobbered by the mirror.
    expect(s.projectSettings.gridSpacingDeg).toBe(30);
    expect(s.projectSettings.zoomMax).toBe(DEFAULT_PROJECT_SETTINGS.zoomMax);
    expect(s.projectDirty).toBe(true);
  });

  it('is inert for a NON-palette command (same palette ⇒ same projectSettings reference)', () => {
    const store = makeStore({ tag: 'd0', palette: P0 });
    const before = store.getState().projectSettings;
    // A structural edit that carries the SAME palette must not allocate a new settings obj.
    store.getState().applyCommandResult({ tag: 'd1', palette: P0 }, EMPTY_COMMAND_RESULT, undefined);
    expect(store.getState().projectSettings).toBe(before);
  });

  it('leaves the palette store-owned when the domain carries no palette (no uiSettings)', () => {
    const store = makeStore({ tag: 'd0', palette: P0 });
    const before = store.getState().projectSettings;
    store.getState().applyCommandResult({ tag: 'd1' }, EMPTY_COMMAND_RESULT, undefined); // no palette
    expect(store.getState().projectSettings).toBe(before); // untouched — never reset
  });
});

describe('applyUndoRedoResult — symmetric palette mirror + correct dirty (教訓 5.23)', () => {
  it('undo of a palette change reflects the restored palette AND reads clean at the saved baseline', () => {
    const store = makeStore({ tag: 'd0', palette: P0 });
    // Establish a saved baseline: domain d0 + the CURRENT (P0) settings are the saved ref.
    store.getState().reflectLoadedProject(
      { tag: 'd0', palette: P0 },
      { projectSettings: store.getState().projectSettings, appSettings: store.getState().appSettings },
    );
    expect(store.getState().projectDirty).toBe(false);
    const savedDomain = store.getState().domain;

    // Commit a palette change P0→P1 (applyCommandResult mirror + forced dirty).
    store.getState().applyCommandResult({ tag: 'd1', palette: P1 }, EMPTY_COMMAND_RESULT, undefined);
    expect(store.getState().projectSettings.defaultPaletteTheme).toBe('ocean');
    expect(store.getState().projectDirty).toBe(true);

    // Undo back to the saved domain/palette: the mirror restores P0 AND, because clean is
    // computed against the POST-mirror palette, projectDirty clears (not falsely dirty).
    store.getState().applyUndoRedoResult(savedDomain, EMPTY_COMMAND_RESULT, undefined);
    const s = store.getState();
    expect(s.projectSettings.defaultPaletteTheme).toBe('default');
    expect(s.projectSettings.customPalette).toEqual([]);
    expect(s.projectDirty).toBe(false); // back to saved state ⇒ clean

    // Redo forward to P1: dirty again, palette mirrored forward (symmetry).
    store.getState().applyUndoRedoResult({ tag: 'd1', palette: P1 }, EMPTY_COMMAND_RESULT, undefined);
    expect(store.getState().projectSettings.defaultPaletteTheme).toBe('ocean');
    expect(store.getState().projectDirty).toBe(true);
  });
});

describe('readDomainPalette omitted — mirror is skipped (honest absence)', () => {
  it('never touches projectSettings when no reader is injected', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0', palette: P0 },
      domainEquals: (a, b) => a === b,
      initial: {
        projectSettings: { ...DEFAULT_PROJECT_SETTINGS, customPalette: [...P0.customPalette] },
      },
    });
    const before = store.getState().projectSettings;
    store.getState().applyCommandResult({ tag: 'd1', palette: P1 }, EMPTY_COMMAND_RESULT, undefined);
    expect(store.getState().projectSettings).toBe(before); // reader absent ⇒ no mirror
  });
});
