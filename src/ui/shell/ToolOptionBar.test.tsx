// 編集道具の帯（{@link ToolOptionBar}）の単体テスト。
//
// 実測で見つかった欠陥を釘で留める: **ナイフを構えているのに帯が「✦ 選ぶ」のまま**
// （編集モードの 8 つの道具が 1 つも押し込んでいなかった）。したがって固定するのは
//   1. 構えた道具の名前が帯に出る（既定の「選ぶ」のままにならない）;
//   2. 選んでいる地物の名前と種類が対象欄に出る（設計書 §C.4 の書式）;
//   3. **追加モードでは帯を奪わない**（`AddToolController` が押し込んだ中身が残る）;
//   4. 道具を外す・モードを離れると帯が空へ戻る（教訓 5.2 全経路で破棄）。
//
// 実機でさらに 2 つ穴が見つかったので、それも釘で留める:
//   5. **道具を構えていなくても**（編集モードに入った直後）、地物を選べば対象欄に出る;
//   6. **「所属」「結ぶ」を構えているあいだは対象を押し込まない** ―― この 2 つは自前の
//      選択を持ち、自分で押し込む。ここが毎回 null で上書きすると、その値が消える。
//
// 帯の **見た目** は `OptionBar.test.tsx` が持つので、ここは `OptionBarStore` の
// 中身だけを見る（同じことを 2 か所で測らない）。

/// <reference types="@testing-library/jest-dom" />

import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolOptionBar, describeOptionBarTarget } from './ToolOptionBar';
import { OptionBarStore } from './option-bar';
import { EDIT_TOOL_STRINGS, OPTION_BAR_STRINGS } from './strings';
import { TOOL_ID } from './tools';
import { createSessionStore } from '../state/store';
import { EDIT_MODE, type ActiveFeature, type EditMode, type ToolId } from '../state/session';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createAggregateFeature, createLeafFeature, type Feature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, type FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import { createShape } from '../../domain/ring';
import type { TimePoint } from '../../domain/time/time-point';
import { featureByIdAt } from '../live-lookup';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

/** 面（末端地物）1 件。種別ラベル（FR-40）付き ―― 設計書 §C.4 の例と同じ形。 */
const AAWEN: Feature = createLeafFeature(
  asFeatureId('f-aawen'),
  createBasicAttributes('アアウェン州', 1000, 1100),
  color,
  createShape(),
  { kindLabel: '州' },
);

/** 集約地物 1 件。種別ラベルなし ―― 丸括弧が種類だけになることを見るため。 */
const NORTH: Feature = createAggregateFeature(
  asFeatureId('f-north'),
  createBasicAttributes('正統ノル王国', 1000, 1100),
  color,
  [],
);

const FEATURES: ReadonlyMap<FeatureId, Feature> = new Map<FeatureId, Feature>([
  [AAWEN.id, AAWEN],
  [NORTH.id, NORTH],
]);

/** 「その年に効いている地物を引く」口の代役（本番は `live-lookup` の `featureByIdAt`）。 */
function resolveFeature(
  _domain: Record<string, never>,
  _time: TimePoint,
  featureId: FeatureId,
): Feature | undefined {
  return FEATURES.get(featureId);
}

interface InitialSession {
  readonly mode?: EditMode;
  readonly activeTool?: ToolId | null;
  readonly activeFeature?: ActiveFeature;
}

function makeStore(initial: InitialSession) {
  return createSessionStore<Record<string, never>>({ initialDomain: {}, initial });
}

type TestStore = ReturnType<typeof makeStore>;

/** 部品をマウントし、押し込み先の帯を返す。 */
function mount(store: TestStore): OptionBarStore {
  const optionBar = new OptionBarStore();
  render(
    <ToolOptionBar<Record<string, never>>
      store={store}
      optionBar={optionBar}
      resolveFeature={resolveFeature}
    />,
  );
  return optionBar;
}

