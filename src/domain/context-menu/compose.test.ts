// U36 — composition tests (受け入れ基準 1,2,3,4,5,7,8,10).
//
// Pure "入力状態 → 操作 → 期待結果" checks for the menu composition: 右クリック
// でメニュー表示条件, オブジェクト種類による出し分け, 共有頂点による出し分け,
// ツール種類による出し分け, 共通/共有/面の項目セット, 表示専用一括無効化, UI 文脈
// 優先と分岐網羅 (生 ID 集合まで).

import { describe, expect, it } from 'vitest';

import {
  CONTEXT_KIND,
  EMPTY_CONTEXT,
  analyzeVertexContext,
  ownerLookupFromMap,
} from '../selection/index';
import { asFeatureId, asVertexId, type FeatureId, type VertexId } from '../ids';
import { FEATURE_KIND, type FeatureKind } from '../feature';

import {
  MENU_TOOL_KIND,
  axisEmphasisLookupFromSet,
  featureKindLookupFromMap,
  sharedLookupFromSet,
  type MenuToolKind,
} from './contracts';
import { DISABLE_REASON, MENU_ITEM_KIND, type MenuItemKind } from './items';
import {
  MENU_TARGET_KIND,
  NO_MENU,
  composeContextMenu,
  resolveMenuTarget,
  type ComposeInput,
  type ContextMenuModel,
} from './compose';

const fid = (s: string): FeatureId => asFeatureId(s);
const vid = (s: string): VertexId => asVertexId(s);
const POS = { x: 100, y: 200 };

interface BuildOpts {
  readonly activeFeature?: FeatureId | null;
  readonly vertexIds?: ReadonlySet<VertexId>;
  readonly kinds?: ReadonlyMap<FeatureId, FeatureKind>;
  readonly owners?: ReadonlyMap<VertexId, FeatureId>;
  readonly shared?: ReadonlySet<VertexId>;
  readonly toolKind?: MenuToolKind;
  readonly canEdit?: boolean;
  readonly hitVertexId?: VertexId | null;
  /** FR-113 Phase 2: the session's per-feature 強調集合 (filter.emphasizedIds). */
  readonly emphasized?: ReadonlySet<FeatureId>;
  /** FR-113 Phase 2: features the 種別/深度軸 already emphasizes (the disabled-item axis). */
  readonly emphasizedByAxis?: ReadonlySet<FeatureId>;
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
    hitVertexId: opts.hitVertexId ?? null,
    position: POS,
    toolKind: opts.toolKind ?? MENU_TOOL_KIND.Select,
    canEdit: opts.canEdit ?? true,
    featureKindLookup: featureKindLookupFromMap(opts.kinds ?? new Map()),
    sharedLookup: sharedLookupFromSet(opts.shared ?? new Set()),
    emphasizedFeatureIds: opts.emphasized ?? new Set<FeatureId>(),
    axisEmphasisLookup: axisEmphasisLookupFromSet(
      opts.emphasizedByAxis ?? new Set<FeatureId>(),
    ),
  };
}

function itemKinds(model: ContextMenuModel): MenuItemKind[] {
  return model.items.map((i) => i.kind);
}

function asMenu(result: ContextMenuModel | typeof NO_MENU): ContextMenuModel {
  expect(result).not.toBe(NO_MENU);
  if (result.kind !== 'menu') throw new Error('expected a menu');
  return result;
}

describe('composeContextMenu — 受け入れ基準 1: メニュー表示条件', () => {
  it('アクティブ地物が1件ある編集モードで右クリックするとメニューが出る', () => {
    const result = composeContextMenu(
      build({ activeFeature: fid('f1'), kinds: new Map([[fid('f1'), FEATURE_KIND.Point]]) }),
    );
    const menu = asMenu(result);
    expect(menu.position).toEqual(POS);
    expect(menu.items.length).toBeGreaterThan(0);
  });

  it('頂点選択セットが非空ならメニューが出る', () => {
    const result = composeContextMenu(
      build({
        vertexIds: new Set([vid('v1')]),
        owners: new Map([[vid('v1'), fid('f1')]]),
        kinds: new Map([[fid('f1'), FEATURE_KIND.Line]]),
      }),
    );
    asMenu(result);
  });

  it('空選択 (アクティブなし・頂点空) ではメニューを出さない', () => {
    expect(composeContextMenu(build({}))).toBe(NO_MENU);
  });
});

