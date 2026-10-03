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
import {
  SAVE_OUTCOME,
  saveSucceeded,
  type FileCommandPorts,
  type ReflectInfo,
  type SaveOutcome,
} from './file-commands';
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
  /**
   * 保存の直前の整合検査（司令塔の決定 (3)。増分 7 の手直し 2 回目で年を見るように直した）。
   *   - `proceed`: 書いてよい。
   *   - `block`: 「開き直すと地物が失われる形」（持ち主の居ない系列／どの年にも居ない親を
   *     指す parentId）が混ざっているので止める。`message` が理由。
   *   - `cancel`: 年をまたぐ食い違いを板で見せ、利用者が［やめる］を選んだ。
   * 年をまたぐ食い違いだけなら、宿主は板で［このまま保存する］［やめる］を聞き、保存を
   * 止めて利用者を行き止まりにしない。自動保存（`origin === 'auto'`）では聞かない。
   * 省略可（検査を持たない試験の宿主は素通りする）。
   */
  readonly preSaveGate?: (origin: SaveOrigin) => Promise<PreSaveGateResult>;
  /**
   * Adopt a successful save (update save path + clear dirty, spec §A 保存後).
   *
   * `origin` は「誰が起こした保存か」（`'manual'` = 利用者の 保存 / 名前を付けて保存、
   * `'auto'` = 自動保存のティック）。自動保存の成功で状態行の「直前の結果」を書き替えて
   * しまうと、利用者が読もうとしていた拒否理由が 5 分後に勝手に消える（教訓 5.12）ので、
   * 呼び出し先はこの値で出し分ける。
   *
   * `viaSaveAsDialog` は「main のネイティブな保存ダイアログを通ったか」。通っていれば
   * 行き先は利用者自身が選んでおり、上書きの可否もそこで聞かれている——だから以後
   * このセッションではその先への上書き確認を出さない。**保存前の needsSaveAs で
   * 判定してはいけない**: 既に保存先があるプロジェクトからの「名前を付けて保存」は
   * needsSaveAs が false なので載らず、直後の Ctrl+S でまた聞かれていた（A7）。
   */
  readonly onSaved: (
    path: string,
    info: { readonly origin: SaveOrigin; readonly viaSaveAsDialog: boolean },
  ) => void;
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
    project: DomainProject,
  ) => Promise<RepairChoices | null>;
  /**
   * Reflect a validated project into the store + adopt its save context (教訓 5.22).
   * `info.repaired` は修復ダイアログで直してから反映したか（増分 8D の手直し）。
   */
  readonly reflectProject: (project: DomainProject, path: string, info?: ReflectInfo) => void;
  /** Show a Japanese rejection / failure notice (FR-115). */
  readonly notify: (message: string) => void;
  /**
   * 修復で捨てた記録があれば、反映のあとで件数を知らせる（増分 7 の手直し 2 回目。「中身のある記録を
   * 黙って捨てない」）。**ここで型に載せて `buildFileCommandPorts` で写す** ―― 本体（増分 7）では
   * 宿主（`FileOpsController`）にだけあって、この型と写しに無かったので、知らせが一度も出ていなかった
   * （統合ブランチの継ぎ目の検証 2-1）。省略可（知らせる先を持たない試験の宿主）。
   */
  readonly reportRepairDiscards?: (count: number) => void;
  /** 「そのまま残す」で読み込んだ地物の数を、反映のあとで知らせる（2026-10-04）。省略可。 */
  readonly reportRepairKept?: (count: number) => void;
  /**
   * 未保存警告の「保存して続行」から呼ばれる保存（A3）。**上書き確認を通す**ので
   * `save` とは別の口にしてある: これまでこの枝だけが確認を素通りして、読み込み元の
   * ファイルを黙って上書きしていた（開く / 新規 / D&D / × / Alt+F4 / OS シャットダウンの
   * 6 経路すべてがこの枝を通る）。確認ダイアログとセッションの「確認済み」集合を持って
   * いるのはコントローラなので、ここでは口だけを定義して実体を注入してもらう。
   */
  readonly saveWithOverwriteConfirm: () => Promise<SaveOutcome>;
  /** The active calendar for consistency checks. */
  readonly calendar: Calendar;
}

/** 保存を起こしたのは誰か（自動保存は状態行の「直前の結果」を書き替えない）。 */
export type SaveOrigin = 'manual' | 'auto';

