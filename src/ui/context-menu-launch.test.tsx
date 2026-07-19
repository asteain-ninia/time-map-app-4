// fr96 — launchMenuItem (the item → flow launch seam) tests, esp. the Codex F1b
// STALE EditProperties guard: the frozen menu model can outlive its target, and the
// EditProperties branch is the ONE flow whose downstream (setActiveFeature) does not
// re-validate — so THIS seam re-checks existence against the LIVE (root, time).

import { beforeEach, describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createCoordinate } from '../domain/coordinate';
import { createPointFeature } from '../domain/index';
import { asFeatureId, asVertexId, type VertexId } from '../domain/ids';
import { createVertex, createVertexStore } from '../domain/vertex';
import {
  DISABLE_REASON,
  FEATURE_KIND,
  MENU_ITEM_KIND,
  MENU_TARGET_KIND,
  disabledItem,
  enabledItem,
  type ContextMenuModel,
} from '../domain/context-menu/index';
import { timePointYear } from '../domain/time/time-point';
import type { DomainProject } from '../domain/persistence/index';
import {
  singleAnchorHistory,
  DEFAULT_SETTINGS,
  DEFAULT_BASEMAP,
} from '../domain/persistence/fixtures';

import { launchMenuItem, type MenuLaunchPorts } from './context-menu-launch';
import { clearLiveLookupCache } from './live-lookup';
import { TOOL_ID } from './shell/tools';

const TIME = timePointYear(0);
const A = asFeatureId('A');
const COLOR = createColorInfo(true, '#111111', '#222222', '#333333');

