// U33 recolor-command adapter: compose a structural change (分割・結合・共有境界
// 成立／解消) and its auto-recolor side-effect into a SINGLE indivisible undo unit
// (FR-94 / 教訓 5.20 / 5.23, U33 受け入れ基準1・6).
//
// WHY THIS LIVES IN U33 (spec §依存 行90 / 教訓 5.33 / 5.34):
//   The concrete full-state root (U03/U08) and the structural commands (U26 分割 /
//   U30 結合) own their own state shapes. Rather than reach into them, U33 cuts a
//   MINIMAL type boundary (a `FeatureColorPort<S>` adapter) here: a structural
//   command produces the new state; this module reads the auto-color-enabled
//   features + the before/after adjacency through the port, decides whether to
//   recolor by RESULT STATE (`shouldRecolor`, never a call-path flag — 教訓 5.6),
//   computes the deterministic plan (`computeColorPlan`), writes it back via
//   `applyAutoColors`, and packages BOTH steps as one `createCompositeCommand`
//   (U12). The boundary is fixed by both-side contract tests.
//
// SINGLE UNDO UNIT (FR-94): the returned command is a composite — one execute
// applies structure then recolor; one undo reverts recolor then structure; the
// color change can never be undone independently of the structure that caused it
// ("配色だけが別アンドゥ単位にならない", AC6). When adjacency did NOT change the
// composite degrades to the structural command alone (no spurious recolor unit).
//
// PURITY (受け入れ基準6): the recolor sub-command captures before/after color
// snapshots at build time and replays them deterministically in execute/undo/redo,
// matching the U26/U30 commands' "record then replay, never re-mint" discipline.

import {
  type Command,
  type CommandOutcome,
  createCompositeCommand,
  defineCommandKind,
} from '../command/command';
import { createCommandResult, type CommandResult } from '../command/result';
import type { ColorInfo } from '../attributes';
import { applyAutoColors } from './style-permission';
import { asFeatureId, type DomainId, type FeatureId } from '../ids';

import type { AdjacencyGraph } from './adjacency';
import { computeColorPlan } from './auto-color';
import type { Palette } from './palette';
import { shouldRecolor } from './recolor-trigger';

export const RECOLOR_COMMAND_KIND = defineCommandKind('recolor');
export const RECOLOR_COMMAND_LABEL = '自動配色';

/**
 * The minimal state boundary the recolor adapter needs (教訓 5.33). The host
 * wires these to the real state root; both sides test against this port.
 *
 * `colorOf` reads a feature's current color info from the state; `withColor`
 * returns a NEW state with that feature's color replaced (pure, Immer-friendly).
 * `autoColorEnabledById` reports which features are auto-color targets so only
 * those are recolored (FR-101). The adapter never reaches past these.
 */
export interface FeatureColorPort<S> {
  colorOf(state: S, id: FeatureId): ColorInfo | null;
  withColor(state: S, id: FeatureId, color: ColorInfo): S;
  autoColorEnabledById(state: S): ReadonlyMap<FeatureId, boolean>;
}

/** The before/after adjacency snapshots the recolor decision turns on (教訓 5.6). */
export interface AdjacencyTransition {
  readonly previous: AdjacencyGraph;
  readonly current: AdjacencyGraph;
}

/** A captured before/after color for one recolored feature (undo data, 教訓 5.20). */
interface ColorChange {
  readonly id: FeatureId;
  readonly before: ColorInfo;
  readonly after: ColorInfo;
}

function touchedResult(changes: readonly ColorChange[]): CommandResult {
  const ids: DomainId[] = changes.map((c) => asFeatureId(c.id));
  // A recolor only ever touches features that already existed and still exist —
  // nothing is created or deleted. `survived` == `touched` (教訓 5.23 対称通知).
  return createCommandResult({ survived: ids });
}

/**
 * Build the pure recolor sub-command from a captured set of color changes. It
 * writes the `after` colors on execute/redo and the `before` colors on undo,
 * through the SAME port, so it is a deterministic replay (no re-computation, no
 * re-mint). Touched set is symmetric across execute/undo/redo (教訓 5.23).
 */
