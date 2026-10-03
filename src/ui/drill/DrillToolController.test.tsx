// U27 — CROSS-LAYER INTEGRATION test (FR-45 穴あけによる新地物生成).
//
// The domain core (checkDrillable / drillRegion / assembleDrillProposal / toEditProposal)
// is covered in isolation under src/domain/drill. THIS test is the layer-crossing
// verification the lens flags as missing: it mounts the REAL DrillToolController over
// ONE session store and drives the whole flow through the actual UI —
//   - FR-45: tool select → target末端 click (LEAF gate + selection promotion) → region
//     vertex clicks → 穴あけを確定 → 新地物プロパティ入力 (U23 AddPropertyForm re-use) →
//     save runs drillRegion, adapts the proposal to EditProposal<DrillSnapshot>, and
//     drives the injected U13 process (the COMPLETE trigger is wired and fires — 教訓 5.7);
//     the snapshot carries BOTH the holed original AND the new feature (2 地物 1 undo);
//   - a DrillRejected surfaces the domain's Japanese message and does NOT confirm (教訓 5.22);
//   - the transient draft is discarded on every exit path (Escape / tool switch) and the
//     region overlay is pushed to the sink + cleared on discard (教訓 5.2);
//   - the END-TO-END domain commit (through the REAL createLiveDrillBinding) creates a new
//     feature history + keeps the holed original as ONE undo unit.
//
// Runs in jsdom: the renderer transform + draw sink are faked; the WIRING under test is
// the production component graph.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import {
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Command } from '../../domain/command/command';
import { EMPTY_COMMAND_RESULT } from '../../domain/command/result';
import { createLeafFeature, type Feature, type LeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore, type VertexStore } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import type { DrillSnapshot } from '../../domain/drill/index';