/** A root holding ONE point feature A at TIME (present), or an empty root. */
function rootWithA(present: boolean): DomainProject {
  if (!present) return { histories: [], settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
  const v = createVertex(asVertexId('A-v'), createCoordinate(1, 2));
  const feature = createPointFeature(A, createBasicAttributes('城A', 0, 100), COLOR, v.id);
  return {
    histories: [singleAnchorHistory('A', [feature], createVertexStore([v]))],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** A frozen model whose Feature target is A (leaf), with the full leaf item set. */
function modelForA(vertexIds: ReadonlySet<VertexId> = new Set()): ContextMenuModel {
  return {
    kind: 'menu',
    target: {
      kind: MENU_TARGET_KIND.Feature,
      featureId: A,
      featureKind: FEATURE_KIND.Leaf,
      vertexIds,
      sharedVertexIds: vertexIds,
    },
    position: { x: 0, y: 0 },
    items: [
      vertexIds.size > 0
        ? enabledItem(MENU_ITEM_KIND.DeleteVertex)
        : enabledItem(MENU_ITEM_KIND.Delete),
      enabledItem(MENU_ITEM_KIND.EditProperties),
      enabledItem(MENU_ITEM_KIND.Split),
      enabledItem(MENU_ITEM_KIND.ChangeAffiliation),
      disabledItem(MENU_ITEM_KIND.Merge, DISABLE_REASON.MergeNeedsMoreTargets),
      ...(vertexIds.size > 0 ? [enabledItem(MENU_ITEM_KIND.Unshare)] : []),
    ],
  };
}

function makePorts(root: DomainProject): {
  ports: MenuLaunchPorts;
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    dispatchEditDelete: [],
    deleteVertices: [],
    openProperties: [],
    armEditTool: [],
    unshare: [],
    hideFeature: [],
  };
  const track =
    (name: string) =>
    (...args: unknown[]): void => {
      calls[name]!.push(args);
    };
  const ports: MenuLaunchPorts = {
    getRoot: () => root,
    getTime: () => TIME,
    dispatchEditDelete: track('dispatchEditDelete'),
    deleteVertices: track('deleteVertices'),
    openProperties: track('openProperties'),
    armEditTool: track('armEditTool'),
    unshare: track('unshare'),
    hideFeature: track('hideFeature'),
  };
  return { ports, calls };
}

beforeEach(() => clearLiveLookupCache());

describe('launchMenuItem — EditProperties の live 存在検証 (Codex F1b)', () => {
  it('LIVE target: openProperties fires with the feature id', () => {
    const { ports, calls } = makePorts(rootWithA(true));
    launchMenuItem(MENU_ITEM_KIND.EditProperties, modelForA(), ports);
    expect(calls['openProperties']).toEqual([[A]]);
  });

  it('STALE target (undo で消えた等): openProperties は呼ばれず完全 no-op', () => {
    // The frozen model still offers EditProperties for A, but the live root no
    // longer carries A at the live time — the seam must NOT promote a nonexistent
    // id into the selection (the menu closes itself; nothing else happens).
    const { ports, calls } = makePorts(rootWithA(false));
    launchMenuItem(MENU_ITEM_KIND.EditProperties, modelForA(), ports);
    expect(calls['openProperties']).toEqual([]);
    // No other flow was launched either.
    expect(calls['dispatchEditDelete']).toEqual([]);
    expect(calls['armEditTool']).toEqual([]);
  });
});

describe('launchMenuItem — flow routing (fr96)', () => {
  it('Delete → the ONE EditDelete funnel', () => {
    const { ports, calls } = makePorts(rootWithA(true));
    launchMenuItem(MENU_ITEM_KIND.Delete, modelForA(), ports);
    expect(calls['dispatchEditDelete']).toHaveLength(1);
  });

  it('DeleteVertex → the vertex funnel with the intent OWN payload', () => {
    const vids = new Set([asVertexId('v1'), asVertexId('v2')]);
    const { ports, calls } = makePorts(rootWithA(true));
    launchMenuItem(MENU_ITEM_KIND.DeleteVertex, modelForA(vids), ports);
    expect(calls['deleteVertices']).toHaveLength(1);
    const [owner, ids] = calls['deleteVertices']![0]!;
    expect(owner).toBe(A);
    expect(ids).toEqual(vids);
  });

  it('Split / 所属変更 / 結合(enabled 時) → the matching edit tool (単一の写像)', () => {
    const { ports, calls } = makePorts(rootWithA(true));
    launchMenuItem(MENU_ITEM_KIND.Split, modelForA(), ports);
    launchMenuItem(MENU_ITEM_KIND.ChangeAffiliation, modelForA(), ports);
    expect(calls['armEditTool']).toEqual([[TOOL_ID.EditKnife], [TOOL_ID.EditReparent]]);
  });

  it('Unshare → the live unshare launcher with the shared subset + owner', () => {
    const vids = new Set([asVertexId('vs')]);
    const { ports, calls } = makePorts(rootWithA(true));
    launchMenuItem(MENU_ITEM_KIND.Unshare, modelForA(vids), ports);
    expect(calls['unshare']).toEqual([[vids, A]]);
  });

  it('a DISABLED item (結合) never fires anything (教訓 5.13 drift guard)', () => {
    const { ports, calls } = makePorts(rootWithA(true));
    launchMenuItem(MENU_ITEM_KIND.Merge, modelForA(), ports);
    for (const key of Object.keys(calls)) expect(calls[key]).toEqual([]);
  });

  it('an item ABSENT from the model never fires anything (stale model guard)', () => {
    const { ports, calls } = makePorts(rootWithA(true));
    const model = modelForA(); // no vertex selection → no DeleteVertex item
    launchMenuItem(MENU_ITEM_KIND.DeleteVertex, model, ports);
    for (const key of Object.keys(calls)) expect(calls[key]).toEqual([]);
  });
});

describe('launchMenuItem — FR-113 個別非表示 (HideFeature, no live-existence guard)', () => {
  /** modelForA + the display-only HideFeature item (frozen at menu open). */
  const modelWithHide = (): ContextMenuModel => {
    const base = modelForA();
    return { ...base, items: [...base.items, enabledItem(MENU_ITEM_KIND.HideFeature)] };
  };

  it('LIVE target: hideFeature fires with the feature id', () => {
    const { ports, calls } = makePorts(rootWithA(true));
    launchMenuItem(MENU_ITEM_KIND.HideFeature, modelWithHide(), ports);
    expect(calls['hideFeature']).toEqual([[A]]);
  });

  it('STALE target: hideFeature STILL fires (display-only; the store reconcile prunes it)', () => {
    // Unlike EditProperties (which no-ops on a stale target), 個別非表示 is a harmless
    // session override — it fires regardless, and reconcileToLiveFeatures drops it later.
    const { ports, calls } = makePorts(rootWithA(false));
    launchMenuItem(MENU_ITEM_KIND.HideFeature, modelWithHide(), ports);
    expect(calls['hideFeature']).toEqual([[A]]);
  });
});