describe('composeContextMenu — 受け入れ基準 2: オブジェクト種類による動的変化', () => {
  it('点情報: 共通項目が出て面情報項目が出ない (+ FR-113 個別非表示)', () => {
    const menu = asMenu(
      composeContextMenu(
        build({ activeFeature: fid('p'), kinds: new Map([[fid('p'), FEATURE_KIND.Point]]) }),
      ),
    );
    // 共通 (削除・プロパティ編集) + 表示制御 (個別非表示・強調, 常に末尾). 面情報項目 (分割等) は出ない。
    expect(itemKinds(menu)).toEqual([
      MENU_ITEM_KIND.Delete,
      MENU_ITEM_KIND.EditProperties,
      MENU_ITEM_KIND.HideFeature,
      MENU_ITEM_KIND.EmphasizeFeature,
    ]);
  });

  it('線情報: 共通項目のみ、面情報項目なし', () => {
    const menu = asMenu(
      composeContextMenu(
        build({ activeFeature: fid('l'), kinds: new Map([[fid('l'), FEATURE_KIND.Line]]) }),
      ),
    );
    expect(itemKinds(menu)).not.toContain(MENU_ITEM_KIND.Split);
    expect(itemKinds(menu)).not.toContain(MENU_ITEM_KIND.ChangeAffiliation);
    expect(itemKinds(menu)).not.toContain(MENU_ITEM_KIND.Merge);
  });

  it('面情報(末端=leaf): 共通項目 + 分割・所属変更・結合', () => {
    const menu = asMenu(
      composeContextMenu(
        build({ activeFeature: fid('a'), kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]) }),
      ),
    );
    const ks = itemKinds(menu);
    expect(ks).toContain(MENU_ITEM_KIND.Delete);
    expect(ks).toContain(MENU_ITEM_KIND.EditProperties);
    expect(ks).toContain(MENU_ITEM_KIND.Split);
    expect(ks).toContain(MENU_ITEM_KIND.ChangeAffiliation);
    expect(ks).toContain(MENU_ITEM_KIND.Merge);
  });

  it('集約地物: 分割が出ない (末端限定, FR-44/FR-35, 教訓 5.25)', () => {
    const menu = asMenu(
      composeContextMenu(
        build({ activeFeature: fid('g'), kinds: new Map([[fid('g'), FEATURE_KIND.Aggregate]]) }),
      ),
    );
    expect(itemKinds(menu)).not.toContain(MENU_ITEM_KIND.Split);
    // 共通項目は集約でも出る。
    expect(itemKinds(menu)).toContain(MENU_ITEM_KIND.Delete);
  });
});

describe('composeContextMenu — 受け入れ基準 3: 共有頂点による動的変化', () => {
  it('選択セットに共有頂点が含まれるとき共有解除が出る', () => {
    const menu = asMenu(
      composeContextMenu(
        build({
          activeFeature: fid('a'),
          kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
          vertexIds: new Set([vid('v1'), vid('v2')]),
          owners: new Map([
            [vid('v1'), fid('a')],
            [vid('v2'), fid('a')],
          ]),
          shared: new Set([vid('v2')]),
        }),
      ),
    );
    expect(itemKinds(menu)).toContain(MENU_ITEM_KIND.Unshare);
  });

  it('共有頂点を含まないとき共有解除は出ない', () => {
    const menu = asMenu(
      composeContextMenu(
        build({
          activeFeature: fid('a'),
          kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
          vertexIds: new Set([vid('v1')]),
          owners: new Map([[vid('v1'), fid('a')]]),
          shared: new Set(),
        }),
      ),
    );
    expect(itemKinds(menu)).not.toContain(MENU_ITEM_KIND.Unshare);
  });

  it('共有判定は注入された lookup から取得する (再判定しない)', () => {
    const calls: VertexId[] = [];
    const input = build({
      vertexIds: new Set([vid('v1')]),
      owners: new Map([[vid('v1'), fid('a')]]),
      kinds: new Map([[fid('a'), FEATURE_KIND.Line]]),
    });
    const probed: ComposeInput = {
      ...input,
      sharedLookup: {
        isShared: (v) => {
          calls.push(v);
          return false;
        },
      },
    };
    composeContextMenu(probed);
    expect(calls).toEqual([vid('v1')]);
  });
});

describe('composeContextMenu — 受け入れ基準 4: ツール種類による動的変化', () => {
  it('ナイフツール中は冗長な分割項目を落とす (項目集合がツールで変わる)', () => {
    const leaf = { activeFeature: fid('a'), kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]) };
    const selectMenu = asMenu(
      composeContextMenu(build({ ...leaf, toolKind: MENU_TOOL_KIND.Select })),
    );
    const knifeMenu = asMenu(
      composeContextMenu(build({ ...leaf, toolKind: MENU_TOOL_KIND.Knife })),
    );
    expect(itemKinds(selectMenu)).toContain(MENU_ITEM_KIND.Split);
    expect(itemKinds(knifeMenu)).not.toContain(MENU_ITEM_KIND.Split);
    // 所属変更・結合はツールに関係なく残る。
    expect(itemKinds(knifeMenu)).toContain(MENU_ITEM_KIND.ChangeAffiliation);
  });
});