import { AddDraftForm } from '../add/AddPropertyForm';
import { AddDraftStore } from '../add/add-draft-store';
import { OptionBar } from '../shell/OptionBar';
import { OptionBarStore } from '../shell/option-bar';
import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import {
  DrillToolController,
  type DrillDrawSink,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './DrillToolController';
import { DRILL_STRINGS } from './strings';

// --- Fixtures ---------------------------------------------------------------

type S = { tag: string };
const NEXT_STATE: S = { tag: 'committed' };

const noopCommand: Command<S> = {
  kind: 'composite' as Command<S>['kind'],
  label: 'drill',
  execute: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
  undo: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
  redo: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
};

const committed: ProcessResult<S> = {
  status: PROCESS_STATUS.Committed,
  state: NEXT_STATE,
  command: noopCommand,
};

/** A U13 outcome that REJECTS the drill (増分 5 の手直し B3 の断りの経路)。 */
const rejectedResult: ProcessResult<S> = {
  status: PROCESS_STATUS.Rejected,
  kind: 'time-violation',
  message: 'この穴あけは受け付けられません。',
};

/** A U13 outcome that pauses the session for the U35 conflict flow (FR-62). */
const conflictsPending: ProcessResult<S> = {
  status: PROCESS_STATUS.ConflictsPending,
  conflicts: [],
  unresolvedConflictIds: [],
  trialState: NEXT_STATE,
};

const ATTRS = createBasicAttributes('target', 0, 100);
const COLOR = createColorInfo(true, '#fff', '#0f0', '#000');
const DEFAULT_COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

const TARGET_ID = asFeatureId('leaf');

/** Build a single-territory leaf on TARGET_ID from an explicit coordinate ring. */
function leafFrom(
  outer: readonly ReturnType<typeof createCoordinate>[],
): { feature: LeafFeature; store: VertexStore } {
  const outerVids = outer.map((_, i) => asVertexId(`ov-${i}`));
  const vertices = outer.map((c, i) => createVertex(outerVids[i]!, c));
  const territory = createTerritoryRing(asRingId('tr-0'), outerVids);
  const feature = createLeafFeature(TARGET_ID, ATTRS, COLOR, createShape([territory]));
  return { feature, store: createVertexStore(vertices) };
}

/** A solid [0,20]² territory leaf + its store (no hole, so an inside region drills). */
function targetLeaf(): { feature: LeafFeature; store: VertexStore } {
  return leafFrom([
    createCoordinate(0, 0),
    createCoordinate(20, 0),
    createCoordinate(20, 20),
    createCoordinate(0, 20),
  ]);
}

/**
 * 経度 −170°〜170° に広がる横長の面 (緯度は [0,20])。途中に頂点があるので 1 辺はどれも
 * 90 度以下 ―― この面自体は保存できる。だが穴をあけると、集合演算が一直線上に並ぶ途中の
 * 頂点を落とすので、穴と関係の無い外周が「1 本で 340 度」に化ける (N-51)。
 */
function wideTargetLeaf(): { feature: LeafFeature; store: VertexStore } {
  return leafFrom([
    createCoordinate(-170, 0),
    createCoordinate(-90, 0),
    createCoordinate(0, 0),
    createCoordinate(90, 0),
    createCoordinate(170, 0),
    createCoordinate(170, 20),
    createCoordinate(90, 20),
    createCoordinate(0, 20),
    createCoordinate(-90, 20),
    createCoordinate(-170, 20),
  ]);
}

// Identity screen→world so a click at (clientX, clientY) lands at world (x, y).
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

let counter = 0;
const ids = () => ({
  nextFeatureId: () => asFeatureId(`nf-${counter++}`),
  nextRingId: () => asRingId(`nr-${counter++}`),
  nextVertexId: () => asVertexId(`nv-${counter++}`),
});

interface Harness {
  readonly store: StoreApi<SessionStore<S>>;
  readonly startProcess: ReturnType<typeof vi.fn>;
  readonly drawSink: DrillDrawSink & { batches: number[] };
  /** 帯（オプションバー）―― 確定欄・次の一手・対象欄はここに出る（設計書 §C.4）。 */
  readonly optionBar: OptionBarStore;
  /** 右パネルへの橋 ―― 新地物の素性入力はここを通って「新規の姿」になる。 */
  readonly addDraft: AddDraftStore;
  readonly unmount: () => void;
}

function mountDrill(
  outcome: ProcessResult<S> = committed,
  fixture: { feature: LeafFeature; store: VertexStore } = targetLeaf(),
): Harness {
  const { feature, store: vstore } = fixture;
  const store = createSessionStore<S>({
    initialDomain: { tag: 'initial' },
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });

  const startProcess = vi.fn((): ProcessResult<S> => outcome);

  const batches: number[] = [];
  const drawSink: DrillDrawSink & { batches: number[] } = {
    batches,
    drawDrill(prims) {
      batches.push(prims.length);
    },
  };

  const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
    fid === TARGET_ID ? feature : undefined;
  const resolveStore = (): VertexStore => vstore;
  // Clicking anywhere inside [0,20]² resolves the target; outside → miss.
  const featureAtPoint: FeatureAtPoint = (p) =>
    p.lon >= 0 && p.lon <= 20 && p.lat >= 0 && p.lat <= 20 ? TARGET_ID : null;

  // **増分 5d: 確定の列はオプションバーの確定欄に出る**ので、帯も一緒に載せる
  // （検査の都合ではなく、実物がそうなっている）。
  const optionBar = new OptionBarStore();
  // **司令塔の決定 (5): 新地物の素性入力は右パネルの「新規の姿」で受ける**（設計書
  // §B.5 の台帳 #9 / §C.2 の 27）。地図の中央の板（`drill-props` の中身）は消したので、
  // **`AddDraftForm` を一緒に載せないと `add-property-form` が DOM に現れない** ――
  // これは検査の都合ではなく、**実物がそうなっている**（合成ルート `App.tsx` は
  // `addDraftStore` を 1 つ持ち、道具と右パネルの両方へ渡している）。渡さない形で
  // 検査すると「素性を入れる局面なのに入力の口が無い」という、実機には存在しない
  // 状態を固定してしまう。
  const addDraft = new AddDraftStore();
  const utils = render(
    <>
      <OptionBar store={optionBar} />
      <AddDraftForm store={addDraft} />
      <DrillToolController<S>
        optionBar={optionBar}
        store={store}
        addDraft={addDraft}
        startProcess={startProcess}
        ids={ids()}
        resolveFeature={resolveFeature}
        resolveStore={resolveStore}
        anchorTime={() => timePointYear(1000)}
        screenToWorld={screenToWorld}
        featureAtPoint={featureAtPoint}
        drawSink={drawSink}
        defaultColor={DEFAULT_COLOR}
      />
    </>,
  );

  return { store, startProcess, drawSink, optionBar, addDraft, unmount: utils.unmount };
}

function activateDrill(store: StoreApi<SessionStore<S>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditDrill);
  });
}

