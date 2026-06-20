// UI layer (U39): the APP BRIDGE that binds the file-operation flows to the LIVE
// dependency ports (spec §依存 / 受け入れ基準 1 / 6). This is the seam the review
// flagged as missing: it composes U15's typed IPC (`TimeMapApi`), U14's
// consistency check + manifest→project reconstruction, the U16 session store, and
// the U20 modal vessels into the {@link FileCommandPorts} the command handlers
// consume — so a menu/shortcut/D&D action actually reaches file I/O and the UI.
//
// SINGLE SOURCE OF TRUTH (教訓 5.33): every external effect is routed through a
// dependency unit's public API (typed IPC channels, `checkConsistency`,
// `manifestToProject`, the store actions, `zoomRangeOf`). This module re-implements
// none of them; it only WIRES them. It is framework-free (no React) so the
// wiring is unit-testable with mock ports (受け入れ基準 7), and the React
// controller (`FileOpsController.tsx`) mounts it.

import type { Calendar } from '../../domain/time/calendar';
import {
  checkConsistency,
  manifestToProject,
  type ConsistencyReport,
  type DomainProject,
} from '../../domain/persistence/index';
import type { LoadResponse, SaveRequest, SaveResponse, TimeMapApi } from '../../shell/ipc/contract';

import { loadTransportFrom } from './load-adapter';
import type { LoadStep, LoadTransport } from './load-flow';
import type { FileCommandPorts } from './file-commands';
import type { RepairChoices } from './repair-flow';
import type { UnsavedChoice } from './unsaved-guard';
import { zoomRangeOf, type ZoomRangeValue } from './zoom-limit';
import type { ProjectSettings as UiProjectSettings } from '../state/settings';

/**
 * The live host capabilities the bridge needs from the React controller / store.
 * Each is a dependency-unit capability (not re-implemented here); the controller
 * supplies the concrete ones and tests supply mocks (教訓 5.33 契約越し).
 */
export interface FileOpsHost {
  /** U15 typed IPC surface (the ONLY path to file I/O, FR-02 sandbox). */
  readonly api: TimeMapApi;
  /** Build the save request (manifest + asset bytes) from the current domain. */
  readonly buildSaveRequest: () => SaveRequest;
  /** Whether the current project still needs 名前を付けて保存 (no save path yet). */
  readonly needsSaveAs: () => boolean;
  /** Adopt a successful save (update save path + clear dirty, spec §A 保存後). */
  readonly onSaved: (path: string) => void;
  /** Is the project currently dirty? Single basis (spec §B / 教訓 5.24). */
  readonly isDirty: () => boolean;
  /** Show the 3-choice unsaved warning (U20 modal); resolves the choice (FR-107). */
  readonly promptUnsaved: () => Promise<UnsavedChoice>;
  /** Show the auto-repair UI (U20 modal); resolves choices or null (FR-106). */
  readonly promptRepair: (report: ConsistencyReport) => Promise<RepairChoices | null>;
  /** Reflect a validated project into the store + adopt its save context (教訓 5.22). */
  readonly reflectProject: (project: DomainProject, path: string) => void;
  /** Show a Japanese rejection / failure notice (FR-115). */
  readonly notify: (message: string) => void;
  /** The active calendar for consistency checks. */
  readonly calendar: Calendar;
}

/** Reconstruct a DomainProject from a validated parse (U14 boundary, R8-safe). */
function toProject(parse: Extract<LoadStep, { kind: 'reflect-direct' }>['parse']): DomainProject {
  // `parse` is the Ok ParseResult carrying an already-Zod-validated Manifest, so
  // `manifestToProject` is a pure reconstruction (no boundary hole, R8).
  return manifestToProject(parse.manifest);
}

/**
 * Build the {@link FileCommandPorts} from the live host (受け入れ基準 1 / 6). The
 * save / load / D&D ports map U15's `SaveResponse` / `LoadResponse` onto the
 * flow's value types through `loadTransportFrom` (the single seam adapter); the
 * consistency check + reconstruction come from U14; the modals + store reflection
 * come from the host. NOTHING here re-implements a dependency unit.
 */
export function buildFileCommandPorts(host: FileOpsHost): FileCommandPorts {
  const runSave = async (which: 'save' | 'saveAs'): Promise<boolean> => {
    const req = host.buildSaveRequest();
    const res: SaveResponse =
      which === 'saveAs' ? await host.api.saveAs(req) : await host.api.save(req);
    if (res.ok) {
      host.onSaved(res.path);
      return true;
    }
    // cancelled is NOT a failure to notify about (受け入れ基準 2: 保存キャンセル時は
    // 元の操作を中止するだけ); a write failure is reported (FR-115).
    if (res.reason === 'write-failed') host.notify(res.message);
    return false;
  };

  const loadVia = async (call: () => Promise<LoadResponse>): Promise<LoadTransport> =>
    loadTransportFrom(await call());

  return {
    guard: {
      isDirty: host.isDirty,
      promptUnsaved: host.promptUnsaved,
      // The guard's 保存 branch routes through the SAME save decision the menu uses
      // (過少共有しない: one save path), 名前を付けて保存 when needed.
      save: () => runSave(host.needsSaveAs() ? 'saveAs' : 'save'),
    },
    save: () => runSave('save'),
    saveAs: () => runSave('saveAs'),
    load: () => loadVia(() => host.api.load()),
    loadDropped: (droppedPath: string) => loadVia(() => host.api.loadDropped(droppedPath)),
    toProject,
    checkConsistency: (project: DomainProject, calendar: Calendar): ConsistencyReport =>
      checkConsistency(project, calendar),
    calendar: host.calendar,
    promptRepair: host.promptRepair,
    reflectProject: host.reflectProject,
    notify: host.notify,
  };
}

/** Derive the camera clamp range (FR-10) from the UI project settings (spec §E). */
export function cameraZoomRange(settings: UiProjectSettings): ZoomRangeValue {
  return zoomRangeOf(settings);
}
