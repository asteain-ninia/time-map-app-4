// U36 — compose ↔ dispatch CONSISTENCY invariant (出す=発火できる, 教訓 5.6) and
// the structure-change → U22 re-resolution bridge (受け入れ基準 12, 教訓 5.11).
//
// The core drift this fixes: the composer must never offer an ENABLED item that
// the pure dispatch then refuses for a missing target. This file drives the REAL
// composer over every actionable selection state and asserts every enabled item
// dispatches to an intent (never a NoFeatureTarget / NoSharedVertices block).

import { describe, expect, it } from 'vitest';

import {
  EMPTY_CONTEXT,
  analyzeVertexContext,
  ownerLookupFromMap,
} from '../selection/index';
import { reresolveAfterStructureChange } from '../selection/reresolve';
import { EMPTY_SELECTION, replaceVertices, withActiveFeature } from '../selection/state';
import { createCommandResult } from '../command/result';
import { asFeatureId, asVertexId, type FeatureId, type VertexId } from '../ids';
import { FEATURE_KIND, type FeatureKind } from '../feature';

import {
  MENU_TOOL_KIND,
  FLOW_KIND,
  featureKindLookupFromMap,
  sharedLookupFromSet,
  type MenuToolKind,
} from './contracts';
import { composeContextMenu, NO_MENU, type ComposeInput } from './compose';
import { dispatchMenuItem, isBlocked, DISPATCH_BLOCKED_KIND } from './dispatch';
import { nextTargetPreferenceFor, bridgeReresolve } from './reresolve-bridge';

const fid = (s: string): FeatureId => asFeatureId(s);
const vid = (s: string): VertexId => asVertexId(s);
const POS = { x: 0, y: 0 };

interface BuildOpts {
  readonly activeFeature?: FeatureId | null;
  readonly vertexIds?: ReadonlySet<VertexId>;
  readonly kinds?: ReadonlyMap<FeatureId, FeatureKind>;
  readonly owners?: ReadonlyMap<VertexId, FeatureId>;
  readonly shared?: ReadonlySet<VertexId>;
  readonly toolKind?: MenuToolKind;
}

function build(opts: BuildOpts): ComposeInput {
  const vertexIds = opts.vertexIds ?? new Set<VertexId>();
  const ownerLookup = ownerLookupFromMap(opts.owners ?? new Map());
  const vertexContext =
    vertexIds.size === 0 ? EMPTY_CONTEXT : analyzeVertexContext(vertexIds, ownerLookup);
  return {
    activeFeature: opts.activeFeature ?? null,
    vertexIds,
    vertexContext,
    hitVertexId: null,
    position: POS,
    toolKind: opts.toolKind ?? MENU_TOOL_KIND.Select,
    canEdit: true,
    featureKindLookup: featureKindLookupFromMap(opts.kinds ?? new Map()),
    sharedLookup: sharedLookupFromSet(opts.shared ?? new Set()),
  };
}

// Every actionable selection state the composer can produce a menu for.
const CASES: ReadonlyArray<{ readonly name: string; readonly input: ComposeInput }> = [
  {
    name: 'active point',
    input: build({ activeFeature: fid('p'), kinds: new Map([[fid('p'), FEATURE_KIND.Point]]) }),
  },
  {
    name: 'active line',
    input: build({ activeFeature: fid('l'), kinds: new Map([[fid('l'), FEATURE_KIND.Line]]) }),
  },
  {
    name: 'active leaf (full leaf items)',
    input: build({ activeFeature: fid('a'), kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]) }),
  },
  {
    name: 'active aggregate',
    input: build({ activeFeature: fid('g'), kinds: new Map([[fid('g'), FEATURE_KIND.Aggregate]]) }),
  },
  {
    name: 'active leaf with shared vertex (unshare offered)',
    input: build({
      activeFeature: fid('a'),
      kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
      vertexIds: new Set([vid('v1'), vid('v2')]),
      owners: new Map([
        [vid('v1'), fid('a')],
        [vid('v2'), fid('a')],
      ]),
      shared: new Set([vid('v2')]),
    }),
  },
  {
    name: 'single-owner vertex context (leaf) — no active feature',
    input: build({
      vertexIds: new Set([vid('v1'), vid('v2')]),
      owners: new Map([
        [vid('v1'), fid('a')],
        [vid('v2'), fid('a')],
      ]),
      kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
      shared: new Set([vid('v2')]),
    }),
  },
  {
    name: 'single-owner vertex context (line)',
    input: build({
      vertexIds: new Set([vid('v1')]),
      owners: new Map([[vid('v1'), fid('a')]]),
      kinds: new Map([[fid('a'), FEATURE_KIND.Line]]),
    }),
  },
  // NOTE: multi-owner / unknown-owner shared selections are NO LONGER actionable menus
  // (共有解除 is owner-qualified; without a confirmed owner the composer returns NO_MENU),
  // so they are not among the CASES the "every enabled item dispatches" invariant scans.
];