function clickInput(lon: number, lat: number): void {
  const layer = screen.getByTestId('drill-input-layer');
  fireEvent.pointerDown(layer, { clientX: lon, clientY: lat, button: 0 });
}

/** Select the target (phase 1, no vertex) then draw a valid inside region ([2,2]-[10,2]-[6,10]). */
function selectAndDrawRegion(): void {
  clickInput(5, 5); // phase 1 (N725-2): picks the target末端 face ONLY — no region vertex
  clickInput(2, 2);
  clickInput(10, 2);
  clickInput(6, 10);
}

// --- FR-45: select target末端 → draw region → confirm → props → save drives U13 ------

describe('DrillToolController — 穴あけによる新地物生成 (FR-45)', () => {
  it('starting the tool shows the select-target guide and pushes an overlay batch', () => {
    const h = mountDrill();
    activateDrill(h.store);
    expect(screen.getByTestId('drill-guide').textContent).toContain('末端地物');
    expect(h.drawSink.batches.length).toBeGreaterThan(0);
    h.unmount();
  });

  it('selecting a leaf target promotes it into the store selection and places NO vertex (N725-2)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    expect(h.store.getState().activeFeature).toBeNull();
    clickInput(2, 2); // phase 1: the click in the solid fill picks the target ONLY
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    // 2-phase (ring-edit と同型): the selection click is NOT the first region vertex.
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('0');
    h.unmount();
  });

  it('confirm is disabled below 3 region vertices and enabled at 3', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(5, 5); // phase 1: target selection only
    clickInput(2, 2);
    clickInput(10, 2);
    expect(screen.getByTestId('drill-confirm')).toBeDisabled();
    clickInput(6, 10);
    expect(screen.getByTestId('drill-confirm')).not.toBeDisabled();
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('3');
    h.unmount();
  });

  it('undo removes the last placed region vertex (FR-78)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(5, 5); // phase 1: target selection only
    clickInput(2, 2);
    clickInput(10, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('drill-undo'));
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('1');
    h.unmount();
  });

  it('confirm region opens the新地物プロパティ form; save drives U13 with a 2-feature DrillSnapshot', () => {
    const h = mountDrill();
    activateDrill(h.store);
    selectAndDrawRegion();
    // Confirm the region → the property form appears (U23 AddPropertyForm re-use).
    fireEvent.click(screen.getByTestId('drill-confirm'));
    expect(screen.getByTestId('drill-props')).toBeInTheDocument();
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    // Save → drillRegion runs and the injected U13 process is called with a proposal
    // carrying BOTH the holed original AND the new feature (2 地物 1 undo unit, FR-94).
    fireEvent.submit(screen.getByTestId('add-property-form'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    const proposal = h.startProcess.mock.calls[0]![0] as EditProposal<DrillSnapshot>;
    expect(proposal.snapshot.originalFeatureId).toBe(TARGET_ID);
    expect(proposal.snapshot.newFeature).toBeDefined();
    expect(proposal.snapshot.newFeature.id).not.toBe(TARGET_ID);
    // holedShape is the original with the region carved out (a hole ring appears).
    expect(proposal.snapshot.holedShape.rings.length).toBeGreaterThan(1);
    // On commit the transient draft is discarded (教訓 5.2) and the tool re-arms fresh
    // for another drill — the chrome stays mounted (like knife/ring-edit) but the
    // region draft is empty and the flow returns to selecting a target.
    expect(screen.getByTestId('drill-tool')).toHaveAttribute('data-flow', 'selecting-target');
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('0');
    h.unmount();
  });
});

