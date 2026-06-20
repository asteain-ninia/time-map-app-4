// U43 — the live-U13 binding TYPE SKELETON (integration-lens honesty: 教訓 5.33).
//
// WHY THIS FILE EXISTS (review finding 整合性/integration):
// The composition root (App.tsx) hands each edit tool a `startProcess` closure.
// Earlier comments in App.tsx claimed binding the LIVE U13 orchestrator was a
// "契約越し1行差し替え" (a one-line swap of that closure). That was wrong and it
// hid the real integration cost from whoever picks the work up next. The actual
// requirement is to build a full `ConsistencyPorts<DomainRoot, Snapshot>` adapter
// that binds U09 (time) / U10 (spatial) / U06 (difference) / U12 (single-undo) on
// top of the LIVE domain root, plus an `applyProposal` that materialises an edit
// snapshot into that root. This module makes that cost VISIBLE as a typed factory
// signature so the remaining wiring is countable, not a one-liner illusion.
//
// SCOPE OF THIS MODULE: it is the type骨格 ONLY (finding fix「型骨格まで置く」). It
// declares the factory shape `LiveConsistencyBinding` + the per-tool builder
// signatures and documents, port by port, exactly what each adapter must do and
// which UNIMPLEMENTED domain capability blocks it. It deliberately does NOT
// construct a runnable binding, because doing so requires a domain operation that
// no shipped unit provides yet (see BLOCKER below). App.tsx therefore still feeds
// the deterministic-rejection stub, and this file is the single place that pins
// the contract the future implementer must satisfy.
//
// BLOCKER (recorded in docs/現状.md per 開発ガイド §1.8 — UNASSIGNED, NOT U42):
// `applyProposal(root, EditProposal<Snapshot>)` must turn an edit snapshot
// (U23 `AddSnapshot` = new Feature + Vertices; U26 `SplitSnapshot` = inheritor
// update + non-inherited new feature) into a `DomainProject` by creating/updating
// the relevant `FeatureHistory` first anchor. No implemented unit exposes a pure
// "snapshot → anchor → history insert/replace" domain operation over
// `DomainProject` today (persistence stores AnchorSeries of PERSISTED snapshots,
// not live editable feature state). Building it is a new domain responsibility —
// it is NOT verification work, so it cannot belong to U42 (U42「やらないこと」=
// 新規ドメイン機能・新規 UI の実装). It needs a planned unit.

import type {
  ConsistencyPorts,
  EditProposal,
} from '../domain/consistency/index';
import type { Command } from '../domain/command/command';
import type { FeatureId } from '../domain/ids';
import type { DomainProject } from '../domain/persistence/index';
import type { AddSnapshot } from '../domain/add/index';
import type { SplitSnapshot } from '../domain/knife/index';

/** The live domain truth root the binding threads through every port (U14). */
export type DomainRoot = DomainProject;

/**
 * A reference to the live domain root the composition root owns. The binding must
 * read the CURRENT root at process-start time (not a stale capture) and write the
 * committed result back through the single store-write path (教訓 5.6 / 5.22), so
 * the factory takes a getter rather than a value.
 */
export interface DomainRootAccess {
  /** Read the current committed domain root (single truth source, 技術方針 2.3). */
  readonly getRoot: () => DomainRoot;
}

/**
 * The per-tool live binding the composition root would inject in place of the
 * stub `startProcess`. `Snapshot` is the opaque per-tool edit payload
 * (`AddSnapshot` for U23, `SplitSnapshot` for U26). Producing one of these is the
 * work the BLOCKER above gates: every field below is a non-trivial adapter, and
 * `ports.applyProposal` cannot be written until the snapshot→history domain op
 * exists.
 */
export interface LiveConsistencyBinding<Snapshot> {
  /**
   * The `ConsistencyPorts` the U13 orchestrator consumes, bound over the live
   * root. EACH port is a real adapter (NOT a one-liner):
   *   - applyProposal: snapshot → trial DomainProject (BLOCKED — see file header).
   *   - checkTime:     U09 temporal-consistency over the feature's AnchorSeries.
   *   - checkConstraints: editing-constraint re-validation over the trial root.
   *   - detectSpatial: U10 terminal-vs-terminal overlap over the trial root.
   *   - applyResolution: U06 difference, writing the trimmed shape back.
   *   - makeCommand:   U12 single-undo composite over current→final.
   */
  readonly ports: ConsistencyPorts<DomainRoot, Snapshot>;
  /**
   * The closure App.tsx passes to a tool controller as its `startProcess`:
   * reads the current root, runs U13 `startProcess(root, proposal, ports)`, and
   * returns the discriminated `ProcessResult`. This — together with `ports` — is
   * what "binding the live U13" actually means; it is NOT a single-line swap.
   */
  readonly startProcess: (
    proposal: EditProposal<Snapshot>,
  ) => import('../domain/consistency/index').ProcessResult<DomainRoot>;
}

/**
 * Factory signature for the U23 add binding. The implementer builds it once the
 * snapshot→history domain op exists; App.tsx then replaces `createAddBootstrap`'s
 * stub `startProcess` with `createLiveAddBinding(access).startProcess`.
 *
 * Intentionally a TYPE ONLY (no implementation) — see file header BLOCKER.
 */
export type CreateLiveAddBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<AddSnapshot>;

/**
 * Factory signature for the U26 knife/split binding (mirror of the add binding;
 * the proposal is already a U13 `EditProposal<SplitSnapshot>`). TYPE ONLY.
 */
export type CreateLiveKnifeBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<SplitSnapshot>;

/**
 * The U12 command-builder shape the `makeCommand` port must satisfy, restated
 * here so the future implementer sees the exact signature without re-deriving it
 * from the ports interface. Pure: baseline + final + touched → one composite
 * command (single undo unit, FR-73 / FR-94).
 */
export type MakeSingleUndoCommand = (
  baseline: DomainRoot,
  finalState: DomainRoot,
  touched: readonly FeatureId[],
) => Command<DomainRoot>;
