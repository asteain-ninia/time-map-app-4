// U33 recolor-binding tests (FR-100 / FR-101 / 教訓 5.6 / 5.20): the store/App-
// INDEPENDENT wiring that turns a committed structural Command<DomainRoot> into
// "structure + auto-recolor as ONE undo unit". Driven purely as a unit (no store,
// no App): the commit anchor time and roots are passed in.
//
// These fix the integration must-includes:
//   (palette)   paletteFromRoot reads uiSettings.project (NOT root.settings) with a
//               DEFAULT_PALETTE fallback when uiSettings is absent (critique HIGH).
//   (withColor) the port spreads {...root} so uiSettings/settings/baseMap survive a
//               recolor write, writes from the anchor time (T-1 untouched), and is a
//               safe no-op when the feature is not effective (not-found branch).
//   (short-cut) an all-manual project never builds an adjacency graph (spy = perf
//               gate); an unchanged-adjacency commit adds no recolor unit.
//   (determinism) same operation + same palette → identical colours; undo restores
//               the baseline; redo replays the same colours (no re-mint).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, type AnchorSeries } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo, type ColorInfo } from '../../domain/attributes';
import {
  isCompositeCommand,
  defineCommandKind,
  type Command,
} from '../../domain/command/command';
import { createCommandResult } from '../../domain/command/result';
import { DEFAULT_BASE_COLORS, DEFAULT_PALETTE } from '../../domain/coloring';
import * as adjacencyModule from '../../domain/coloring/adjacency-from-features';
import {
  createLeafFeature,
  createLineFeature,
  type Feature,
  type LeafFeature,
} from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type {
  DomainProject,
  FeatureHistory,
  ProjectSettings,
  UiSettings,
} from '../../domain/persistence/index';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';
import { createVertex, createVertexStore, type VertexStore } from '../../domain/vertex';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS } from '../state/settings';

import { clearLiveLookupCache, featureByIdAt } from '../live-lookup';
import {
  domainRootColorPort,
  maybeComposeAutoRecolor,
  paletteFromRoot,
} from './recolor-binding';

const T = timePointYear(200);
const T_MINUS = timePointYear(100);
const calendar = getCalendar('gregorian');

