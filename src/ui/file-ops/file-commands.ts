// UI layer (U39): the file-operation COMMAND handlers (FR-105) — thin handlers
// that compose the typed IPC (U15), the unsaved guard (FR-107), the load flow
// (FR-104/106), and the save context (教訓 5.36) into the operations the U20 menu /
// shortcuts / D&D register (spec §A / §実装方針 2).
//
// 教訓 5.6 適用: 読み込み / D&D / 新規 / 終了 are reduced to a small set of handlers
// that ALL pass through the SAME guard + flow; D&D is NOT a separate flow — it only
// differs in how it obtains the dropped path, then joins the common load path
// (注意点「同一フローへの収束」).
//
// DEPENDENCY-INJECTED (受け入れ基準 7 / 教訓 5.41): every external effect (the typed
// IPC, the dialog, the domain reflect, the consistency check) is a port, so the
// handlers are unit-testable without Electron and the App bridge binds the live
// ports. The handlers re-implement none of U15's I/O, U14's checks, or U17's clamp
// (単一の真実源, spec §やらないこと).

import type { Calendar } from '../../domain/time/calendar';
import type {
  ConsistencyReport,
  DomainProject,
} from '../../domain/persistence/index';

import { classifyLoad, LOAD_STEP, type LoadStep, type LoadTransport } from './load-flow';
import { runUnsavedGuard, type UnsavedGuardPorts } from './unsaved-guard';
import {
  applyChosenRepairs,
  buildRepairRows,
  REPAIR_OUTCOME,
  type RepairChoices,
} from './repair-flow';
import { REPAIR_STRINGS } from './strings';

/**
 * Ports the file commands depend on. Each maps 1:1 to a dependency unit's public
 * API (U15 typed IPC / U14 checks / domain reflect / U20 modals), fixed as a
 * contract so the App bridge wires the live ones and tests inject mocks (教訓 5.33).
 */
export interface FileCommandPorts {
  // -- unsaved guard (FR-107) ------------------------------------------------
  readonly guard: UnsavedGuardPorts;

  // -- U15 typed IPC (FR-105) — the ONLY path to file I/O (FR-02 sandbox) ----
  /** Save to the current path; resolves true on success (保存後 dirty 解消は caller). */
  readonly save: () => Promise<boolean>;
  /** 名前を付けて保存: main opens the dialog; resolves true on success. */
  readonly saveAs: () => Promise<boolean>;
  /** Load (main opens the open dialog). Resolves the transport result. */
  readonly load: () => Promise<LoadTransport>;
  /** D&D load: hand the dropped path to main. Resolves the transport result. */
  readonly loadDropped: (droppedPath: string) => Promise<LoadTransport>;

  // -- U14 consistency check (FR-106) ----------------------------------------
  /** Deserialize the parsed manifest to a domain project (persistence-internal seam). */
  readonly toProject: (parse: Extract<LoadStep, { kind: 'reflect-direct' }>['parse']) => DomainProject;
  /** Run U14's load-time consistency check over the project (FR-106). */
  readonly checkConsistency: (project: DomainProject, calendar: Calendar) => ConsistencyReport;
  readonly calendar: Calendar;

  // -- auto-repair UI (FR-106) — returns the user's choices, or null to abort -
  //
  // `isRetry` distinguishes the FIRST open from a RE-PRESENT after the chosen
  // repairs left the project inconsistent (REPAIR_OUTCOME.Unresolved). The
  // controller shows the『前回の修復では解消できなかった』banner only on a retry —
  // completeLoad stays pure (it merely passes the flag), so the seam lives entirely
  // in the port contract (BUG #2: the retry banner was unreachable from the live
  // flow because the controller had no way to tell first-open from retry-open).
  readonly promptRepair: (
    report: ConsistencyReport,
    isRetry: boolean,
  ) => Promise<RepairChoices | null>;

  // -- reflect + notify ------------------------------------------------------
  /** Reflect a validated project into the domain (確定後のみ, 教訓 5.22). */
  readonly reflectProject: (project: DomainProject, path: string) => void;
  /** Show a Japanese rejection / failure notice (FR-115). */
  readonly notify: (message: string) => void;
}

/** Whether the save (with 名前を付けて保存 委譲) eventually succeeded. */
async function doSave(ports: FileCommandPorts, needsSaveAs: boolean): Promise<boolean> {
  return needsSaveAs ? ports.saveAs() : ports.save();
}

/**
 * The 保存 command (FR-105 / spec §A). When the save target is undetermined it
 * routes to 名前を付けて保存; otherwise it saves to the current path. Returns the
 * outcome so the caller updates dirty / path (the store update is the bridge's job).
 */
export function saveCommand(ports: FileCommandPorts, needsSaveAs: boolean): Promise<boolean> {
  return doSave(ports, needsSaveAs);
}

/** The 名前を付けて保存 command (FR-105). */
export function saveAsCommand(ports: FileCommandPorts): Promise<boolean> {
  return ports.saveAs();
}

