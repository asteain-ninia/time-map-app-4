// FR-109 follow-up — end-to-end integration of the palette command through the SAME
// commit funnel App.tsx uses (maybeComposeAutoRecolor → history execute →
// applyCommandResult; undo/redo → applyUndoRedoResult), over a REAL DomainProject + a
// REAL session store. Proves the ユーザー裁定: a default-palette change auto-recolors
// IMMEDIATELY and reverts palette + colours in ONE undo unit, the store's projectSettings
// mirror stays in lock-step, an all-manual project short-circuits (no recolor), and a
// save round-trip persists both the palette and the recoloured fills.

import { describe, expect, it, vi } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo, type ColorInfo } from '../../domain/attributes';
import {
  createHistory,
  execute as historyExecute,
  undo as historyUndo,
  redo as historyRedo,
  type History,
} from '../../domain/command/history';
import * as adjacencyModule from '../../domain/coloring/adjacency-from-features';
import { createLeafFeature, type Feature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import {
  manifestToProject,
  projectsEqual,
  serialize,
  type DomainProject,
  type UiSettings,
} from '../../domain/persistence/index';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore } from '../../domain/vertex';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';

import { toPersistedUiSettings } from '../file-ops/ui-settings-bridge';
import { clearLiveLookupCache, featureByIdAt } from '../live-lookup';
import { createSessionStore, type SessionStore } from '../state/store';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS, type PaletteSelection } from '../state/settings';
import type { StoreApi } from 'zustand/vanilla';

import { createPaletteChangeCommand } from './palette-command';
import { maybeComposeAutoRecolor } from './recolor-binding';

const T = timePointYear(200);
const OCEAN: PaletteSelection = { defaultPaletteTheme: 'ocean', customPalette: ['#112244', '#334466'] };

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

function uiSettingsDefault(): UiSettings {
  return {
    project: { ...DEFAULT_PROJECT_SETTINGS, defaultPaletteTheme: 'default', customPalette: [] },
    app: { ...DEFAULT_APP_SETTINGS },
  };
}

function color(auto: boolean, fill: string): ColorInfo {
  return createColorInfo(auto, fill, fill, '#0d0d0d');
}

function leafHistoryAt(id: string, vids: string[], c: ColorInfo, time: TimePoint = T) {
  const ring = createTerritoryRing(asRingId(`r-${id}`), vids.map((v) => asVertexId(v)));
  const feature: Feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 0),
    c,
    createShape([ring]),
  );
  const store = createVertexStore(vids.map((v, i) => createVertex(asVertexId(v), { lon: i, lat: 0 })));
  const anchor = createAnchor(asAnchorId(`${id}@a`), createAnchorSnapshot([feature], store));
  return { featureId: feature.id, series: { entries: [createAnchorEntry(anchor, time, null)] } };
}

/** A single auto/manual leaf project with default-palette uiSettings. */
function rootWithLeaf(auto: boolean): DomainProject {
  return {
    histories: [leafHistoryAt('A', ['a1', 'a2', 'a3'], color(auto, '#000000'))],
    settings: SETTINGS,
    baseMap: BASEMAP,
    uiSettings: uiSettingsDefault(),
  };
}

/** Reconstruct App.tsx's recordCommand / undo-redo funnel over a live store + history. */
function makeFunnel(initialDomain: DomainProject) {
  const store: StoreApi<SessionStore<DomainProject>> = createSessionStore<DomainProject>({
    initialDomain,
    domainEquals: projectsEqual,
    readDomainPalette: (d) =>
      d.uiSettings === undefined
        ? undefined
        : {
            defaultPaletteTheme: d.uiSettings.project.defaultPaletteTheme,
            customPalette: d.uiSettings.project.customPalette,
          },
    initial: {
      currentTime: T,
      projectSettings: { ...DEFAULT_PROJECT_SETTINGS, defaultPaletteTheme: 'default', customPalette: [] },
    },
  });
  let history: History<DomainProject> = createHistory(store.getState().domain);

  const materialize = (): UiSettings =>
    toPersistedUiSettings({
      projectSettings: store.getState().projectSettings,
      appSettings: store.getState().appSettings,
    });

  const commitPalette = (palette: PaletteSelection): boolean => {
    const command = createPaletteChangeCommand(store.getState().domain, palette, materialize);
    if (command === null) return false;
    const wrapped = maybeComposeAutoRecolor(command, history.state, T);
    const step = historyExecute(history, wrapped);
    history = step.history;
    store.getState().applyCommandResult(step.history.state, step.result, undefined);
    return true;
  };
  const undo = (): void => {
    const step = historyUndo(history);
    if (step.history === history) return;
    history = step.history;
    store.getState().applyUndoRedoResult(step.history.state, step.result, undefined);
  };
  const redo = (): void => {
    const step = historyRedo(history);
    if (step.history === history) return;
    history = step.history;
    store.getState().applyUndoRedoResult(step.history.state, step.result, undefined);
  };
  return { store, commitPalette, undo, redo };
}