describe('ToolOptionBar — 道具名（112px）', () => {
  it('ナイフを構えると帯の道具名がナイフになる（「選ぶ」のままにならない）', () => {
    const store = makeStore({ mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditKnife });
    const optionBar = mount(store);

    expect(optionBar.get().toolName).toBe(EDIT_TOOL_STRINGS.knife);
    // 実測の欠陥そのもの: 既定の「✦ 選ぶ」が出たままになっていない。
    expect(optionBar.get().toolName).not.toBe(OPTION_BAR_STRINGS.defaultToolName);
  });

  it('8 つの編集道具それぞれに名前が出る', () => {
    const table: readonly (readonly [ToolId, string])[] = [
      [TOOL_ID.EditSelect, EDIT_TOOL_STRINGS.select],
      [TOOL_ID.EditVertex, EDIT_TOOL_STRINGS.vertex],
      [TOOL_ID.EditMove, EDIT_TOOL_STRINGS.move],
      [TOOL_ID.EditKnife, EDIT_TOOL_STRINGS.knife],
      [TOOL_ID.EditReparent, EDIT_TOOL_STRINGS.reparent],
      [TOOL_ID.EditMerge, EDIT_TOOL_STRINGS.merge],
      [TOOL_ID.EditRing, EDIT_TOOL_STRINGS.ring],
      [TOOL_ID.EditDrill, EDIT_TOOL_STRINGS.drill],
    ];

    const store = makeStore({ mode: EDIT_MODE.Edit });
    const optionBar = mount(store);

    for (const [tool, name] of table) {
      act(() => {
        store.getState().setActiveTool(tool);
      });
      expect(optionBar.get().toolName).toBe(name);
    }
  });

  it('道具を持ち替えると前の道具の中身は持ち越されない（claim が空へ戻す）', () => {
    const store = makeStore({
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditKnife,
      activeFeature: AAWEN.id,
    });
    const optionBar = mount(store);
    expect(optionBar.get().target.name).toBe('アアウェン州（末端地物・州）');

    // 道具の持ち替えは選択も畳む（`setActiveTool` の reset 契約）ので、対象は空へ戻る。
    act(() => {
      store.getState().setActiveTool(TOOL_ID.EditMerge);
    });
    expect(optionBar.get().toolName).toBe(EDIT_TOOL_STRINGS.merge);
    expect(optionBar.get().target).toEqual({ stage: null, name: null });
  });
});

describe('ToolOptionBar — 対象欄（240px）', () => {
  it('地物を選んでいるとき、対象欄にその名前と種類が出る（設計書 §C.4 の書式）', () => {
    const store = makeStore({
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditSelect,
      activeFeature: AAWEN.id,
    });
    const optionBar = mount(store);

    // 設計書 §C.4 の「アアウェン州（面・州）」と同じ書式。種類の日本語は素性欄と
    // 同じ 1 本（`featureKindJaLabel`）から来るので「末端地物」と出る。
    expect(optionBar.get().target).toEqual({
      stage: null,
      name: 'アアウェン州（末端地物・州）',
    });
  });

  it('種別ラベルが無い地物は種類だけを丸括弧に入れる', () => {
    const store = makeStore({
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditSelect,
      activeFeature: NORTH.id,
    });
    const optionBar = mount(store);

    expect(optionBar.get().target.name).toBe('正統ノル王国（集約地物）');
  });

  it('選んでいなければ押し込まない（器が「（選んでいません）」を出す）', () => {
    const store = makeStore({ mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditSelect });
    const optionBar = mount(store);

    expect(optionBar.get().target).toEqual({ stage: null, name: null });
  });

  it('選択を外すと対象欄も空へ戻る（前の名前が残らない）', () => {
    const store = makeStore({
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditSelect,
      activeFeature: AAWEN.id,
    });
    const optionBar = mount(store);
    expect(optionBar.get().target.name).toBe('アアウェン州（末端地物・州）');

    act(() => {
      store.getState().setActiveFeature(null);
    });
    expect(optionBar.get().target.name).toBeNull();
  });

  it('その年に居ない地物は名前を出さない（内部 id を見せない）', () => {
    const store = makeStore({
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditSelect,
      activeFeature: asFeatureId('f-not-here'),
    });
    const optionBar = mount(store);

    expect(optionBar.get().target.name).toBeNull();
  });
});

