// Bug-hunt regression — focus: every successful edit/add/split silently DROPS
// the project's uiSettings (editing/apply-proposal.ts — withHistories rebuild).
//
// THE BUG (high severity, area=editing/persistence):
//   `withHistories(root, histories)` rebuilt the project as an explicit literal
//   `{ histories, settings: root.settings, baseMap: root.baseMap }`, OMITTING the
//   optional `DomainProject.uiSettings` field (serialize.ts). It is the sole
//   constructor used by applyAddProposal, applySplitProposal AND applyEditProposal,
//   so ANY committed edit/add/split on a loaded project that carries persisted UI
//   settings (FR-109 / FR-110; wired by ui/file-ops save-context) permanently lost
//   them on the next save — `serialize` only writes the `ui` block when
//   `uiSettings` is present, so the data was gone for good.
//
//   repair.ts deliberately uses spread (`{ ...project, histories }`) for exactly
//   this reason; apply-proposal did not.
//
// THE FIX: `withHistories` now spreads root (`{ ...root, histories }`), preserving
// ALL of root's fields — including uiSettings — while replacing only `histories`.
//
// These tests would FAIL on the pre-fix code (uiSettings became undefined after
// any apply, and the serialized manifest dropped its `ui` block). Run ONLY this file:
//   npx vitest run src/domain/__bughunt__/apply-proposal-preserves-ui-settings.property.test.ts

import { describe, expect, it } from 'vitest';

import {
  applyAddProposal,
  applyEditProposal,
  applySplitProposal,
} from '../editing/apply-proposal';
import { createEditProposal } from '../consistency/types';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createLeafFeature, type LeafFeature } from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, type Vertex } from '../vertex';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import type { AddSnapshot } from '../add/proposal';
import type { SplitSnapshot } from '../knife/proposal';
import type { FeatureSnapshot } from '../editing/edit-flow';
import type { DomainProject, UiSettings } from '../persistence/serialize';
import { serialize } from '../persistence/serialize';
import { createGeoParams } from '../geo/geo-params';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

// A fully-valid sentinel UiSettings (schema-conformant; carries non-default values
// so a silent drop is unmistakable in the assertions and in serialize round-trips).
const UI_SETTINGS: UiSettings = {
  project: {
    projectName: 'Sentinel Project',
    projectDescription: 'must survive every edit/add/split',
    equatorLengthKm: 40000,
    flattening: 0.0034,
    timelineMinYear: -2000,
    timelineMaxYear: 3000,
    gridSpacingDeg: 15,
    gridColor: '#abcdef',
    gridOpacity: 0.42,
    baseMapId: 'sentinel-base',
    areaLabelOccupancyThreshold: 0.33,
    newAreaAutoColorDefault: false,
    defaultPaletteTheme: 'sentinel-theme',
    customPalette: ['#112233', '#445566'],
    zoomMin: 0.5,
    zoomMax: 8,
  },
  app: {
    snapDistancePx: 37,
    renderFps: 24,
    vertexMarkerCap: 1234,
    showConflictGuide: false,
    undoStackSize: 42,
  },
};

function projectWithUi(histories: readonly DomainProject['histories'][number][] = []): DomainProject {
  return {
    histories,
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
    uiSettings: UI_SETTINGS,
  };
}