function fillOf(root: DomainProject, id: string): string {
  return featureByIdAt(root, T, asFeatureId(id))!.color.fillColor;
}

describe('palette change → immediate auto-recolor as ONE undo unit (ユーザー裁定)', () => {
  it('an autoColorEnabled leaf recolours to the NEW palette on a palette commit', () => {
    clearLiveLookupCache();
    const { store, commitPalette } = makeFunnel(rootWithLeaf(true));
    expect(fillOf(store.getState().domain, 'A')).toBe('#000000');

    expect(commitPalette(OCEAN)).toBe(true);

    // The leaf recoloured to ocean palette index 0 (isolated → first base colour)…
    expect(fillOf(store.getState().domain, 'A')).toBe('#112244');
    // …the domain's uiSettings palette changed…
    expect(store.getState().domain.uiSettings?.project.defaultPaletteTheme).toBe('ocean');
    // …and the store's projectSettings mirror moved in lock-step (dialog + save source).
    expect(store.getState().projectSettings.defaultPaletteTheme).toBe('ocean');
    expect(store.getState().projectSettings.customPalette).toEqual(['#112244', '#334466']);
    expect(store.getState().projectDirty).toBe(true);
  });

  it('a SINGLE undo reverts BOTH the palette and the recoloured fill; redo re-applies both', () => {
    clearLiveLookupCache();
    const { store, commitPalette, undo, redo } = makeFunnel(rootWithLeaf(true));
    commitPalette(OCEAN);
    expect(fillOf(store.getState().domain, 'A')).toBe('#112244');

    undo();
    // ONE Ctrl+Z: fill AND palette revert together (single composite undo unit).
    expect(fillOf(store.getState().domain, 'A')).toBe('#000000');
    expect(store.getState().domain.uiSettings?.project.defaultPaletteTheme).toBe('default');
    expect(store.getState().projectSettings.defaultPaletteTheme).toBe('default'); // mirror symmetric
    expect(store.getState().projectSettings.customPalette).toEqual([]);

    redo();
    expect(fillOf(store.getState().domain, 'A')).toBe('#112244');
    expect(store.getState().projectSettings.defaultPaletteTheme).toBe('ocean');
  });
});

describe('all-manual project — palette changes but nothing recolours (722 実データ短絡)', () => {
  it('never builds an adjacency graph; the fill is unchanged; the palette still persists', () => {
    clearLiveLookupCache();
    const { store, commitPalette } = makeFunnel(rootWithLeaf(false)); // autoColorEnabled=false
    const spy = vi.spyOn(adjacencyModule, 'buildAdjacencyFromLeaves');
    try {
      expect(commitPalette(OCEAN)).toBe(true);
      expect(spy).not.toHaveBeenCalled(); // perf gate: recolor short-circuited
    } finally {
      spy.mockRestore();
    }
    // Colour is untouched (all-manual)…
    expect(fillOf(store.getState().domain, 'A')).toBe('#000000');
    expect(featureByIdAt(store.getState().domain, T, asFeatureId('A'))!.color.autoColorEnabled).toBe(false);
    // …but the palette fields DID change (palette-only) and mirrored into the store.
    expect(store.getState().domain.uiSettings?.project.defaultPaletteTheme).toBe('ocean');
    expect(store.getState().projectSettings.defaultPaletteTheme).toBe('ocean');
  });
});

describe('save round-trip — palette + recoloured fills persist (STUDY item 4)', () => {
  it('the save-time store→root overlay agrees with the committed palette (no clobber)', () => {
    clearLiveLookupCache();
    const { store, commitPalette } = makeFunnel(rootWithLeaf(true));
    commitPalette(OCEAN);

    // The real save builds uiSettings from the LIVE store settings (toPersistedUiSettings).
    // Because the mirror kept store.projectSettings palette == root.uiSettings palette, the
    // overlay writes the SAME palette — it does not clobber the committed change.
    const s = store.getState();
    const domainToSave: DomainProject = {
      ...s.domain,
      uiSettings: toPersistedUiSettings({
        projectSettings: s.projectSettings,
        appSettings: s.appSettings,
      }),
    };
    const restored = manifestToProject(serialize(domainToSave));

    // Palette persisted…
    expect(restored.uiSettings?.project.defaultPaletteTheme).toBe('ocean');
    expect(restored.uiSettings?.project.customPalette).toEqual(['#112244', '#334466']);
    // …and the recoloured fill persisted (colours are saved, not recomputed on load).
    expect(fillOf(restored, 'A')).toBe('#112244');
    // Full structural round-trip identity holds.
    expect(projectsEqual(restored, domainToSave)).toBe(true);
  });
});