describe('ToolOptionBar — 道具を構えていなくても帯を持つ（穴 A）', () => {
  it('編集モードで道具を構えていなくても、地物を選ぶと対象欄に出る', () => {
    // 実機の欠陥そのもの: 編集モードに入った直後（道具は null）に地図や一覧から地物を
    // 選んでも、対象欄が「（選んでいません）」のままだった。
    const store = makeStore({ mode: EDIT_MODE.Edit, activeTool: null });
    const optionBar = mount(store);

    // 帯は持っている。道具名は押し込まず、器の既定（「✦ 選ぶ」）に任せる。
    expect(optionBar.hasOwner()).toBe(true);
    expect(optionBar.get().toolName).toBeNull();
    expect(optionBar.get().target.name).toBeNull();

    act(() => {
      store.getState().setActiveFeature(AAWEN.id);
    });

    expect(optionBar.get().target).toEqual({
      stage: null,
      name: 'アアウェン州（末端地物・州）',
    });
  });

  it('道具を構えていないときに選択を外すと、対象欄も空へ戻る', () => {
    const store = makeStore({
      mode: EDIT_MODE.Edit,
      activeTool: null,
      activeFeature: AAWEN.id,
    });
    const optionBar = mount(store);
    expect(optionBar.get().target.name).toBe('アアウェン州（末端地物・州）');

    act(() => {
      store.getState().setActiveFeature(null);
    });
    expect(optionBar.get().target.name).toBeNull();
  });
});

describe('ToolOptionBar — 自前の選択を持つ道具の対象は押し込まない（穴 B）', () => {
  // 「所属」「結ぶ」は自前の選択（`targetId` / `targetIds`）を持ち、セッションの
  // `activeFeature` を書かない。ここが毎回 null を押し込むと、その道具が入れた値を
  // 消してしまう（押し込みは持ち主を見ない規約）。
  const table: readonly (readonly [ToolId, string])[] = [
    [TOOL_ID.EditReparent, EDIT_TOOL_STRINGS.reparent],
    [TOOL_ID.EditMerge, EDIT_TOOL_STRINGS.merge],
  ];

  for (const [tool, toolName] of table) {
    it(`「${toolName}」を構えているとき、対象は押し込まない（道具名は押し込む）`, () => {
      const store = makeStore({
        mode: EDIT_MODE.Edit,
        activeTool: tool,
        activeFeature: AAWEN.id,
      });
      const optionBar = mount(store);

      // 道具名はこの部品が押し込む（帯の持ち主はこちらのまま）。
      expect(optionBar.get().toolName).toBe(toolName);
      // 対象は押し込まない ―― `activeFeature` が指す地物の名前は出ない。
      expect(optionBar.get().target.name).toBeNull();
    });

    it(`「${toolName}」が自分で入れた対象を、あとから消さない`, () => {
      const store = makeStore({
        mode: EDIT_MODE.Edit,
        activeTool: tool,
        activeFeature: null,
      });
      const optionBar = mount(store);

      // その道具が自分で押し込んだ状態を作る（本番は各コントローラの effect）。
      optionBar.setTarget(null, '道具が入れた対象');

      // セッション側の選択が動いても、押し込んだ値は残る（消されない）。
      act(() => {
        store.getState().setActiveFeature(AAWEN.id);
      });
      expect(optionBar.get().target.name).toBe('道具が入れた対象');

      act(() => {
        store.getState().setActiveFeature(NORTH.id);
      });
      expect(optionBar.get().target.name).toBe('道具が入れた対象');
    });
  }

  it('他の 6 つの道具は今までどおり押し込む（別扱いはこの 2 つだけ）', () => {
    const store = makeStore({
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditKnife,
      activeFeature: AAWEN.id,
    });
    const optionBar = mount(store);

    expect(optionBar.get().target.name).toBe('アアウェン州（末端地物・州）');
  });
});

