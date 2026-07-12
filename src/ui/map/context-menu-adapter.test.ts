// context-menu-adapter tests (FR-96 受け入れ基準 1-8, 実ドメイン結線の証拠).
//
// Drives the REAL U36 composer through the adapter over LIVE domain lookups
// (resolveDisplayFor.owners / featureByIdAt / sharedVertexIdsFor) built from a real
// DomainProject where two adjacent leaves share a border vertex — proving the three
// lookups reach the actual domain data (test plan §1), not stubs.

import { beforeEach, describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createLeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore } from '../../domain/vertex';
import {
  MENU_ITEM_KIND,
  NO_MENU,
  type ContextMenuModel,
  type FeatureKindLookup,
  type NoMenu,
  type SharedVertexLookup,
} from '../../domain/context-menu/index';
import {
  EMPTY_SELECTION,
  HIT_KIND,
  featureBodyHit,
  replaceVertices,
  vertexHit,
  withActiveFeature,
  type VertexOwnerLookup,
} from '../../domain/selection/index';
import type { HitResult, SelectionState } from '../../domain/selection/index';
import { singleAnchorHistory, DEFAULT_SETTINGS, DEFAULT_BASEMAP } from '../../domain/persistence/fixtures';
import type { DomainProject } from '../../domain/persistence/index';
import { timePointYear } from '../../domain/time/time-point';
import { EDIT_MODE, DEFAULT_DISPLAY_CONTROL, type EditMode, type ToolId } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import { clearDisplayResolutionCache, resolveDisplayFor } from './display-resolution-cache';
import { sharedVertexIdsFor } from './shared-vertex-derivation';
import { clearLiveLookupCache, featureByIdAt } from '../live-lookup';
import { composeMenuFor, toMenuToolKind, type MenuLookups } from './context-menu-adapter';

const COLOR = createColorInfo(true, '#111111', '#222222', '#333333', 'default', 1, 1);
const TIME = timePointYear(0);
const A = asFeatureId('A');
const VS = asVertexId('vs');

