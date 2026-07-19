// FR-109 follow-up — createPaletteChangeCommand tests (ユーザー裁定: パレット変更は
// undoable な 1 コマンド). A default-palette change (defaultPaletteTheme /
// customPalette) is a whole-state-swap Command<DomainRoot> that writes ONLY the two
// palette fields of root.uiSettings.project, so recordCommand's maybeComposeAutoRecolor
// sees a PaletteTransition and rides the auto-recolor in the SAME undo unit. Driven as
// a pure unit (no store / no App): the root + palette + materialize fallback are passed.

import { describe, expect, it } from 'vitest';

import { isCompositeCommand } from '../../domain/command/command';
import type { DomainProject, UiSettings } from '../../domain/persistence/index';
import { createGeoParams } from '../../domain/geo/geo-params';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS } from '../state/settings';

import { createPaletteChangeCommand } from './palette-command';

const SETTINGS = {
  calendarId: 'gregorian' as const,
  geo: createGeoParams(40000, 0.0034),
  gridSpacingDeg: 10,
  snapDistancePx: 50,
  autoColorDefault: true,
};
const BASEMAP = {
  source: 's',
  meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
};

function uiSettingsWith(theme: string, palette: string[]): UiSettings {
  return {
    project: { ...DEFAULT_PROJECT_SETTINGS, defaultPaletteTheme: theme, customPalette: palette },
    app: { ...DEFAULT_APP_SETTINGS },
  };
}

function rootWith(uiSettings?: UiSettings): DomainProject {
  return uiSettings === undefined
    ? { histories: [], settings: SETTINGS, baseMap: BASEMAP }
    : { histories: [], settings: SETTINGS, baseMap: BASEMAP, uiSettings };
}

/** The materialize fallback App injects (toPersistedUiSettings of the live store). */
const materialize = (): UiSettings => uiSettingsWith('default', []);

describe('createPaletteChangeCommand — writes the 2 palette fields as a swap (FR-109)', () => {
  it('overwrites defaultPaletteTheme + customPalette in root.uiSettings.project only', () => {
    const root = rootWith(uiSettingsWith('default', ['#111111']));
    const cmd = createPaletteChangeCommand(
      root,
      { defaultPaletteTheme: 'ocean', customPalette: ['#112244', '#334466'] },
      materialize,
    );
    expect(cmd).not.toBeNull();
    const next = cmd!.execute(root).state;
    expect(next.uiSettings?.project.defaultPaletteTheme).toBe('ocean');
    expect(next.uiSettings?.project.customPalette).toEqual(['#112244', '#334466']);
    // Only the palette moved: histories / settings / baseMap / app survive by identity.
    expect(next.histories).toBe(root.histories);
    expect(next.settings).toBe(root.settings);
    expect(next.baseMap).toBe(root.baseMap);
    expect(next.uiSettings?.app).toEqual(root.uiSettings?.app);
    // …and every NON-palette uiSettings.project field is carried unchanged.
    expect(next.uiSettings?.project.gridSpacingDeg).toBe(
      root.uiSettings?.project.gridSpacingDeg,
    );
    expect(next.uiSettings?.project.zoomMax).toBe(root.uiSettings?.project.zoomMax);
  });

  it('is a single undo unit: execute→finalState, undo→baseline, redo→finalState', () => {
    const root = rootWith(uiSettingsWith('default', []));
    const cmd = createPaletteChangeCommand(
      root,
      { defaultPaletteTheme: 'ocean', customPalette: ['#abcdef'] },
      materialize,
    )!;
    expect(isCompositeCommand(cmd)).toBe(true);
    const exec = cmd.execute(root);
    expect(exec.state.uiSettings?.project.defaultPaletteTheme).toBe('ocean');
    const undo = cmd.undo(exec.state);
    expect(undo.state).toBe(root); // baseline restored by identity (whole-state swap)
    const redo = cmd.redo(undo.state);
    expect(redo.state.uiSettings?.project.customPalette).toEqual(['#abcdef']);
  });

  it('materializes uiSettings on BOTH sides when the root has none (pre-ui project) — F2', () => {
    const root = rootWith(); // no uiSettings (pre-ui manifest)
    const cmd = createPaletteChangeCommand(
      root,
      { defaultPaletteTheme: 'ocean', customPalette: ['#010203'] },
      () => uiSettingsWith('default', []), // OLD palette = default/[]
    );
    expect(cmd).not.toBeNull();
    const next = cmd!.execute(root).state;
    // The finalState CARRIES a materialized uiSettings with the NEW palette…
    expect(next.uiSettings).toBeDefined();
    expect(next.uiSettings?.project.defaultPaletteTheme).toBe('ocean');
    expect(next.uiSettings?.project.customPalette).toEqual(['#010203']);
    // …AND (F2 fix) undo restores a MATERIALISED baseline carrying the UNCHANGED
    // (pre-change) palette — NOT the uiSettings-less root. Only then does the store
    // mirror (readDomainPalette) reflect the OLD palette back on undo; otherwise the
    // mirror skips (undefined) and a save after undo persists the UNDONE palette.
    const undoState = cmd!.undo(next).state;
    expect(undoState.uiSettings).toBeDefined();
    expect(undoState.uiSettings?.project.defaultPaletteTheme).toBe('default');
    expect(undoState.uiSettings?.project.customPalette).toEqual([]);
    // The non-uiSettings fields still round-trip by identity through the baseline.
    expect(undoState.histories).toBe(root.histories);
    expect(undoState.settings).toBe(root.settings);
  });

  it('no-op guard: returns null when the palette is unchanged (present uiSettings)', () => {
    const root = rootWith(uiSettingsWith('ocean', ['#112244']));
    const cmd = createPaletteChangeCommand(
      root,
      { defaultPaletteTheme: 'ocean', customPalette: ['#112244'] },
      materialize,
    );
    expect(cmd).toBeNull();
  });

  it('no-op guard: returns null when the materialized fallback already equals the palette', () => {
    const root = rootWith(); // no uiSettings → compares against the materialized fallback
    const cmd = createPaletteChangeCommand(
      root,
      { defaultPaletteTheme: 'default', customPalette: [] },
      () => uiSettingsWith('default', []),
    );
    expect(cmd).toBeNull();
  });

  it('detects a customPalette length / element change (deep compare, not identity)', () => {
    const root = rootWith(uiSettingsWith('default', ['#111111', '#222222']));
    const same = createPaletteChangeCommand(
      root,
      { defaultPaletteTheme: 'default', customPalette: ['#111111', '#222222'] },
      materialize,
    );
    expect(same).toBeNull(); // value-equal → no-op
    const changed = createPaletteChangeCommand(
      root,
      { defaultPaletteTheme: 'default', customPalette: ['#111111', '#333333'] },
      materialize,
    );
    expect(changed).not.toBeNull(); // one element differs → command
  });
});