describe('composeContextMenu — 受け入れ基準 5: 項目の種別識別子が型/定数経由で一意', () => {
  it('全項目の kind は MENU_ITEM_KIND の値で重複しない', () => {
    const menu = asMenu(
      composeContextMenu(
        build({
          activeFeature: fid('a'),
          kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
          vertexIds: new Set([vid('v1')]),
          owners: new Map([[vid('v1'), fid('a')]]),
          shared: new Set([vid('v1')]),
        }),
      ),
    );
    const ks = itemKinds(menu);
    expect(new Set(ks).size).toBe(ks.length);
    const known = new Set<MenuItemKind>(Object.values(MENU_ITEM_KIND));
    for (const k of ks) expect(known.has(k)).toBe(true);
  });

  it('結合は出るが無効 (グレーアウト) で日本語の無効理由を持つ', () => {
    const menu = asMenu(
      composeContextMenu(
        build({ activeFeature: fid('a'), kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]) }),
      ),
    );
    const merge = menu.items.find((i) => i.kind === MENU_ITEM_KIND.Merge);
    expect(merge?.enabled).toBe(false);
    if (merge && !merge.enabled) {
      expect(typeof merge.disableReason).toBe('string');
    }
  });
});

describe('composeContextMenu — 受け入れ基準 7: 表示専用モードの一括無効化', () => {
  it('canEdit=false なら編集項目を一括無効化する (削除/編集/分割/共有解除は出さない)', () => {
    const menu = asMenu(
      composeContextMenu(
        build({
          canEdit: false,
          activeFeature: fid('a'),
          kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
          vertexIds: new Set([vid('v1')]),
          owners: new Map([[vid('v1'), fid('a')]]),
          shared: new Set([vid('v1')]),
        }),
      ),
    );
    // 教訓 5.13: EDIT 項目は表示専用モードで一括無効化 — 一切出さない。
    const ks = itemKinds(menu);
    expect(ks).not.toContain(MENU_ITEM_KIND.Delete);
    expect(ks).not.toContain(MENU_ITEM_KIND.DeleteVertex);
    expect(ks).not.toContain(MENU_ITEM_KIND.EditProperties);
    expect(ks).not.toContain(MENU_ITEM_KIND.Split);
    expect(ks).not.toContain(MENU_ITEM_KIND.Unshare);
  });

  it('FR-113: 表示専用モードでも「個別非表示」(表示専用の操作) だけは出る (ユーザー裁定 View でも可)', () => {
    const menu = asMenu(
      composeContextMenu(
        build({
          canEdit: false,
          activeFeature: fid('a'),
          kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
        }),
      ),
    );
    // 個別非表示・強調 は表示状態のみ変える (ドメイン非改変) ので View でも可 — 唯一残る項目群。
    expect(itemKinds(menu)).toEqual([
      MENU_ITEM_KIND.HideFeature,
      MENU_ITEM_KIND.EmphasizeFeature,
    ]);
  });

  it('表示専用モード + 対象解決不能 (アクティブなし・頂点空) はメニューを出さない', () => {
    // 個別非表示 も対象地物が要る — 何も選択が無ければ表示専用でも NO_MENU。
    expect(composeContextMenu(build({ canEdit: false }))).toBe(NO_MENU);
  });
});