// --- 司令塔の決定 (5): 新地物の素性は **右パネルの「新規の姿」**で受ける -------------
//
// 設計書 §B.5 の台帳 #9 / §C.2 の 27。旧版は地図の真ん中に板（`drill-props` の中身）を
// 出していた。同じ「新しい地物の素性を入れる」作業なのに置き場が追加の道具と 2 通り
// あり、板は **いまくり抜いた形の真上に出る**ので穴を見ながら名前を入れられなかった。
//
// jsdom はレイアウトを計算しない（`getBoundingClientRect()` が常に 0）ので「覆っているか」
// は測れない（開発ガイド §5.49）。**代わりに木の位置を見る** ―― 素性欄が道具の覆い
// （`drill-tool`。地図セルの中に inset:0 で敷かれている）の**外**に居ることは、「地図の
// 上に出ていない」の必要条件であり、jsdom で嘘をつかずに測れる形である。覆っていない
// ことそのものは E2E（`e2e/inc5-shell.spec.ts`）が実寸で見る。
describe('DrillToolController — 新地物の素性は右パネルで受ける (司令塔の決定 (5))', () => {
  /** 対象を掴む → くり抜く形を描く → 確定、で素性入力の局面まで進める。 */
  function enterProperties(): void {
    selectAndDrawRegion();
    fireEvent.click(screen.getByTestId('drill-confirm'));
  }

  it('素性欄は道具の覆いの外に出る（地図の中央に押せる板を作らない）', () => {
    const h = mountDrill();
    activateDrill(h.store);
    enterProperties();

    const form = screen.getByTestId('add-property-form');
    // **わざと壊すなら**: `DrillToolController` の返り値に `<AddPropertyForm>` を戻すと、
    // 素性欄が覆いの中に入ってここが赤くなる。
    expect(screen.getByTestId('drill-tool')).not.toContainElement(form);
    // 上位領域の欄は出さない ―― 新地物の上位領域はドメインが元の末端地物から継ぐ
    //（FR-45）ので、選ばせると「選んだのに反映されない欄」になる。
    // **わざと壊すなら**: 押し込みの `showParent: false` を外すと選択欄が出て赤くなる。
    expect(screen.queryByTestId('add-parent')).not.toBeInTheDocument();
    h.unmount();
  });

  it('覆いに残る `drill-props` は hidden の観測ミラーだけ（T-1 / T-2）', () => {
    const h = mountDrill();
    activateDrill(h.store);
    enterProperties();

    const mirror = screen.getByTestId('drill-props');
    // 役割（「素性入力の局面に居る」の観測）は持ち越すが、**見えてはいけない**。
    expect(mirror).not.toBeVisible();
    expect(screen.getByTestId('drill-tool')).toContainElement(mirror);
    h.unmount();
  });

  it('素性入力中の確定欄は［やめる］だけ、［1 つ戻す］も引っ込む', () => {
    const h = mountDrill();
    activateDrill(h.store);
    enterProperties();

    // 保存は右パネルの［保存］が持つので、帯に［確定］は出さない。
    expect(screen.queryByTestId('drill-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('drill-cancel')).toBeInTheDocument();
    // **わざと壊すなら**: `drillExtras` の `drillEntering ? null : …` を外すと
    // ［1 つ戻す］が出て赤くなる ―― 押せると **確定済みのくり抜く形から頂点が黙って
    // 1 つ減り**、戻したはずの頂点を含まない形が保存される。
    expect(screen.queryByTestId('drill-undo')).not.toBeInTheDocument();
    // **わざと壊すなら**: `nextStep` の局面分岐を外すと、どこで入れるのかを言っていない
    // 案内文に戻ってここが赤くなる。
    expect(h.optionBar.get().nextStep).toBe(DRILL_STRINGS.nextStepEnterProperties);
    h.unmount();
  });

  it('［やめる］で入力待ちは片付く（次に素性欄を開いた人が前の道具のフォームを見ない）', () => {
    const h = mountDrill();
    activateDrill(h.store);
    enterProperties();
    expect(h.addDraft.get()).not.toBeNull();

    fireEvent.click(screen.getByTestId('drill-cancel'));
    // **わざと壊すなら**: `addDraft` の effect の後片付け（`set(null)`）を外すと、
    // 道具を降りたあとも「新規の姿」が右パネルに居座ってここが赤くなる。
    expect(h.addDraft.get()).toBeNull();
    expect(screen.queryByTestId('add-property-form')).not.toBeInTheDocument();
    h.unmount();
  });

  it('アンマウントでも入力待ちは片付く（教訓 5.2 全経路で破棄）', () => {
    const h = mountDrill();
    activateDrill(h.store);
    enterProperties();
    expect(h.addDraft.get()).not.toBeNull();
    h.unmount();
    expect(h.addDraft.get()).toBeNull();
  });
});

// --- 増分 5 の手直し B3: 断り・対象欄・段階表示はオプションバーへ ---------------

describe('DrillToolController — 断りと対象欄はオプションバーが出す (増分 5 の手直し B3)', () => {
  it('断られたら、地図に押せないボタンを出さず、帯の「次の一手」に理由と［やめる］が出る', () => {
    // **旧版は「出ているのに押せないボタン」だった**（バグ狩り #13）―― 断りの板は
    // `.drill-tool`（`pointer-events: none`）の子で、drill.css には板を押せるようにする
    // 規則が無かった。板ごと消し、［やめる］は帯の確定欄へ移した。
    const h = mountDrill(rejectedResult);
    activateDrill(h.store);
    selectAndDrawRegion();
    fireEvent.click(screen.getByTestId('drill-confirm'));
    fireEvent.submit(screen.getByTestId('add-property-form'));

    const mirror = screen.getByTestId('drill-rejected');
    expect(mirror).not.toBeVisible();
    expect(screen.queryByTestId('drill-rejected-dismiss')).not.toBeInTheDocument();
    // 断られた局面では［確定］を出さず、［やめる］だけを確定欄に置く。
    expect(screen.queryByTestId('drill-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('drill-cancel')).toBeInTheDocument();
    expect(h.optionBar.get().nextStep).toContain('受け付けられません');
    h.unmount();
  });

  it('対象欄は道具が自分で押し込む ―― 掴む前は空、掴んだら名前と「手順 n/3」が出る', () => {
    const h = mountDrill();
    activateDrill(h.store);
    expect(h.optionBar.get().target).toEqual({ stage: DRILL_STRINGS.stage(1), name: null });

    clickInput(5, 5);
    expect(h.optionBar.get().target).toEqual({
      stage: DRILL_STRINGS.stage(2),
      name: 'target（末端地物）',
    });
    h.unmount();
  });

  it('一覧で地物を選んでから構えても、押していない対象の名前は出ない（バグ狩り #6）', () => {
    const h = mountDrill();
    // `setMode` を挟まないのは、同じモードへの `setMode` が選択を捨てる契約だから。
    act(() => h.store.getState().setActiveFeature(TARGET_ID));
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditDrill));
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    expect(h.optionBar.get().target.name).toBeNull();
    h.unmount();
  });

  it('素性を入力している局面は「手順 3/3」になる', () => {
    const h = mountDrill();
    activateDrill(h.store);
    selectAndDrawRegion();
    fireEvent.click(screen.getByTestId('drill-confirm'));
    expect(h.optionBar.get().target.stage).toBe(DRILL_STRINGS.stage(3));
    h.unmount();
  });

  it('対象を離すと対象欄も空へ戻り、道具を降りると帯から消える', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(5, 5);
    expect(h.optionBar.get().target.name).toBe('target（末端地物）');

    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 対象を離す
    expect(h.optionBar.get().target).toEqual({ stage: DRILL_STRINGS.stage(1), name: null });

    act(() => h.store.getState().setActiveTool(null));
    expect(h.optionBar.get().target).toEqual({ stage: null, name: null });
    h.unmount();
  });
});

// --- 妥当性検証拒否: a bad region surfaces the domain message and does NOT confirm ----

describe('DrillToolController — rejection surfaces the domain message (教訓 5.22 / 5.26)', () => {
  it('a region that escapes the target末端 is rejected with the domain Japanese文言', () => {
    const h = mountDrill();
    activateDrill(h.store);
    // Phase 1 picks the target; then place three vertices, one OUTSIDE the target
    // ([25,25] is beyond [0,20]²) so the region is not contained → NotContained reject.
    clickInput(5, 5); // phase 1: target selection only
    clickInput(2, 2);
    clickInput(10, 2);
    clickInput(25, 25); // outside the featureAtPoint gate does not matter — draft adds it
    fireEvent.click(screen.getByTestId('drill-confirm'));
    fireEvent.submit(screen.getByTestId('add-property-form'));
    // startProcess is NOT reached (drillRegion rejected before U13); a message shows.
    expect(h.startProcess).not.toHaveBeenCalled();
    expect(screen.getByTestId('drill-message').textContent).toContain('内側');
    h.unmount();
  });

  it('1 辺で経度 180 度以上を渡る結果になる穴あけは断られ、理由が日本語で出る (N-51)', () => {
    // 横長の面に穴をあけると、穴と関係の無い外周が「1 本で 340 度」に化ける ―― 保存して
    // 読み直すと必ず別の形になるので、確定させずに理由を出す。
    const h = mountDrill(committed, wideTargetLeaf());
    activateDrill(h.store);
    clickInput(5, 5); // 対象の面を選ぶ (頂点は置かれない)
    clickInput(-5, 5);
    clickInput(5, 5);
    clickInput(5, 15);
    clickInput(-5, 15);
    fireEvent.click(screen.getByTestId('drill-confirm'));
    fireEvent.submit(screen.getByTestId('add-property-form'));
    expect(h.startProcess).not.toHaveBeenCalled();
    expect(screen.getByTestId('drill-message').textContent).toContain('世界を半周以上');
    expect(screen.getByTestId('drill-message').textContent).toContain('別の場所に穴をあけて');
    h.unmount();
  });
});

// --- 新地物プロパティ入力の取りこぼし防止 -------------------------------------

describe('DrillToolController — フォームの入力を落とさない', () => {
  it('種別ラベルを入れると新しい地物に載る', () => {
    // 中継が `attributes` と `color` の 2 つだけを取り出していたため、利用者がフォームへ
    // 入れた種別ラベルが黙って捨てられていた。追加の道具と同じく丸ごと渡す形に揃えた。
    const h = mountDrill();
    activateDrill(h.store);
    selectAndDrawRegion();
    fireEvent.click(screen.getByTestId('drill-confirm'));
    act(() =>
      fireEvent.change(screen.getByTestId('add-kind-label'), { target: { value: '国' } }),
    );
    fireEvent.submit(screen.getByTestId('add-property-form'));
    const proposal = h.startProcess.mock.calls[0]![0] as EditProposal<DrillSnapshot>;
    expect(proposal.snapshot.newFeature.kindLabel).toBe('国');
    h.unmount();
  });
});

// --- 一時状態全経路破棄 (教訓 5.2) --------------------------------------------

describe('DrillToolController — transient state discarded on every exit path', () => {
  // **増分 5 の手直し B1 で契約が変わった**（設計書 §D.4）。旧版は「Escape 1 回で道具ごと
  // 消える」を固定していたが、それが GPT #8 の欠陥そのものだった。いまは 1 回で 1 段。
  it('Escape はくり抜く形の頂点列だけを捨て、対象も道具も保つ（階段 1 段目）', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(5, 5); // 対象を掛む
    clickInput(2, 2);
    clickInput(10, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('0');
    expect(screen.getByTestId('drill-tool').dataset['flow']).toBe('drawing-region');
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditDrill);
    h.unmount();
  });

  it('Escape 2 回目で対象だけを離し、道具は持ったまま（階段 2 段目）', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(5, 5);
    clickInput(2, 2);
    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 1 段目: 頂点列
    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 2 段目: 対象
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();
    expect(screen.getByTestId('drill-tool').dataset['flow']).toBe('selecting-target');
    expect(h.store.getState().activeFeature).toBeNull();
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditDrill);
    h.unmount();
  });

  it('Escape 3 回目は道具が何もせず、大域の階段へ譲る（preventDefault しない）', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(5, 5);
    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 対象を離す
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditDrill);
    h.unmount();
  });

  it('switching away from the drill tool discards a draft and clears the overlay', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(5, 5); // phase 1: target selection only
    clickInput(2, 2);
    clickInput(10, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditSelect));
    expect(screen.queryByTestId('drill-tool')).not.toBeInTheDocument();
    // The render sink got a final EMPTY batch on discard (overlay cleared).
    expect(h.drawSink.batches[h.drawSink.batches.length - 1]).toBe(0);
    // Re-activating starts a FRESH session (no carried-over target/vertices): the
    // first click is phase-1 target selection again, then a vertex lands as #1.
    activateDrill(h.store);
    clickInput(5, 5);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('0');
    clickInput(2, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('1');
    h.unmount();
  });
});