function createColorChangeCommand<S>(
  port: FeatureColorPort<S>,
  changes: readonly ColorChange[],
): Command<S> {
  const result = touchedResult(changes);
  const writeAfter = (state: S): CommandOutcome<S> => {
    let next = state;
    for (const c of changes) next = port.withColor(next, c.id, c.after);
    return { state: next, result };
  };
  const writeBefore = (state: S): CommandOutcome<S> => {
    let next = state;
    for (const c of changes) next = port.withColor(next, c.id, c.before);
    return { state: next, result };
  };
  return {
    kind: RECOLOR_COMMAND_KIND,
    label: RECOLOR_COMMAND_LABEL,
    execute: writeAfter,
    redo: writeAfter,
    undo: writeBefore,
  };
}

/**
 * Compute the color changes the auto-recolor would make on `stateAfterStructure`,
 * given the resulting adjacency `current` and the resolved `palette`. Only
 * auto-color-enabled features whose fill/selected actually change are captured
 * (a feature already at its planned color is not "touched" — no ghost change).
 * Pure: it reads through the port and never mutates the state.
 */
function planColorChanges<S>(
  port: FeatureColorPort<S>,
  stateAfterStructure: S,
  current: AdjacencyGraph,
  palette: Palette,
): ColorChange[] {
  const enabled = port.autoColorEnabledById(stateAfterStructure);
  const targets = new Set<FeatureId>();
  for (const [id, on] of enabled) if (on) targets.add(id);

  const plan = computeColorPlan(current, palette, targets);
  const changes: ColorChange[] = [];
  for (const [id, featurePlan] of plan) {
    const before = port.colorOf(stateAfterStructure, id);
    if (before === null) continue; // target not present in the state — skip.
    const after = applyAutoColors(before, featurePlan.fillColor, featurePlan.selectedColor);
    if (
      after.fillColor === before.fillColor &&
      after.selectedColor === before.selectedColor &&
      after.autoColorEnabled === before.autoColorEnabled
    ) {
      continue; // already at the planned color — not a change.
    }
    changes.push({ id, before, after });
  }
  return changes;
}

/**
 * Compose a structural command with its auto-recolor into ONE undo unit (FR-94).
 *
 * The recolor runs IFF the adjacency relation changed (`shouldRecolor` over the
 * before/after graphs — 教訓 5.6: result state, not call path). When it does, the
 * structural command's resulting state is recolored deterministically and BOTH
 * steps become a single `createCompositeCommand`: undo reverts color then
 * structure atomically. When adjacency is unchanged (e.g. a plain vertex move,
 * or a time-move that hands in equal graphs) the structural command is returned
 * unwrapped — no separate color unit is produced (教訓 5.25 範囲を広げない).
 *
 * @param structural  the structural command (U26 split / U30 merge / shared-
 *                    boundary), already built against its own state.
 * @param baseline    the state BEFORE the structural command (its undo target),
 *                    used to read the after-structure state for planning.
 * @param transition  the before/after adjacency snapshots (from U10/U11).
 * @param palette     the resolved palette to color from (settings / FR-109).
 * @param port        the feature-color boundary adapter (教訓 5.33).
 * @param label       optional composite label (defaults to the structural label).
 */
export function composeWithRecolor<S>(
  structural: Command<S>,
  baseline: S,
  transition: AdjacencyTransition,
  palette: Palette,
  port: FeatureColorPort<S>,
  label?: string,
): Command<S> {
  if (!shouldRecolor(transition.previous, transition.current)) {
    // No adjacency change → no recolor → no extra undo unit (教訓 5.6 / 5.25).
    return structural;
  }
  // Determine the post-structure state to plan the recolor against. Building the
  // changes here (at compose time) keeps execute/undo/redo a pure replay.
  const afterStructure = structural.execute(baseline).state;
  const changes = planColorChanges(port, afterStructure, transition.current, palette);
  if (changes.length === 0) {
    // Adjacency changed but no auto-color target actually changes color (e.g. no
    // enabled targets) → nothing to recolor; keep it a single structural unit.
    return structural;
  }
  const recolor = createColorChangeCommand(port, changes);
  return createCompositeCommand(label ?? structural.label, [structural, recolor]);
}