/** {@link FileOpsHost.preSaveGate} の答え。 */
export type PreSaveGateResult =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'block'; readonly message: string }
  | { readonly kind: 'cancel' };

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

  // `intent` is the caller's ASK, not the final destination:
  //   - 'saveAs' — an explicit 名前を付けて保存: ALWAYS writes through the Save-As dialog.
  //   - 'save'   — a plain 保存: "write to the current target, or 名前を付けて保存 if there
  //                is none". The save-vs-saveAs decision for this intent is re-evaluated at
  //                SERIALIZED EXECUTION time (below), NOT fixed at dispatch.
  const performSave = async (
    intent: 'save' | 'saveAs',
    origin: SaveOrigin,
  ): Promise<SaveOutcome> => {
    // 保存の直前の整合検査（司令塔の決定 (3)）: アプリ自身が「開き直すと地物が失われる
    // ファイル」を書かないようにする。直列化された区間の中、書き出しの前に見るので、
    // 待ち行列に並んでいる間に入った編集も見たうえで止められる。年をまたぐ食い違いは
    // 板で聞く（待つ）ので、**行き先の決定と中身の写しより前**に置く（下の 2 つの間に
    // 待ちを挟まない ―― HIGH-1 の「同じ瞬間の生の状態を読む」を崩さない）。
    const gate = host.preSaveGate === undefined ? null : await host.preSaveGate(origin);
    if (gate?.kind === 'block') return { kind: SAVE_OUTCOME.WriteFailed, message: gate.message };
    if (gate?.kind === 'cancel') return { kind: SAVE_OUTCOME.Cancelled };
    // HIGH-1 根治 — re-evaluate the DESTINATION at the moment this (possibly queued) save
    // actually runs. A plain 保存 that was dispatched while an earlier save was in flight is
    // queued behind it; between its dispatch and its turn a破壊的 context swap (新規 / load,
    // savePath=null) can land. Deciding save vs saveAs at DISPATCH would then run this queued
    // save as a plain `save`, atomic-writing the NEW project's manifest/assets to the OLD
    // file's currentPath in main — silent data-loss. Consulting host.needsSaveAs() HERE makes
    // such a queued save fall to 名前を付けて保存 (main asks for a fresh destination) instead, so
    // it can never overwrite the superseded file. An explicit 'saveAs' intent is unconditional.
    //
    // needsSaveAs() and buildSaveRequest() BOTH read the LIVE store, synchronously and with no
    // intervening await, so the destination decision and the serialized snapshot always
    // describe the SAME live context (no split read). buildSaveRequest captures the snapshot
    // the lost-edit guard compares against; it MUST run inside the serialized section
    // (immediately before the awaited IPC call), so the snapshot reflects the state at THIS
    // save's actual start, not at dispatch time (otherwise a change made between dispatch and
    // turn would be missed).
    const useSaveAs = intent === 'saveAs' || host.needsSaveAs();
    const req = host.buildSaveRequest();
    const res: SaveResponse = useSaveAs ? await host.api.saveAs(req) : await host.api.save(req);
    if (res.ok) {
      host.onSaved(res.path, { origin, viaSaveAsDialog: useSaveAs });
      return { kind: SAVE_OUTCOME.Saved, path: res.path };
    }
    // cancelled is NOT a failure to notify about (受け入れ基準 2: 保存キャンセル時は
    // 元の操作を中止するだけ).
    if (res.reason === 'write-failed') {
      // A5: **`notify`（＝OS の警告ボックス）へは流さない**。同じ失敗が状態行にも出て
      // いたので二重に知らせていた（設計書 §H.5「成功・失敗の唯一の常設の場所」に反する）。
      // 理由の文字列を結末に載せて返し、状態行へ出すのは呼び出し側 1 か所に絞る。
      return { kind: SAVE_OUTCOME.WriteFailed, message: res.message };
    }
    return { kind: SAVE_OUTCOME.Cancelled };
  };

  const runSave = (intent: 'save' | 'saveAs', origin: SaveOrigin = 'manual'): Promise<SaveOutcome> => {
    // Append to the chain so saves run strictly one-at-a-time. A prior save's
    // failure/rejection must NOT poison the chain, so we swallow it (catch) before
    // queueing the next save; this save's own outcome is still returned faithfully.
    const result = saveChain.then(() => performSave(intent, origin));
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
      // (過少共有しない: one save path) **and through the same 上書き確認** (A3): 未保存
      // 警告の「保存して続行」だけが確認を素通りしていたので、開く / 新規 / D&D / × /
      // Alt+F4 / OS シャットダウンの 6 経路が読み込み元を黙って上書きできていた。
      // save-vs-名前を付けて保存 の決定は直列化された実行時に performSave が行う（HIGH-1）。
      save: async () => saveSucceeded(await host.saveWithOverwriteConfirm()),
    },
    save: () => runSave('save'),
    saveAs: () => runSave('saveAs'),
    // FR-108 自動保存: 直列化も宛先の決定も lost-edit ガードも手動と同一（教訓 5.6）。
    // 違うのは「成功しても状態行の直前の結果を書き替えない」ことだけ。
    autoSave: () => runSave('save', 'auto'),
    load: () => loadVia(() => host.api.load()),
    loadDropped: (droppedPath: string) => loadVia(() => host.api.loadDropped(droppedPath)),
    // 増分 8D: 世代の一覧と、一覧の id で開く口。開いた結果は普通の読み込みと同じ
    // 変換（loadTransportFrom）を通り、同じ completeLoad へ合流する（教訓 5.6）。
    listBackups: () => host.api.listBackups(),
    openBackup: (id: string) => loadVia(() => host.api.openBackup(id)),
    // 増分 8D の手直し: 1 回の終わりを主プロセスへ（一覧の世代を間引きの対象に戻す）。
    // 待たない ―― 次の保存はこのあとに送られるので、主プロセスは先にこれを受け取る。
    endBackupChoice: () => {
      void host.api.endBackupChoice().catch(() => undefined);
    },
    toProject,
    checkConsistency: (project: DomainProject, calendar: Calendar): ConsistencyReport =>
      checkConsistency(project, calendar),
    calendar: host.calendar,
    promptRepair: host.promptRepair,
    reflectProject: host.reflectProject,
    notify: host.notify,
    ...(host.reportRepairDiscards === undefined
      ? {}
      : { reportRepairDiscards: host.reportRepairDiscards }),
    ...(host.reportRepairKept === undefined ? {} : { reportRepairKept: host.reportRepairKept }),
  };
}

/** Derive the camera clamp range (FR-10) from the UI project settings (spec §E). */
export function cameraZoomRange(settings: UiProjectSettings): ZoomRangeValue {
  return zoomRangeOf(settings);
}