const SETTINGS: ProjectSettings = {
  calendarId: 'gregorian',
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

function rootWith(histories: FeatureHistory[], uiSettings?: UiSettings): DomainProject {
  return uiSettings === undefined
    ? { histories, settings: SETTINGS, baseMap: BASEMAP }
    : { histories, settings: SETTINGS, baseMap: BASEMAP, uiSettings };
}

/** ColorInfo with fill == selected == `fill` so a recolor is observable on either. */
function color(auto: boolean, fill: string): ColorInfo {
  return createColorInfo(auto, fill, fill, '#0d0d0d');
}

function storeOf(vids: string[]): VertexStore {
  return createVertexStore(vids.map((v, i) => createVertex(asVertexId(v), { lon: i, lat: 0 })));
}

function leafFeature(id: string, vids: string[], c: ColorInfo): LeafFeature {
  const ring = createTerritoryRing(asRingId(`r-${id}`), vids.map((v) => asVertexId(v)));
  return createLeafFeature(asFeatureId(id), createBasicAttributes(id, 0, 0), c, createShape([ring]));
}

/** One feature in its own single-anchor history at time `T`. */
function historyAt(feature: Feature, vids: string[], time: TimePoint = T): FeatureHistory {
  const anchor = createAnchor(
    asAnchorId(`${feature.id}@a`),
    createAnchorSnapshot([feature], storeOf(vids)),
  );
  return { featureId: feature.id, series: { entries: [createAnchorEntry(anchor, time, null)] } };
}

/** A whole-state-swap structural command (mirrors the live makeCommand shape). */
function swapCommand(baseline: DomainProject, finalState: DomainProject): Command<DomainProject> {
  const result = createCommandResult({ survived: [] });
  const swapTo = (state: DomainProject): { state: DomainProject; result: typeof result } => {
    void state;
    return { state: finalState, result };
  };
  return {
    kind: defineCommandKind('test-swap'),
    label: 'swap',
    execute: swapTo,
    redo: swapTo,
    undo: (state: DomainProject) => {
      void state;
      return { state: baseline, result };
    },
  };
}

function fillOf(root: DomainProject, id: string, time: TimePoint = T): string {
  return featureByIdAt(root, time, asFeatureId(id))!.color.fillColor;
}

beforeEach(() => {
  clearLiveLookupCache();
});

// ---------------------------------------------------------------------------
// paletteFromRoot — palette source (critique HIGH)
// ---------------------------------------------------------------------------

describe('paletteFromRoot — reads uiSettings.project, not root.settings (critique HIGH)', () => {
  it('falls back to DEFAULT_PALETTE when uiSettings is absent (new / pre-ui project)', () => {
    const root = rootWith([]);
    expect(paletteFromRoot(root)).toEqual(DEFAULT_PALETTE);
  });

  it('uses the uiSettings.project custom palette + theme when present', () => {
    const root = rootWith([], uiSettingsWith('ocean', ['#112244', '#334466']));
    const palette = paletteFromRoot(root);
    expect(palette.theme).toBe('ocean');
    expect(palette.baseColors).toEqual(['#112244', '#334466']);
  });

  it('falls back to the default base colours when the custom palette is empty', () => {
    const root = rootWith([], uiSettingsWith('ocean', []));
    const palette = paletteFromRoot(root);
    expect(palette.theme).toBe('ocean');
    expect(palette.baseColors).toEqual(DEFAULT_BASE_COLORS);
  });
});

// ---------------------------------------------------------------------------
// domainRootColorPort — the FeatureColorPort<DomainRoot> adapter
// ---------------------------------------------------------------------------

describe('domainRootColorPort — colorOf / autoColorEnabledById', () => {
  it('reads the feature colour effective at the anchor time', () => {
    const root = rootWith([historyAt(leafFeature('A', ['a1', 'a2', 'a3'], color(true, '#abcdef')), ['a1', 'a2', 'a3'])]);
    const port = domainRootColorPort(T, calendar);
    expect(port.colorOf(root, asFeatureId('A'))?.fillColor).toBe('#abcdef');
    expect(port.colorOf(root, asFeatureId('missing'))).toBeNull();
  });

  it('maps only LEAF features to their auto-color flag', () => {
    const leafOn = historyAt(leafFeature('A', ['a1', 'a2', 'a3'], color(true, '#111111')), ['a1', 'a2', 'a3']);
    const leafOff = historyAt(leafFeature('B', ['b1', 'b2', 'b3'], color(false, '#222222')), ['b1', 'b2', 'b3']);
    const line = historyAt(
      createLineFeature(asFeatureId('N'), createBasicAttributes('N', 0, 0), color(true, '#333333'), [
        asVertexId('n1'),
        asVertexId('n2'),
      ]),
      ['n1', 'n2'],
    );
    const root = rootWith([leafOn, leafOff, line]);
    const enabled = domainRootColorPort(T, calendar).autoColorEnabledById(root);
    expect(enabled.get(asFeatureId('A'))).toBe(true);
    expect(enabled.get(asFeatureId('B'))).toBe(false);
    expect(enabled.has(asFeatureId('N'))).toBe(false); // non-leaf excluded
  });
});

describe('domainRootColorPort.withColor — preserves the whole root (critique MED)', () => {
  it('keeps uiSettings / settings / baseMap and actually writes the colour at T', () => {
    const ui = uiSettingsWith('ocean', ['#112244']);
    const root = rootWith(
      [historyAt(leafFeature('A', ['a1', 'a2', 'a3'], color(true, '#000000')), ['a1', 'a2', 'a3'])],
      ui,
    );
    const next = domainRootColorPort(T, calendar).withColor(root, asFeatureId('A'), color(true, '#ff8800'));
    // uiSettings survives (would be silently dropped by a { histories, settings,
    // baseMap } literal — the precedent the critique warns about).
    expect(next.uiSettings).toBe(root.uiSettings);
    expect(next.settings).toBe(root.settings);
    expect(next.baseMap).toBe(root.baseMap);
    // and the colour is genuinely written at T.
    expect(fillOf(next, 'A')).toBe('#ff8800');
  });

  it('is a lossless no-op when the feature is not effective at T (not-found branch)', () => {
    const ui = uiSettingsWith('ocean', ['#112244']);
    const root = rootWith(
      [historyAt(leafFeature('A', ['a1', 'a2', 'a3'], color(true, '#000000')), ['a1', 'a2', 'a3'])],
      ui,
    );
    const next = domainRootColorPort(T, calendar).withColor(root, asFeatureId('ghost'), color(true, '#ff0000'));
    expect(next).toBe(root); // unchanged; uiSettings intact by identity
  });

  it('writes FROM the anchor time only — an earlier anchor keeps its colour', () => {
    // A two-anchor history: T-100 (blue) then T (green). A recolor at T must not
    // pollute the T-100 slot (in-place effective rewrite would; from-T does not).
    const featOld = leafFeature('A', ['a1', 'a2', 'a3'], color(true, '#0000ff'));
    const featNew = leafFeature('A', ['a1', 'a2', 'a3'], color(true, '#00ff00'));
    const eOld = createAnchorEntry(
      createAnchor(asAnchorId('A@old'), createAnchorSnapshot([featOld], storeOf(['a1', 'a2', 'a3']))),
      T_MINUS,
      null,
    );
    const eNew = createAnchorEntry(
      createAnchor(asAnchorId('A@new'), createAnchorSnapshot([featNew], storeOf(['a1', 'a2', 'a3']))),
      T,
      null,
    );
    const series: AnchorSeries = { entries: [eOld, eNew] };
    const root = rootWith([{ featureId: asFeatureId('A'), series }]);

    const next = domainRootColorPort(T, calendar).withColor(root, asFeatureId('A'), color(true, '#ffff00'));
    expect(fillOf(next, 'A', T)).toBe('#ffff00'); // T updated
    expect(fillOf(next, 'A', T_MINUS)).toBe('#0000ff'); // T-100 untouched
  });
});

// ---------------------------------------------------------------------------
// maybeComposeAutoRecolor — the funnel wrapper
// ---------------------------------------------------------------------------

/** baseline: A,B disjoint (no shared vertex). final: A,B share s1,s2. */
function adjacencyChangeRoots(autoA: boolean, autoB: boolean): {
  baseline: DomainProject;
  finalState: DomainProject;
} {
  const baseline = rootWith([
    historyAt(leafFeature('A', ['a1', 'a2', 'a3', 'a4'], color(autoA, '#000000')), ['a1', 'a2', 'a3', 'a4']),
    historyAt(leafFeature('B', ['b1', 'b2', 'b3', 'b4'], color(autoB, '#000000')), ['b1', 'b2', 'b3', 'b4']),
  ]);
  const finalState = rootWith([
    historyAt(leafFeature('A', ['a1', 's1', 's2', 'a4'], color(autoA, '#000000')), ['a1', 's1', 's2', 'a4']),
    historyAt(leafFeature('B', ['s1', 'b2', 'b3', 's2'], color(autoB, '#000000')), ['s1', 'b2', 'b3', 's2']),
  ]);
  return { baseline, finalState };
}

describe('maybeComposeAutoRecolor — composite on adjacency change (FR-94)', () => {
  it('wraps into a single composite and colours adjacent auto features distinctly', () => {
    const { baseline, finalState } = adjacencyChangeRoots(true, true);
    const cmd = maybeComposeAutoRecolor(swapCommand(baseline, finalState), baseline, T);
    expect(isCompositeCommand(cmd)).toBe(true);

    const exec = cmd.execute(baseline);
    expect(fillOf(exec.state, 'A')).not.toBe(fillOf(exec.state, 'B')); // four-color 回避
    expect(fillOf(exec.state, 'A')).not.toBe('#000000'); // changed from manual start
  });

  it('undo restores the baseline atomically; redo replays identical colours (教訓 5.20)', () => {
    const { baseline, finalState } = adjacencyChangeRoots(true, true);
    const cmd = maybeComposeAutoRecolor(swapCommand(baseline, finalState), baseline, T);
    const exec = cmd.execute(baseline);
    const undo = cmd.undo(exec.state);
    expect(undo.state).toBe(baseline); // colour + structure reverted in ONE unit
    const redo = cmd.redo(undo.state);
    expect(fillOf(redo.state, 'A')).toBe(fillOf(exec.state, 'A'));
    expect(fillOf(redo.state, 'B')).toBe(fillOf(exec.state, 'B'));
  });

  it('is deterministic: the same operation + palette yields the same colours', () => {
    const { baseline, finalState } = adjacencyChangeRoots(true, true);
    const a = maybeComposeAutoRecolor(swapCommand(baseline, finalState), baseline, T).execute(baseline);
    const b = maybeComposeAutoRecolor(swapCommand(baseline, finalState), baseline, T).execute(baseline);
    expect(fillOf(a.state, 'A')).toBe(fillOf(b.state, 'A'));
    expect(fillOf(a.state, 'B')).toBe(fillOf(b.state, 'B'));
  });

  it('leaves a manual (auto=false) neighbour untouched (不干渉)', () => {
    const { baseline, finalState } = adjacencyChangeRoots(true, false); // A auto, B manual
    const cmd = maybeComposeAutoRecolor(swapCommand(baseline, finalState), baseline, T);
    expect(isCompositeCommand(cmd)).toBe(true); // A is a target
    const exec = cmd.execute(baseline);
    expect(fillOf(exec.state, 'A')).not.toBe('#000000'); // A recoloured
    expect(fillOf(exec.state, 'B')).toBe('#000000'); // B manual, unchanged
    expect(featureByIdAt(exec.state, T, asFeatureId('B'))!.color.autoColorEnabled).toBe(false);
  });
});

describe('maybeComposeAutoRecolor — short-circuit + trigger (教訓 5.6 / perf gate)', () => {
  it('does NOT build any adjacency graph when no auto-color target exists (722 all-manual)', () => {
    const { baseline, finalState } = adjacencyChangeRoots(false, false); // all manual
    const spy = vi.spyOn(adjacencyModule, 'buildAdjacencyFromLeaves');
    try {
      const structural = swapCommand(baseline, finalState);
      const cmd = maybeComposeAutoRecolor(structural, baseline, T);
      expect(spy).not.toHaveBeenCalled(); // perf gate: graph never built
      expect(cmd).toBe(structural); // returned unwrapped (reference identity)
      expect(isCompositeCommand(cmd)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('DOES build the adjacency graph when an auto-color target exists (spy interception control)', () => {
    const { baseline, finalState } = adjacencyChangeRoots(true, true);
    const spy = vi.spyOn(adjacencyModule, 'buildAdjacencyFromLeaves');
    try {
      maybeComposeAutoRecolor(swapCommand(baseline, finalState), baseline, T);
      // previous + current graphs → two builds. (>0 proves the spy intercepts, so
      // the negative test above is meaningful, not vacuous.)
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('adds NO recolor unit when adjacency is unchanged even with an auto target', () => {
    // Same geometry before/after (an edit that does not change shared boundaries):
    // the before/after signatures match → shouldRecolor false → structural only.
    const before = rootWith([
      historyAt(leafFeature('A', ['a1', 's1', 's2', 'a4'], color(true, '#000000')), ['a1', 's1', 's2', 'a4']),
      historyAt(leafFeature('B', ['s1', 'b2', 'b3', 's2'], color(true, '#000000')), ['s1', 'b2', 'b3', 's2']),
    ]);
    const after = rootWith([
      historyAt(leafFeature('A', ['a1', 's1', 's2', 'a4'], color(true, '#000000')), ['a1', 's1', 's2', 'a4']),
      historyAt(leafFeature('B', ['s1', 'b2', 'b3', 's2'], color(true, '#000000')), ['s1', 'b2', 'b3', 's2']),
    ]);
    const structural = swapCommand(before, after);
    const cmd = maybeComposeAutoRecolor(structural, before, T);
    expect(cmd).toBe(structural);
    expect(isCompositeCommand(cmd)).toBe(false);
  });
});

describe('maybeComposeAutoRecolor — FR-100 type changes fire (Codex HIGH #2)', () => {
  const VIDS = ['a1', 'a2', 'a3'];

  it('recolors when a property edit turns auto-color OFF→ON with unchanged geometry (FR-100)', () => {
    const baseline = rootWith([
      historyAt(leafFeature('A', VIDS, color(false, '#123456')), VIDS), // manual
    ]);
    const postRoot = rootWith([
      historyAt(leafFeature('A', VIDS, color(true, '#123456')), VIDS), // auto ON, same geometry
    ]);
    const cmd = maybeComposeAutoRecolor(swapCommand(baseline, postRoot), baseline, T);
    expect(isCompositeCommand(cmd)).toBe(true); // 即再配色 despite identical adjacency
    const a = featureByIdAt(cmd.execute(baseline).state, T, asFeatureId('A'))!;
    expect(a.color.autoColorEnabled).toBe(true);
    expect(a.color.fillColor).toBe(DEFAULT_BASE_COLORS[0]); // isolated → palette[0]
  });

  it('recolors when the palette changes while auto-color is ON (FR-109)', () => {
    const baseline = rootWith(
      [historyAt(leafFeature('A', VIDS, color(true, DEFAULT_BASE_COLORS[0]!)), VIDS)],
      uiSettingsWith('default', []), // → DEFAULT palette
    );
    const postRoot = rootWith(
      [historyAt(leafFeature('A', VIDS, color(true, DEFAULT_BASE_COLORS[0]!)), VIDS)],
      uiSettingsWith('ocean', ['#111111', '#222222']), // different base colours
    );
    const cmd = maybeComposeAutoRecolor(swapCommand(baseline, postRoot), baseline, T);
    expect(isCompositeCommand(cmd)).toBe(true); // palette change re-resolves the auto colour
    expect(fillOf(cmd.execute(baseline).state, 'A')).toBe('#111111'); // NEW palette index 0
  });

  it('an auto feature avoids a MANUAL neighbour whose fill is a palette colour (FR-101)', () => {
    // A auto (starts #000000); B manual with fill == palette[0]. A precedes B in id
    // order → would greedily take palette[0] and collide. baseline non-adjacent.
    const baseline = rootWith([
      historyAt(leafFeature('A', ['a1', 'a2', 'a3', 'a4'], color(true, '#000000')), ['a1', 'a2', 'a3', 'a4']),
      historyAt(leafFeature('B', ['b1', 'b2', 'b3', 'b4'], color(false, DEFAULT_BASE_COLORS[0]!)), ['b1', 'b2', 'b3', 'b4']),
    ]);
    const postRoot = rootWith([
      historyAt(leafFeature('A', ['a1', 's1', 's2', 'a4'], color(true, '#000000')), ['a1', 's1', 's2', 'a4']),
      historyAt(leafFeature('B', ['s1', 'b2', 'b3', 's2'], color(false, DEFAULT_BASE_COLORS[0]!)), ['s1', 'b2', 'b3', 's2']),
    ]);
    const cmd = maybeComposeAutoRecolor(swapCommand(baseline, postRoot), baseline, T);
    expect(isCompositeCommand(cmd)).toBe(true);
    const exec = cmd.execute(baseline);
    expect(fillOf(exec.state, 'A')).not.toBe(DEFAULT_BASE_COLORS[0]); // avoids manual B's colour
    expect(fillOf(exec.state, 'B')).toBe(DEFAULT_BASE_COLORS[0]); // B manual, untouched
  });
});