describe('ToolOptionBar — 追加の道具と喧嘩しない', () => {
  it('追加モードでは claim しない（追加の道具が押し込んだ中身を奪わない）', () => {
    const store = makeStore({ mode: EDIT_MODE.Add, activeTool: TOOL_ID.AddArea });
    const optionBar = new OptionBarStore();

    // 追加の道具が先に帯を持って押し込んだ状態を作る（`AddToolController` と同じ手順）。
    const addOwner = {};
    optionBar.claim(addOwner);
    optionBar.setToolName('▱ 面を描く');
    optionBar.setTarget(null, '頂点 4 個（未確定）');

    render(
      <ToolOptionBar<Record<string, never>>
        store={store}
        optionBar={optionBar}
        resolveFeature={resolveFeature}
      />,
    );

    // 奪っていない ＝ 追加の道具の中身がそのまま残っている。
    expect(optionBar.get().toolName).toBe('▱ 面を描く');
    expect(optionBar.get().target.name).toBe('頂点 4 個（未確定）');
  });

  it('表示専用モードでは何も押し込まない', () => {
    const store = makeStore({ mode: EDIT_MODE.View });
    const optionBar = mount(store);

    expect(optionBar.get().toolName).toBeNull();
    expect(optionBar.hasOwner()).toBe(false);
  });
});

describe('ToolOptionBar — 合成ルートの繋ぎ方（App.tsx が渡す形）', () => {
  it('`live-lookup` の featureByIdAt をそのまま resolveFeature へ渡せる', () => {
    // 合成ルート（App.tsx）は本物のドメイン根と `featureByIdAt` を渡す。ここで同じ形を
    // 1 回組み立てて、**型が合うことと落ちないこと**を留める（渡し方の食い違いは
    // 実行時に「対象欄が黙って空」になるだけで気づけない）。
    const project: DomainProject = {
      histories: [],
      settings: {
        calendarId: 'gregorian',
        geo: createGeoParams(40000, 0.0034),
        gridSpacingDeg: 10,
        snapDistancePx: 50,
        autoColorDefault: true,
      },
      baseMap: {
        source: 's',
        meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
      },
    };
    const store = createSessionStore<DomainProject>({
      initialDomain: project,
      initial: { mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditReparent },
    });
    const optionBar = new OptionBarStore();
    render(
      <ToolOptionBar<DomainProject>
        store={store}
        optionBar={optionBar}
        resolveFeature={featureByIdAt}
      />,
    );

    expect(optionBar.get().toolName).toBe(EDIT_TOOL_STRINGS.reparent);
    // 地物が 1 件も居ない根なので、対象欄は空のまま（器が「（選んでいません）」を出す）。
    expect(optionBar.get().target.name).toBeNull();
  });
});

describe('ToolOptionBar — 降りたら空へ戻る（教訓 5.2）', () => {
  it('道具を外すと中身は空へ戻るが、編集モードのあいだは帯を持ったままにする', () => {
    const store = makeStore({
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditKnife,
      activeFeature: AAWEN.id,
    });
    const optionBar = mount(store);
    expect(optionBar.get().toolName).toBe(EDIT_TOOL_STRINGS.knife);

    act(() => {
      store.getState().setActiveTool(null);
    });

    // 道具名は既定へ戻る。
    expect(optionBar.get().toolName).toBeNull();
    // **対象は残る**（増分 5c で `setActiveTool` の既定が反転した＝`docs/現状.md` B28）。
    // 道具を外しても「いま選んでいる地物」は変わらないので、対象欄も変わらないのが
    // 画面と状態の一致である。旧版はここで選択ごと消えていた。
    expect(optionBar.get().target).toEqual({
      stage: null,
      name: describeOptionBarTarget(AAWEN),
    });
    // **帯は持ったまま**。道具を構えていなくても地物を選べば対象欄に出す必要があるので、
    // 帯を持つ条件は「編集モードであること」に広げてある（穴 A）。
    expect(optionBar.hasOwner()).toBe(true);
  });

  it('編集モードを離れると帯が空へ戻る', () => {
    const store = makeStore({ mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditVertex });
    const optionBar = mount(store);
    expect(optionBar.get().toolName).toBe(EDIT_TOOL_STRINGS.vertex);

    act(() => {
      store.getState().setMode(EDIT_MODE.View);
    });

    expect(optionBar.get().toolName).toBeNull();
    expect(optionBar.hasOwner()).toBe(false);
  });
});
