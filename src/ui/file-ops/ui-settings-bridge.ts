// UI layer (U39): the conversion seam between the LIVE U16 store settings and the
// PERSISTED `UiSettings` shape carried in the domain project (FR-109 / FR-110).
//
// ROOT FIX for the二重真実源 (store.projectSettings vs. domain.settings): the user
// settings panel writes the rich U16 `ProjectSettings` / `AppSettings`, but the
// only thing persistence used to serialize was the narrow `domain.settings`, and a
// load never hydrated the store. This module is the single, typed place that maps
// the live store slice INTO the persisted `UiSettings` (on save) and back OUT (on
// load), so a save round-trips every setting and a load reflects them into the UI.
//
// The two shapes are structurally identical PLAIN data by contract (the persisted
// `UiSettings` schema is kept in lock-step with `ui/state/settings.ts`); this
// module makes the copy explicit (fresh palette array) and the contract enforced
// at the type level, so a future field added to one side fails to compile here
// until added to the other (教訓 5.36 境界を先に固定する).

import type { UiSettings } from '../../domain/persistence/index';
import type { AppSettings, ProjectSettings } from '../state/settings';

/** The live store slices this bridge maps to/from the persisted `UiSettings`. */
export interface LiveSettings {
  readonly projectSettings: ProjectSettings;
  readonly appSettings: AppSettings;
}

/**
 * Map the live store settings into the persisted `UiSettings` shape (SAVE path).
 * Builds fresh objects + a fresh palette array so the manifest never aliases the
 * live store value. The field list is explicit so the persisted shape and the UI
 * shape can never silently drift (a missing/extra field is a compile error).
 */
export function toPersistedUiSettings(live: LiveSettings): UiSettings {
  const p = live.projectSettings;
  const a = live.appSettings;
  return {
    project: {
      projectName: p.projectName,
      projectDescription: p.projectDescription,
      equatorLengthKm: p.equatorLengthKm,
      flattening: p.flattening,
      timelineMinYear: p.timelineMinYear,
      timelineMaxYear: p.timelineMaxYear,
      gridSpacingDeg: p.gridSpacingDeg,
      gridColor: p.gridColor,
      gridOpacity: p.gridOpacity,
      baseMapId: p.baseMapId,
      areaLabelOccupancyThreshold: p.areaLabelOccupancyThreshold,
      newAreaAutoColorDefault: p.newAreaAutoColorDefault,
      defaultPaletteTheme: p.defaultPaletteTheme,
      customPalette: [...p.customPalette],
      zoomMin: p.zoomMin,
      zoomMax: p.zoomMax,
    },
    app: {
      snapDistancePx: a.snapDistancePx,
      renderFps: a.renderFps,
      vertexMarkerCap: a.vertexMarkerCap,
      showConflictGuide: a.showConflictGuide,
    },
  };
}

/**
 * Map a persisted `UiSettings` back into the live store slices (LOAD path). Fresh
 * objects + palette array so the store never aliases the (frozen) manifest value.
 */
export function fromPersistedUiSettings(ui: UiSettings): LiveSettings {
  const p = ui.project;
  const a = ui.app;
  return {
    projectSettings: {
      projectName: p.projectName,
      projectDescription: p.projectDescription,
      equatorLengthKm: p.equatorLengthKm,
      flattening: p.flattening,
      timelineMinYear: p.timelineMinYear,
      timelineMaxYear: p.timelineMaxYear,
      gridSpacingDeg: p.gridSpacingDeg,
      gridColor: p.gridColor,
      gridOpacity: p.gridOpacity,
      baseMapId: p.baseMapId,
      areaLabelOccupancyThreshold: p.areaLabelOccupancyThreshold,
      newAreaAutoColorDefault: p.newAreaAutoColorDefault,
      defaultPaletteTheme: p.defaultPaletteTheme,
      customPalette: [...p.customPalette],
      zoomMin: p.zoomMin,
      zoomMax: p.zoomMax,
    },
    appSettings: {
      snapDistancePx: a.snapDistancePx,
      renderFps: a.renderFps,
      vertexMarkerCap: a.vertexMarkerCap,
      showConflictGuide: a.showConflictGuide,
    },
  };
}
