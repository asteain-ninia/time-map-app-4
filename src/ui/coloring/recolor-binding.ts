// U33 recolor binding (FR-100 / FR-101): the store/App-INDEPENDENT wiring that
// turns a committed structural Command<DomainRoot> into "structure + auto-recolor
// as ONE undo unit". It adapts the concrete DomainProject root to the domain
// recolor adapter's FeatureColorPort and derives the before/after same-layer
// adjacency graphs from the leaves effective at the commit's anchor time. The
// App-side funnel (recordCommand) calls maybeComposeAutoRecolor; everything here
// is pure and unit-driven (no store, no React) so it is exercised in isolation.
//
// TIME SOURCE (critique / integration must-include #5): the anchor time is passed
// IN — the COMMAND's own commit/anchor time — never read from a live store. So
// adjacency is evaluated AND colours are written at the correct time even on paths
// whose commit time differs from store.currentTime.
//
// PALETTE SOURCE (critique HIGH): DomainProject.settings is the narrow
// geodesy/grid/snap surface and carries NO palette. The palette theme + custom
// colours live in the OPTIONAL uiSettings.project (FR-109). paletteFromRoot reads
// there with a DEFAULT_PALETTE fallback because uiSettings is undefined for new /
// pre-ui-manifest projects — reading root.settings would not compile.
//
// SINGLE UNDO UNIT / DETERMINISM: the heavy lifting (one composite, result-state
// recolor trigger, before/after colour capture + replay, manual-colour
// non-interference) is the domain composeWithRecolor's; this module only supplies
// the port, the palette and the two adjacency snapshots (教訓 5.6 / 5.20).

import type { ColorInfo } from '../../domain/attributes';
import type { Command } from '../../domain/command/command';
import {
  type AdjacencyTransition,
  type FeatureColorPort,
  type Palette,
  DEFAULT_PALETTE,
  composeWithRecolor,
  createPalette,
} from '../../domain/coloring';
import { buildAdjacencyFromLeaves } from '../../domain/coloring/adjacency-from-features';
import { rewriteFeatureSnapshotAtTime } from '../../domain/editing/apply-proposal';
import { FEATURE_KIND, withColor as setFeatureColor } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import { getCalendar, type Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';

import { featureByIdAt, featuresAt, verticesAt } from '../live-lookup';

/** The concrete live root the recolor is wired against (== consistency-binding's DomainRoot). */
export type DomainRoot = DomainProject;

/**
 * Resolve the palette to colour from (FR-100 / FR-109). The theme + custom base
 * colours live in `uiSettings.project`; a project without persisted UI settings
 * (new document, or a pre-`ui` manifest) falls back to {@link DEFAULT_PALETTE}.
 * NEVER read from `root.settings` — that surface has no palette fields.
 */
export function paletteFromRoot(root: DomainRoot): Palette {
  const project = root.uiSettings?.project;
  if (project === undefined) return DEFAULT_PALETTE;
  return createPalette(project.defaultPaletteTheme, project.customPalette);
}

/**
 * Adapt the DomainRoot to the recolor adapter's {@link FeatureColorPort}, resolving
 * every read/write at `time` (the commit anchor time) with `calendar`.
 *
 * `withColor` writes the recoloured feature into its history FROM `time` via
 * {@link rewriteFeatureSnapshotAtTime} (a past-edit: it updates the anchor starting
 * at `time` or inserts one there, leaving earlier anchors untouched — an in-place
 * effective-entry swap would retro-pollute the colour before `time`). The new root
 * is `{ ...root, histories }` so uiSettings/settings/baseMap all SURVIVE (a
 * `{ histories, settings, baseMap }` literal would silently drop uiSettings). When
 * the feature is not effective at `time` the rewrite is a no-op and the root is
 * returned unchanged — colorOf reports `null` for exactly those, so the planner
 * never targets one, keeping plan and state in agreement.
 */
export function domainRootColorPort(time: TimePoint, calendar: Calendar): FeatureColorPort<DomainRoot> {
  return {
    colorOf(root: DomainRoot, id: FeatureId): ColorInfo | null {
      const feature = featureByIdAt(root, time, id);
      return feature === undefined ? null : feature.color;
    },
    autoColorEnabledById(root: DomainRoot): ReadonlyMap<FeatureId, boolean> {
      const enabled = new Map<FeatureId, boolean>();
      for (const feature of featuresAt(root, time)) {
        // Only area (leaf) features are auto-color targets (FR-101).
        if (feature.kind === FEATURE_KIND.Leaf) {
          enabled.set(feature.id, feature.color.autoColorEnabled);
        }
      }
      return enabled;
    },
    withColor(root: DomainRoot, id: FeatureId, color: ColorInfo): DomainRoot {
      const feature = featureByIdAt(root, time, id);
      if (feature === undefined) return root; // not effective at `time` — lossless no-op.
      const recolored = setFeatureColor(feature, color);
      const histories = rewriteFeatureSnapshotAtTime(root.histories, id, recolored, [], time, calendar);
      return { ...root, histories };
    },
  };
}

/**
 * Whether ANY auto-color-enabled leaf is effective at `time`. The recolor
 * short-circuit: an all-manual project (e.g. every one of the 722 DERLE features
 * with autoColorEnabled=false) has nothing to colour, so the adjacency graph is
 * never even built (a per-commit perf gate).
 */
function hasAutoColorTargetAt(root: DomainRoot, time: TimePoint): boolean {
  for (const feature of featuresAt(root, time)) {
    if (feature.kind === FEATURE_KIND.Leaf && feature.color.autoColorEnabled) return true;
  }
  return false;
}

/**
 * Wrap a committed structural command so its auto-recolor side-effect (FR-100 /
 * FR-101) rides in the SAME undo unit — or return it unchanged when there is
 * nothing to recolour.
 *
 * @param command   the structural command (add / knife / merge / reparent / drill /
 *                  edit-confirm …), already built against the DomainRoot.
 * @param baseline  the root BEFORE `command` (its undo target).
 * @param time      the command's commit/anchor time (NOT store.currentTime): the
 *                  time adjacency is evaluated at and colours are written from.
 *
 * Flow: apply the command to get the post-structure root; if no auto-color target
 * is effective there, return the command untouched (no adjacency work). Otherwise
 * derive the before/after same-layer adjacency graphs and hand them to the domain
 * composeWithRecolor, which recolours IFF the adjacency signature changed and packs
 * structure + recolor into one composite (教訓 5.6 / 5.20 / 5.25).
 */
export function maybeComposeAutoRecolor(
  command: Command<DomainRoot>,
  baseline: DomainRoot,
  time: TimePoint,
): Command<DomainRoot> {
  const postRoot = command.execute(baseline).state;
  if (!hasAutoColorTargetAt(postRoot, time)) return command;

  const calendar = getCalendar(baseline.settings.calendarId);
  const transition: AdjacencyTransition = {
    previous: buildAdjacencyFromLeaves(featuresAt(baseline, time), verticesAt(baseline, time)),
    current: buildAdjacencyFromLeaves(featuresAt(postRoot, time), verticesAt(postRoot, time)),
  };
  return composeWithRecolor(
    command,
    baseline,
    transition,
    paletteFromRoot(postRoot),
    domainRootColorPort(time, calendar),
  );
}