/** Two top-level leaves A and B sharing border vertex `vs` (both drawn Real at depth 0). */
function borderShareProject(): DomainProject {
  const vs = createVertex(VS, createCoordinate(10, 0));
  const a0 = createVertex(asVertexId('a0'), createCoordinate(0, 0));
  const a1 = createVertex(asVertexId('a1'), createCoordinate(10, 5));
  const a2 = createVertex(asVertexId('a2'), createCoordinate(0, 10));
  const b0 = createVertex(asVertexId('b0'), createCoordinate(20, 0));
  const b1 = createVertex(asVertexId('b1'), createCoordinate(20, 10));
  const leafA = createLeafFeature(
    A,
    createBasicAttributes('A国', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('A-r'), [a0.id, vs.id, a1.id, a2.id])]),
  );
  const leafB = createLeafFeature(
    asFeatureId('B'),
    createBasicAttributes('B国', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('B-r'), [vs.id, b0.id, b1.id])]),
  );
  return {
    histories: [
      singleAnchorHistory('A', [leafA], createVertexStore([vs, a0, a1, a2])),
      singleAnchorHistory('B', [leafB], createVertexStore([vs, b0, b1])),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** The three LIVE lookups, built from the SAME resolveDisplayFor bundle the app uses. */
function liveLookups(root: DomainProject): MenuLookups {
  const resolution = resolveDisplayFor(root, TIME, DEFAULT_DISPLAY_CONTROL);
  const shared = sharedVertexIdsFor(resolution);
  const featureKindLookup: FeatureKindLookup = {
    kindOf: (fid: FeatureId) => featureByIdAt(root, TIME, fid)?.kind ?? null,
  };
  const ownerLookup: VertexOwnerLookup = {
    ownerOf: (vid: VertexId) => resolution.owners.get(vid) ?? null,
  };
  const sharedLookup: SharedVertexLookup = { isShared: (vid: VertexId) => shared.has(vid) };
  return { featureKindLookup, sharedLookup, ownerLookup };
}

function compose(
  root: DomainProject,
  selection: SelectionState,
  opts: { mode?: EditMode; tool?: ToolId | null; hit?: HitResult } = {},
): ContextMenuModel | NoMenu {
  return composeMenuFor({
    selection,
    mode: opts.mode ?? EDIT_MODE.Edit,
    activeTool: opts.tool ?? null,
    hit: opts.hit ?? { kind: HIT_KIND.Empty },
    position: { x: 5, y: 6 },
    lookups: liveLookups(root),
  });
}

function kinds(model: ContextMenuModel | NoMenu): string[] {
  if (model === NO_MENU || model.kind !== 'menu') return [];
  return model.items.map((i) => i.kind);
}

beforeEach(() => {
  clearDisplayResolutionCache();
  clearLiveLookupCache();
});

describe('context-menu-adapter — live lookup wiring (実ドメイン結線の証拠)', () => {
  it('sharedLookup reports the shared border vertex from real display resolution', () => {
    const root = borderShareProject();
    const { sharedLookup, ownerLookup, featureKindLookup } = liveLookups(root);
    // The shared border vertex is derived from the RAW per-time feature set.
    expect(sharedLookup.isShared(VS)).toBe(true);
    expect(sharedLookup.isShared(asVertexId('a0'))).toBe(false);
    // ownerLookup resolves vs to a single (first-wins) owner among the grabbable leaves.
    expect(ownerLookup.ownerOf(VS)).not.toBeNull();
    // featureKindLookup reaches the effective-at-time feature kind.
    expect(featureKindLookup.kindOf(A)).toBe('leaf');
    expect(featureKindLookup.kindOf(asFeatureId('ghost'))).toBeNull();
  });

  it('right-click a shared border vertex (VertexOnly single owner) → 共有解除 offered, 削除 not', () => {
    const root = borderShareProject();
    // No active feature; the shared vertex is selected (its owner resolves to one leaf).
    const owner = liveLookups(root).ownerLookup.ownerOf(VS)!;
    const selection = replaceVertices(EMPTY_SELECTION, owner, new Set([VS]));
    const ks = kinds(compose(root, selection, { hit: vertexHit(owner, VS) }));
    expect(ks).toContain(MENU_ITEM_KIND.Unshare);
    expect(ks).toContain(MENU_ITEM_KIND.EditProperties);
    // Delete×VertexOnly 乖離解消: no 削除 in a VertexOnly target.
    expect(ks).not.toContain(MENU_ITEM_KIND.Delete);
  });

  it('active leaf with the shared vertex selected → 削除 + 共有解除 + 面情報', () => {
    const root = borderShareProject();
    const selection = replaceVertices(withActiveFeature(EMPTY_SELECTION, A), A, new Set([VS]));
    const ks = kinds(compose(root, selection, { hit: featureBodyHit(A) }));
    expect(ks).toContain(MENU_ITEM_KIND.Delete);
    expect(ks).toContain(MENU_ITEM_KIND.Split);
    expect(ks).toContain(MENU_ITEM_KIND.Unshare);
  });

  it('view mode → NO_MENU (canEdit=false, 教訓 5.13 一括無効化)', () => {
    const root = borderShareProject();
    const selection = withActiveFeature(EMPTY_SELECTION, A);
    expect(compose(root, selection, { mode: EDIT_MODE.View, hit: featureBodyHit(A) })).toBe(NO_MENU);
  });

  it('knife tool active → 分割 dropped (受け入れ基準 4)', () => {
    const root = borderShareProject();
    const selection = withActiveFeature(EMPTY_SELECTION, A);
    const selectKs = kinds(compose(root, selection, { hit: featureBodyHit(A) }));
    const knifeKs = kinds(
      composeMenuFor({
        selection,
        mode: EDIT_MODE.Edit,
        activeTool: TOOL_ID.EditKnife,
        hit: featureBodyHit(A),
        position: { x: 0, y: 0 },
        lookups: liveLookups(root),
      }),
    );
    expect(selectKs).toContain(MENU_ITEM_KIND.Split);
    expect(knifeKs).not.toContain(MENU_ITEM_KIND.Split);
  });
});

describe('toMenuToolKind — tool class mapping (教訓 5.19)', () => {
  it('maps knife / shape-edit / default', () => {
    expect(toMenuToolKind(TOOL_ID.EditKnife)).toBe('knife');
    expect(toMenuToolKind(TOOL_ID.EditVertex)).toBe('shapeEdit');
    expect(toMenuToolKind(TOOL_ID.EditRing)).toBe('shapeEdit');
    expect(toMenuToolKind(TOOL_ID.EditDrill)).toBe('shapeEdit');
    expect(toMenuToolKind(TOOL_ID.EditMerge)).toBe('select');
    expect(toMenuToolKind(null)).toBe('select');
  });
});