// FR-113 Phase 2 — 右クリック「この地物を強調」/「強調を解除」. Symmetric with 個別非表示:
// a DISPLAY-only op, offered even in 表示専用モード, for any resolvable single-feature target.
// The pair is MUTUALLY EXCLUSIVE and keyed on the session's per-feature 強調集合 so the offered
// item always names what actually happens (出す=起きる, 教訓 5.6).
describe('composeContextMenu — FR-113 Phase 2: 強調項目の動的出し分け', () => {
  const leafOpts = { activeFeature: fid('a'), kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]) };

  it('非強調の地物には「この地物を強調」だけが出る', () => {
    const ks = itemKinds(asMenu(composeContextMenu(build(leafOpts))));
    expect(ks).toContain(MENU_ITEM_KIND.EmphasizeFeature);
    expect(ks).not.toContain(MENU_ITEM_KIND.UnemphasizeFeature);
  });

  it('既に強調中の地物には「強調を解除」だけが出る (排他)', () => {
    const ks = itemKinds(
      asMenu(composeContextMenu(build({ ...leafOpts, emphasized: new Set([fid('a')]) }))),
    );
    expect(ks).toContain(MENU_ITEM_KIND.UnemphasizeFeature);
    expect(ks).not.toContain(MENU_ITEM_KIND.EmphasizeFeature);
  });

  // --- 種別/深度軸で既に強調されている対象 (出す≠起きる の潰し込み) ---------------------
  //
  // The item writes the PER-FEATURE集合 only. If the 面 種別強調 already emphasizes the target,
  // adding it to (or removing it from) that set dims/undims NOTHING — an enabled item would
  // promise an effect that never happens. It must be shown DISABLED with the reason instead.
  it('種別/深度軸で既に強調されている対象では「この地物を強調」が無効化され理由が付く', () => {
    const model = asMenu(
      composeContextMenu(build({ ...leafOpts, emphasizedByAxis: new Set([fid('a')]) })),
    );
    const item = model.items.find((i) => i.kind === MENU_ITEM_KIND.EmphasizeFeature);
    expect(item).toBeDefined();
    expect(item?.enabled).toBe(false);
    expect(item?.enabled === false ? item.disableReason : null).toBe(
      DISABLE_REASON.EmphasisFromOtherAxis,
    );
  });

  it('個別強調 ∧ 種別/深度軸強調 の重なりでは「強調を解除」が無効化される (押しても何も変わらないため)', () => {
    const model = asMenu(
      composeContextMenu(
        build({
          ...leafOpts,
          emphasized: new Set([fid('a')]),
          emphasizedByAxis: new Set([fid('a')]),
        }),
      ),
    );
    const item = model.items.find((i) => i.kind === MENU_ITEM_KIND.UnemphasizeFeature);
    expect(item?.enabled).toBe(false);
    expect(item?.enabled === false ? item.disableReason : null).toBe(
      DISABLE_REASON.EmphasisFromOtherAxis,
    );
    // 排他は保たれる — 無効化されても「この地物を強調」は出ない.
    expect(itemKinds(model)).not.toContain(MENU_ITEM_KIND.EmphasizeFeature);
  });

  it('軸強調が別地物にだけ効いている場合は対象の強調項目は有効なまま', () => {
    const model = asMenu(
      composeContextMenu(build({ ...leafOpts, emphasizedByAxis: new Set([fid('other')]) })),
    );
    expect(model.items.find((i) => i.kind === MENU_ITEM_KIND.EmphasizeFeature)?.enabled).toBe(
      true,
    );
  });

  it('軸強調は個別非表示項目には影響しない (別概念 — 非表示は常に有効)', () => {
    const model = asMenu(
      composeContextMenu(build({ ...leafOpts, emphasizedByAxis: new Set([fid('a')]) })),
    );
    expect(model.items.find((i) => i.kind === MENU_ITEM_KIND.HideFeature)?.enabled).toBe(true);
  });

  it('強調判定は対象地物の id で行う (別地物の強調は影響しない)', () => {
    const ks = itemKinds(
      asMenu(composeContextMenu(build({ ...leafOpts, emphasized: new Set([fid('other')]) }))),
    );
    expect(ks).toContain(MENU_ITEM_KIND.EmphasizeFeature);
  });

  it('表示専用モードでも強調項目は出る (ドメイン非改変, 個別非表示と対称)', () => {
    const ks = itemKinds(asMenu(composeContextMenu(build({ ...leafOpts, canEdit: false }))));
    expect(ks).toContain(MENU_ITEM_KIND.EmphasizeFeature);
  });

  it('単一所有 VertexOnly でも強調項目が出る (個別非表示と同じ対象解決)', () => {
    const ks = itemKinds(
      asMenu(
        composeContextMenu(
          build({
            vertexIds: new Set([vid('v1')]),
            owners: new Map([[vid('v1'), fid('a')]]),
            kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
          }),
        ),
      ),
    );
    expect(ks).toContain(MENU_ITEM_KIND.EmphasizeFeature);
  });

  it('対象地物が解決できない選択では強調項目を出さない (出す=発火できる)', () => {
    // 複数所有者の頂点選択 = 単一地物を名指せない → 表示制御項目は出ない。
    const result = composeContextMenu(
      build({
        canEdit: false,
        vertexIds: new Set([vid('v1'), vid('v2')]),
        owners: new Map([
          [vid('v1'), fid('a')],
          [vid('v2'), fid('b')],
        ]),
        kinds: new Map([
          [fid('a'), FEATURE_KIND.Leaf],
          [fid('b'), FEATURE_KIND.Leaf],
        ]),
      }),
    );
    expect(result).toBe(NO_MENU);
  });
});