function squareLeaf(idRaw: string, vRaw: readonly string[], lons: readonly number[]): {
  feature: LeafFeature;
  vertices: Vertex[];
} {
  const vertices = vRaw.map((v, i) => createVertex(asVertexId(v), { lon: lons[i] ?? 0, lat: 0 }));
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes('F', 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

function seedAdd(root: DomainProject, leaf: ReturnType<typeof squareLeaf>, year: number): DomainProject {
  const proposal = createEditProposal(leaf.feature.id, timePointYear(year), {
    feature: leaf.feature,
    vertices: leaf.vertices,
    sharedCandidateIds: new Map(),
  } satisfies AddSnapshot);
  return applyAddProposal(root, proposal);
}

describe('apply-proposal preserves uiSettings (FR-109/110 regression)', () => {
  it('applyAddProposal carries uiSettings through to the new project (and into serialize)', () => {
    const root = projectWithUi();
    const leaf = squareLeaf('f-1', ['v-1', 'v-2', 'v-3'], [0, 1, 2]);

    const next = seedAdd(root, leaf, 1000);

    expect(next.uiSettings).toBeDefined();
    expect(next.uiSettings).toEqual(UI_SETTINGS);
    // End-to-end: the on-disk manifest still carries the `ui` block (the symptom).
    const manifest = serialize(next);
    expect(manifest.ui).toBeDefined();
    expect(manifest.ui?.project.projectName).toBe('Sentinel Project');
  });

  it('applyEditProposal carries uiSettings through to the new project', () => {
    const leaf = squareLeaf('f-edit', ['e-1', 'e-2', 'e-3'], [0, 1, 2]);
    const seeded = seedAdd(projectWithUi(), leaf, 0);
    expect(seeded.uiSettings).toEqual(UI_SETTINGS); // precondition

    const movedV: Vertex = createVertex(asVertexId('e-1'), { lon: 99, lat: 99 });
    const edited: LeafFeature = {
      ...leaf.feature,
      shape: createShape([createTerritoryRing(asRingId('r-f-edit'), ['e-1', 'e-2', 'e-3'].map(asVertexId))]),
    };
    const snapshot: FeatureSnapshot = { feature: edited, vertices: [movedV] };
    const next = applyEditProposal(seeded, createEditProposal(leaf.feature.id, timePointYear(500), snapshot), calendar);

    expect(next.uiSettings).toBeDefined();
    expect(next.uiSettings).toEqual(UI_SETTINGS);
  });

  it('applyEditProposal preserves uiSettings even when a deletion drops the whole history', () => {
    const leaf = squareLeaf('f-del', ['d-1', 'd-2', 'd-3'], [0, 1, 2]);
    const seeded = seedAdd(projectWithUi(), leaf, 0);

    // A deletion snapshot at the anchor time of the feature's sole own history:
    // the history is dropped entirely — this hits the OTHER withHistories call site.
    const snapshot: FeatureSnapshot = { vertices: [], deletedFeatureId: leaf.feature.id };
    const next = applyEditProposal(seeded, createEditProposal(leaf.feature.id, timePointYear(0), snapshot), calendar);

    expect(next.histories).toHaveLength(0); // the history was dropped
    expect(next.uiSettings).toBeDefined();
    expect(next.uiSettings).toEqual(UI_SETTINGS);
  });

  it('applySplitProposal carries uiSettings through to the new project', () => {
    const inheritor = squareLeaf('f-inh', ['vi-1', 'vi-2', 'vi-3'], [0, 1, 2]);
    const seeded = seedAdd(projectWithUi(), inheritor, 0);

    const newSide = squareLeaf('f-new', ['vn-1', 'vn-2', 'vn-3'], [10, 11, 12]);
    const newInheritorShape = createShape([
      createTerritoryRing(asRingId('r-inh-2'), ['vi-1', 'vi-2'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: inheritor.feature.id,
      inheritorShape: newInheritorShape,
      newFeature: newSide.feature,
      vertices: [...inheritor.vertices, ...newSide.vertices],
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [inheritor.feature.id, newSide.feature.id],
    };
    const next = applySplitProposal(
      seeded,
      createEditProposal(inheritor.feature.id, timePointYear(500), snapshot),
      calendar,
    );

    expect(next.uiSettings).toBeDefined();
    expect(next.uiSettings).toEqual(UI_SETTINGS);
  });

  it('a project WITHOUT uiSettings stays without it (no regression for pre-`ui` projects)', () => {
    // Omit uiSettings entirely (exactOptionalPropertyTypes: never write `undefined`).
    const root: DomainProject = {
      histories: [],
      settings: projectWithUi().settings,
      baseMap: projectWithUi().baseMap,
    };
    const leaf = squareLeaf('f-x', ['x-1', 'x-2', 'x-3'], [0, 1, 2]);
    const next = seedAdd(root, leaf, 1000);
    expect(next.uiSettings).toBeUndefined();
    expect(serialize(next).ui).toBeUndefined();
  });
});