describe('compose ↔ dispatch — 出す=発火できる (受け入れ基準 5.6/6/8, drift なし)', () => {
  for (const { name, input } of CASES) {
    it(`every ENABLED item dispatches (never a missing-target block): ${name}`, () => {
      const model = composeContextMenu(input);
      expect(model).not.toBe(NO_MENU);
      if (model.kind !== 'menu') return;
      for (const item of model.items) {
        if (!item.enabled) continue;
        const r = dispatchMenuItem(item.kind, model);
        // The two "missing target" blocks are the drift this fixes: an enabled
        // item must never hit them.
        if (isBlocked(r)) {
          expect(r.blocked).not.toBe(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
          expect(r.blocked).not.toBe(DISPATCH_BLOCKED_KIND.NoSharedVertices);
          // Any block at all is a failure for an enabled item.
          throw new Error(`enabled item ${item.kind} blocked: ${r.blocked}`);
        }
      }
    });
  }
});

describe('受け入れ基準 12: 構造変更後の選択再解決の橋渡し (教訓 5.11)', () => {
  it('削除完了: 削除された対象がプルーンされ、固定全クリアにならない', () => {
    // 選択 = active feature 'a' + 別の頂点選択 'b'/{v1}; 削除対象 'a'。
    const before = replaceVertices(
      withActiveFeature(EMPTY_SELECTION, fid('a')),
      fid('b'),
      new Set([vid('v1')]),
    );
    const intent = { kind: FLOW_KIND.Delete, featureId: fid('a'), featureKind: FEATURE_KIND.Leaf };
    const result = createCommandResult({ deleted: [fid('a')], survived: [fid('b'), vid('v1')] });
    const { preference } = bridgeReresolve(intent, result);
    const after = reresolveAfterStructureChange(before, result, preference);
    // 削除された active はプルーン、生存している頂点選択は残る (全クリアでない)。
    expect(after.activeFeature).toBeNull();
    expect(after.vertexOwner).toBe(fid('b'));
    expect(after.vertexIds).toEqual(new Set([vid('v1')]));
  });

  it('所属変更完了: 対象地物は生存し active として保持される', () => {
    const before = withActiveFeature(EMPTY_SELECTION, fid('a'));
    const intent = {
      kind: FLOW_KIND.ChangeAffiliation,
      featureId: fid('a'),
      featureKind: FEATURE_KIND.Leaf,
    };
    const result = createCommandResult({ survived: [fid('a')] });
    const { preference } = bridgeReresolve(intent, result);
    const after = reresolveAfterStructureChange(before, result, preference);
    expect(after.activeFeature).toBe(fid('a'));
  });

  it('分割完了: 起点が生存すれば次対象として保持される', () => {
    const before = withActiveFeature(EMPTY_SELECTION, fid('a'));
    const intent = { kind: FLOW_KIND.Split, featureId: fid('a') };
    // 起点 'a' が片割れとして生存し、新ピース 'a2' が生成。
    const result = createCommandResult({ survived: [fid('a')], created: [fid('a2')] });
    const after = reresolveAfterStructureChange(before, result, nextTargetPreferenceFor(intent));
    expect(after.activeFeature).toBe(fid('a'));
  });

  it('結合完了: 起点が消費されたら active はプルーンされる (shell が created を再選択)', () => {
    const before = withActiveFeature(EMPTY_SELECTION, fid('seed'));
    const intent = { kind: FLOW_KIND.Merge, seedFeatureId: fid('seed') };
    // 起点 'seed' は結合先 'merged' に吸収され削除。
    const result = createCommandResult({ deleted: [fid('seed')], created: [fid('merged')] });
    const after = reresolveAfterStructureChange(before, result, nextTargetPreferenceFor(intent));
    // 起点はプルーン (preference は生存しないので昇格されない)。固定全クリアでない:
    // created 'merged' は result に残り shell が選び直せる。
    expect(after.activeFeature).toBeNull();
    expect(result.created.has(fid('merged'))).toBe(true);
  });

  it('共有解除: bridge は空の preference を返す (剥がした新 id を知らない → launcher が remap)', () => {
    // OWNER-QUALIFIED unshare は所有者に新 id v' を与える。bridge は intent から新 id を
    // 名指せないため空を返し、実際の remap は live-unshare が行う (reresolve-bridge.ts 参照)。
    const intent = {
      kind: FLOW_KIND.Unshare,
      vertexIds: new Set([vid('v1')]),
      ownerFeatureId: fid('a'),
    };
    expect(nextTargetPreferenceFor(intent)).toEqual({});
    // 空 preference + 削除なし → 既存選択はプルーンのみで維持される (固定全クリアでない)。
    const before = replaceVertices(EMPTY_SELECTION, fid('a'), new Set([vid('v1')]));
    const result = createCommandResult({ survived: [fid('a')], created: [vid('v1b')] });
    const after = reresolveAfterStructureChange(before, result, nextTargetPreferenceFor(intent));
    expect(after.vertexOwner).toBe(fid('a'));
    expect(after.vertexIds).toEqual(new Set([vid('v1')]));
  });

  it('プロパティ編集: 構造変更でないので preference は空', () => {
    expect(
      nextTargetPreferenceFor({
        kind: FLOW_KIND.EditProperties,
        featureId: fid('a'),
        featureKind: FEATURE_KIND.Leaf,
      }),
    ).toEqual({});
  });
});