/**
 * The SHARED load completion: classify the transport, then reject / reflect /
 * repair (FR-104/106). BOTH the menu/shortcut load and the D&D load call this, so
 * there is exactly one post-load flow (教訓 5.6). The unsaved guard has ALREADY run
 * before the transport was obtained (a破壊的置換 needs the guard first, spec §B).
 */
async function completeLoad(ports: FileCommandPorts, transport: LoadTransport): Promise<void> {
  // Classify with no report first to short-circuit cancel / reject without a
  // consistency pass; for an Ok parse we compute the report and re-classify.
  const pre = classifyLoad(transport, undefined);
  if (pre.kind === LOAD_STEP.Cancelled) return;
  if (pre.kind === LOAD_STEP.Reject) {
    ports.notify(pre.message);
    return;
  }

  // Ok parse: deserialize, run U14, classify with the report.
  const project = ports.toProject(pre.parse);
  const report = ports.checkConsistency(project, ports.calendar);
  const step = classifyLoad(transport, report);

  if (step.kind === LOAD_STEP.ReflectDirect) {
    // 空レポートは正当値 (教訓 5.18): reflect without a repair dialog.
    ports.reflectProject(project, transport.ok ? transport.path : '');
    return;
  }
  if (step.kind !== LOAD_STEP.Repair) return; // unreachable for an Ok parse

  // Inconsistencies: drive the auto-repair UI (first open, isRetry=false). A null
  // choice == 修復せず中止 — the user's explicit abort, which keeps the current state
  // and is NOT a failure to notify about (受け入れ基準 3: 中止は静かに現状維持).
  const choices = await ports.promptRepair(step.report, false);
  if (choices === null) return;
  const rows = buildRepairRows(step.report);
  const applied = applyChosenRepairs(project, rows, choices, ports.calendar);
  // 教訓 5.22: reflect ONLY when the repaired project is fully consistent.
  if (applied.outcome === REPAIR_OUTCOME.Applied) {
    ports.reflectProject(applied.project, transport.ok ? transport.path : '');
    return;
  }
  if (applied.outcome === REPAIR_OUTCOME.Unresolved) {
    // The chosen repairs did not resolve everything; re-present ONCE (isRetry=true,
    // so the controller shows the『前回は解消できなかった』banner — BUG #2).
    const retry = await ports.promptRepair(applied.remaining, true);
    // BUG #5: a cancelled retry must NOT silently drop the load. Unlike the first
    // 中止 (which keeps the untouched current state with no surprise), reaching the
    // retry means we already told the user their first repair failed; cancelling now
    // is a genuine "could not make it consistent" outcome, so surface it explicitly.
    if (retry === null) {
      ports.notify(REPAIR_STRINGS.abortedUnresolved);
      return;
    }
    const retryRows = buildRepairRows(applied.remaining);
    const retried = applyChosenRepairs(applied.project, retryRows, retry, ports.calendar);
    if (retried.outcome === REPAIR_OUTCOME.Applied) {
      ports.reflectProject(retried.project, transport.ok ? transport.path : '');
      return;
    }
    // BUG #5: the SECOND attempt is ALSO Unresolved (or Incomplete, which cannot
    // occur — promptRepair returns complete choices or null). We do NOT loop forever
    // and we do NOT silently load inconsistent data: abort the load and tell the user
    // the file could not be made consistent (教訓 5.22 確定までドメインを破壊しない).
    ports.notify(REPAIR_STRINGS.abortedUnresolved);
  }
  // Incomplete cannot occur here (promptRepair returns complete choices or null).
}

/**
 * The 読み込み command (FR-105 / spec §A): guard first (FR-107), then the shared
 * load flow. The guard MUST pass (true) before the destructive replace.
 */
export async function openCommand(ports: FileCommandPorts): Promise<void> {
  if (!(await runUnsavedGuard(ports.guard))) return;
  const transport = await ports.load();
  await completeLoad(ports, transport);
}

/**
 * The D&D load command (FR-105 / spec §A): SAME guard + SAME completion as the
 * menu load, only the path source differs (教訓 5.6 同一フローへの収束).
 */
export async function dropLoadCommand(ports: FileCommandPorts, droppedPath: string): Promise<void> {
  if (!(await runUnsavedGuard(ports.guard))) return;
  const transport = await ports.loadDropped(droppedPath);
  await completeLoad(ports, transport);
}

/**
 * The 新規プロジェクト command (FR-03 / spec §D): guard first (a破壊的置換), then the
 * caller initialises the new save context as ONE unit (`buildNewProjectContext` +
 * the empty domain). This handler only enforces the guard ordering; the atomic
 * initialisation is performed by the bridge so the store swap is one transition.
 */
export async function newProjectCommand(
  ports: FileCommandPorts,
  initialise: () => void,
): Promise<void> {
  if (!(await runUnsavedGuard(ports.guard))) return;
  initialise();
}

/**
 * The app-quit guard (FR-107 / spec §B): the window-close request runs the SAME
 * guard; the quit proceeds ONLY when it returns true (教訓 5.41: the branch is a
 * pure-tested function, the actual quit is the bridge's effect). Returns whether
 * the caller may close the window.
 */
export function quitGuard(ports: FileCommandPorts): Promise<boolean> {
  return runUnsavedGuard(ports.guard);
}
