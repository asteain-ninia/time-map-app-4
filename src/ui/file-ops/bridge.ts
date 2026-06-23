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
  /**
   * Show the auto-repair UI (U20 modal); resolves choices or null (FR-106).
   * `isRetry` is true when re-presenting after the first repair left the project
   * inconsistent, so the controller shows the『前回は解消できなかった』banner (BUG #2).
   */
  readonly promptRepair: (
    report: ConsistencyReport,
    isRetry: boolean,
  ) => Promise<RepairChoices | null>;
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
  // Saves are SERIALIZED through this single in-flight chain (lost-edit guard, the
  // 保存A→編集→保存B→A完了 case): without it two saves could overlap, and the second
  // save's snapshot would overwrite the first's, so the first's completion would
  // mark the project clean against the WRONG snapshot — clearing dirty while disk
  // still holds the earlier save's content. Chaining guarantees that when a save's
  // onSaved runs, its OWN snapshot (captured in buildSaveRequest) is the one the
  // lost-edit guard compares against, because no later save started in between.
  let saveChain: Promise<unknown> = Promise.resolve();

  const performSave = async (which: 'save' | 'saveAs'): Promise<boolean> => {
    // buildSaveRequest captures the snapshot the lost-edit guard compares against;
    // it MUST run inside the serialized section (immediately before the awaited IPC
    // call), so the snapshot reflects the state at THIS save's actual start, not at
    // the moment the command was dispatched while an earlier save was still in
    // flight (otherwise a change made between dispatch and turn would be missed).
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

  const runSave = (which: 'save' | 'saveAs'): Promise<boolean> => {
    // Append to the chain so saves run strictly one-at-a-time. A prior save's
    // failure/rejection must NOT poison the chain, so we swallow it (catch) before
    // queueing the next save; this save's own outcome is still returned faithfully.
    const result = saveChain.then(() => performSave(which));
    saveChain = result.catch(() => undefined);
    return result;
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