describe('resolveMenuTarget / compose — 受け入れ基準 8: UI 文脈優先と分岐網羅', () => {
  it('アクティブ地物があればそれを対象 (生の値で評価)', () => {
    const t = resolveMenuTarget(
      build({ activeFeature: fid('a'), kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]) }),
    );
    expect(t.kind).toBe(MENU_TARGET_KIND.Feature);
    if (t.kind === MENU_TARGET_KIND.Feature) expect(t.featureId).toBe(fid('a'));
  });

  it('アクティブなし・単一所有頂点コンテキスト → その地物を対象', () => {
    const t = resolveMenuTarget(
      build({
        vertexIds: new Set([vid('v1'), vid('v2')]),
        owners: new Map([
          [vid('v1'), fid('a')],
          [vid('v2'), fid('a')],
        ]),
        kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
      }),
    );
    expect(t.kind).toBe(MENU_TARGET_KIND.VertexOnly);
    if (t.kind === MENU_TARGET_KIND.VertexOnly) expect(t.ownerFeatureId).toBe(fid('a'));
  });

  it('単一所有 VertexOnly では 地物全体削除でなく 頂点を削除 を出す (乖離解消) + 他の地物項目', () => {
    // FR-96: VertexOnly (アクティブ地物なし) では live削除ファネルが選択頂点を消すため、
    // 地物削除を意味する 削除 は出さず、頂点を削除 を出す (乖離解消)。プロパティ編集/分割/
    // 所属変更/結合は所有地物へ直接発火するので残る。
    const menu = asMenu(
      composeContextMenu(
        build({
          vertexIds: new Set([vid('v1')]),
          owners: new Map([[vid('v1'), fid('a')]]),
          kinds: new Map([[fid('a'), FEATURE_KIND.Leaf]]),
        }),
      ),
    );
    const ks = itemKinds(menu);
    expect(ks).not.toContain(MENU_ITEM_KIND.Delete);
    expect(ks).toContain(MENU_ITEM_KIND.DeleteVertex);
    expect(ks).toContain(MENU_ITEM_KIND.EditProperties);
    expect(ks).toContain(MENU_ITEM_KIND.Split);
    expect(ks).toContain(MENU_ITEM_KIND.ChangeAffiliation);
  });

  it('所有者複数 (owner 不確定) では共有解除を出さない → 項目0件 → メニューなし (owner-null dangling guard)', () => {
    // 共有解除は OWNER-QUALIFIED: 確定した所有者がいなければ選択の再解決が remap できない
    // ため、多所有選択にはメニューを出さない (FR-96 owner-null 対策)。
    const result = composeContextMenu(
      build({
        vertexIds: new Set([vid('v1'), vid('v2')]),
        owners: new Map([
          [vid('v1'), fid('a')],
          [vid('v2'), fid('b')],
        ]),
        kinds: new Map([
          [fid('a'), FEATURE_KIND.Leaf],
          [fid('b'), FEATURE_KIND.Leaf],
        ]),
        shared: new Set([vid('v1')]),
      }),
    );
    expect(result).toBe(NO_MENU);
  });

  it('所有者複数かつ共有頂点なし → 項目0件 → メニューなし', () => {
    const result = composeContextMenu(
      build({
        vertexIds: new Set([vid('v1'), vid('v2')]),
        owners: new Map([
          [vid('v1'), fid('a')],
          [vid('v2'), fid('b')],
        ]),
        kinds: new Map([
          [fid('a'), FEATURE_KIND.Leaf],
          [fid('b'), FEATURE_KIND.Leaf],
        ]),
        shared: new Set(),
      }),
    );
    expect(result).toBe(NO_MENU);
  });

  it('所有者不明 (dangling vertex) は Unknown 扱い → owner 不確定なので共有解除も出ない → メニューなし', () => {
    const input = build({
      vertexIds: new Set([vid('v1')]),
      owners: new Map(), // 解決不能 → Unknown
      shared: new Set([vid('v1')]),
    });
    expect(input.vertexContext.kind).toBe(CONTEXT_KIND.Unknown);
    // OWNER-QUALIFIED 共有解除: 所有者不明では剥がす参照を確定できないため出さない。
    expect(composeContextMenu(input)).toBe(NO_MENU);
  });

  it('アクティブ地物が解決できない場合は対象なし (既定へ落ちない, 教訓 5.4)', () => {
    const result = composeContextMenu(build({ activeFeature: fid('ghost'), kinds: new Map() }));
    expect(result).toBe(NO_MENU);
  });
});
