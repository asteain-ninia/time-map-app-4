// U39 ui-settings bridge tests — FR-13 gridVisible persistence + BACK-COMPAT.
//
// The bridge is the ONLY store<->persisted mapping for the full UI settings surface
// (FR-109 / FR-110). These pin the FR-13 gridVisible discipline:
//   (a) round-trip store→persisted→store preserves gridVisible (true AND false);
//   (b) WRITE always outputs gridVisible (常時書き, from the store value);
//   (c) a persisted `ui` block WITHOUT gridVisible — an existing pre-FR13 .gimoza
//       (derle-world.gimoza 等) — hydrates to the store with gridVisible=true
//       (欠落=可視, the single back-compat default-fill point).

import { describe, expect, it } from 'vitest';

import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS } from '../state/settings';
import type { UiSettings } from '../../domain/persistence/index';

import { fromPersistedUiSettings, toPersistedUiSettings } from './ui-settings-bridge';

describe('ui-settings bridge — gridVisible persistence (FR-13)', () => {
  it('WRITE always outputs gridVisible (from the store value)', () => {
    const off = toPersistedUiSettings({
      projectSettings: { ...DEFAULT_PROJECT_SETTINGS, gridVisible: false },
      appSettings: DEFAULT_APP_SETTINGS,
    });
    expect(off.project.gridVisible).toBe(false);

    const on = toPersistedUiSettings({
      projectSettings: { ...DEFAULT_PROJECT_SETTINGS, gridVisible: true },
      appSettings: DEFAULT_APP_SETTINGS,
    });
    expect(on.project.gridVisible).toBe(true);
  });

  it('round-trips gridVisible store→persisted→store (true and false)', () => {
    for (const gridVisible of [true, false]) {
      const persisted = toPersistedUiSettings({
        projectSettings: { ...DEFAULT_PROJECT_SETTINGS, gridVisible },
        appSettings: DEFAULT_APP_SETTINGS,
      });
      const live = fromPersistedUiSettings(persisted);
      expect(live.projectSettings.gridVisible).toBe(gridVisible);
    }
  });

  it('READ defaults gridVisible to true when the `ui` block omits it (後方互換, 欠落=可視)', () => {
    // Simulate an existing pre-FR13 .gimoza: a valid `ui` block WITHOUT gridVisible.
    const persisted = toPersistedUiSettings({
      projectSettings: DEFAULT_PROJECT_SETTINGS,
      appSettings: DEFAULT_APP_SETTINGS,
    });
    const legacy: UiSettings = {
      project: { ...persisted.project },
      app: { ...persisted.app },
    };
    delete (legacy.project as { gridVisible?: boolean }).gridVisible;
    expect('gridVisible' in legacy.project).toBe(false); // precondition

    const live = fromPersistedUiSettings(legacy);
    expect(live.projectSettings.gridVisible).toBe(true);
  });
});