// --- W3-B: キャンセル後の再アーム (ring-edit 8950639 / knife と対称) ---------------
//
// CANCEL = ツールから出る. 対象選択の解除だけでは toolbar の aria-pressed が true のまま
// セッションだけ武装解除された状態が残り、同じボタンをもう一度押すとストアの press-toggle
// (tool → null) が走って「何も起きない」= 別ツールを経由しないと復活できなかった。
// `setActiveTool(null)` に一本化して toolbar の押下状態と session の armed を単一真実源に
// する (教訓 5.2 全経路で破棄 + 単一の真実源)。

describe('DrillToolController — キャンセルはツール選択も解除して再アームできる (W3-B)', () => {
  // **増分 5 の手直し B1: 道具を降りるのは［やめる］ボタンだけになった。** Escape は
  // 1 段ずつ戻る階段で、道具を降りるのは大域の階段のいちばん下（設計書 §D.4）。ここが
  // 固定したいのは「取りやめたあと同じボタンをもう一度押せば構え直せる」ことなので、
  // 打鍵を［やめる］の押下に置き換えて残す。
  it('キャンセル（［やめる］）で activeTool が null になり、同じツールの再選択で復活する', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(2, 2);
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId('drill-cancel'));
    });
    expect(screen.queryByTestId('drill-tool')).not.toBeInTheDocument();
    // The toolbar's aria-pressed mirrors `activeTool`; it must NOT stay pressed.
    expect(h.store.getState().activeTool).toBeNull();

    // Re-selecting the SAME tool re-arms a fresh session (the 実機 repro). The first
    // click is phase-1 target selection (N725-2: no vertex placed).
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditDrill));
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();
    clickInput(2, 2);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('0');
    h.unmount();
  });

  it('キャンセルボタンも同じくツール選択を解除する (単一の解除経路)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(2, 2);
    clickInput(10, 2);
    fireEvent.click(screen.getByTestId('drill-cancel'));
    expect(h.store.getState().activeTool).toBeNull();
    expect(screen.queryByTestId('drill-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  // W3-AB fix-forward (レビュー LOW): while the U35 conflict modal is open the MODAL owns
  // Escape. The tool-side listener stayed live through ConflictPaused, so an Escape that
  // missed the dialog ran `drill.cancel()` → `setActiveTool(null)` UNDER the open modal and
  // the host's later reArmActiveTool had `activeTool === null` — nothing to restore. Mirrors
  // the knife regression.
  it('ConflictPaused 中の Escape はツールを解除しない (競合モーダルが Esc の持ち主)', () => {
    const h = mountDrill(conflictsPending);
    activateDrill(h.store);
    selectAndDrawRegion();
    fireEvent.click(screen.getByTestId('drill-confirm'));
    fireEvent.submit(screen.getByTestId('add-property-form'));
    expect(screen.getByTestId('drill-conflict-paused')).toBeInTheDocument();

    // Fire from a NON-editable element: the property form is still mounted while paused
    // and its autofocused text input would otherwise trip the focus guard.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditDrill);
    expect(screen.getByTestId('drill-conflict-paused')).toBeInTheDocument();
    h.unmount();
  });
});

// バグハント第11波 #3/#6 — the drill controller's OWN window keydown listener (Escape /
// Ctrl+Z, live while a session runs) MUST honour the SAME focus guard the global
// dispatcher does (教訓 5.13 single predicate). The timeline year field / sidebar inputs
// are live even while a drill region is drawn; a Ctrl+Z / Escape with a text input focused
// must edit the TEXT natively, NOT undo a region vertex (#3) or cancel the drill (#6). A
// non-editable focus still cancels / undoes as before.
describe('DrillToolController — バグハント第11波 (#3/#6): focus guard on the keydown listener', () => {
  function focusedInput(type = 'text'): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  function drawTwoRegionVertices(): void {
    clickInput(5, 5); // phase 1 (N725-2): picks the target末端 face only
    clickInput(2, 2);
    clickInput(10, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
  }

  it('Ctrl+Z with a text input focused does NOT undo a vertex and does NOT preventDefault (#3)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    drawTwoRegionVertices();
    const input = focusedInput('number');
    const ev = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape with a text input focused does NOT cancel the drill and does NOT preventDefault (#6)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    drawTwoRegionVertices();
    const input = focusedInput('text');
    const ev = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape / Ctrl+Z from a NON-editable focus still undoes / cancels (no regression)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    drawTwoRegionVertices();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    act(() => fireEvent.keyDown(button, { key: 'z', ctrlKey: true }));
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('1');
    // Escape は階段の 1 段目 ―― 残りの頂点列をまとめて捨てる（道具は降りない。
    // 増分 5 の手直し B1 / 設計書 §D.4.1）。
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('0');
    button.remove();
    h.unmount();
  });
});

describe('DrillToolController — 素性を入れている最終段階の幕（N-13 の穴あけの半分。増分 8B の手直し）', () => {
  function enterProperties(): void {
    selectAndDrawRegion();
    fireEvent.click(screen.getByTestId('drill-confirm'));
  }

  it('地図の上に幕（入力の橋）が残り、押しても背後の地物は選ばれず理由が出る', () => {
    const h = mountDrill();
    activateDrill(h.store);
    enterProperties();
    // **わざと壊すなら**: 橋の条件から `drillEntering` を外すと、幕が消えてここが赤くなる
    // （背後の地図の左クリックが素通りして、地物を選んだり動かしたりできる）。
    const layer = screen.getByTestId('drill-input-layer');
    expect(layer).toHaveAttribute('data-locked', 'true');
    const before = h.store.getState().activeFeature;
    fireEvent.pointerDown(layer, { clientX: 15, clientY: 15, button: 0 });
    expect(h.store.getState().activeFeature).toBe(before);
    expect(h.optionBar.get().nextStep).toBe(DRILL_STRINGS.mapLockedWhileNaming);
    // 素性欄はそのまま使える。
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    h.unmount();
  });

  it('名前を打って幕を押し（焦点が欄から外れる）、Escape を押しても、捨てる前に聞く', () => {
    const h = mountDrill();
    activateDrill(h.store);
    enterProperties();
    const name = screen.getByTestId('add-name') as HTMLInputElement;
    name.focus();
    fireEvent.change(name, { target: { value: '湖' } });
    fireEvent.pointerDown(screen.getByTestId('drill-input-layer'), {
      clientX: 15,
      clientY: 15,
      button: 0,
    });
    name.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('drill-draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    h.unmount();
  });
});
