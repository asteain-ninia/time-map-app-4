// U26 — CROSS-LAYER INTEGRATION test (受け入れ基準 1 / 5 / 8).
//
// The domain core (split-geometry / proposal / session) is covered in isolation
// under src/domain/knife. THIS test is the layer-crossing verification the lens
// flagged as missing: it mounts the REAL KnifeToolController over ONE session
// store and drives the whole knife flow through the actual UI —
//   - 受け入れ基準 1: tool select → target click (overlay + emphasis batch pushed)
//     → cut-point clicks → confirm cut splits the target into two (the COMPLETE
//     trigger is wired and fires — 教訓 5.7);
//   - 受け入れ基準 5: the継承先選択モーダル appears centered with the小さい方 boxed,
//     selecting a side highlights it, 確定 advances to非継承側プロパティ入力 (U23 form
//     re-used), and SAVE invokes the injected U13 process-start adapter (a logic
//     method existing but never called from the UI is caught here);
//   - 受け入れ基準 8: the transient session is discarded on EVERY exit path —
//     confirm→inheritor cancel→re-start, target→cut→tool switch→re-start, and the
//     provisional render batch is pushed to the sink and cleared on discard
//     (render 接続 + 教訓 5.2 全経路で破棄).
//
// Runs in jsdom (no Electron, no GUI): the renderer transform + draw sink are
// faked so the test is deterministic and non-interactive; the WIRING under test is
// the production component graph.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import {
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { SplitSnapshot } from '../../domain/knife/index';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import type { Command } from '../../domain/command/command';
import { EMPTY_COMMAND_RESULT } from '../../domain/command/result';
import { createLeafFeature, type Feature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
} from '../../domain/ring';
import { createVertex, createVertexStore, type VertexStore } from '../../domain/vertex';
import { timePointYearMonthDay } from '../../domain/time/time-point';

import { createSessionStore, type SessionStore } from '../state/store';
import { AddDraftForm } from '../add/AddPropertyForm';
import { AddDraftStore } from '../add/add-draft-store';
import { OptionBar } from '../shell/OptionBar';
import { OptionBarStore } from '../shell/option-bar';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import {
  KnifeToolController,
  type KnifeDrawSink,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './KnifeToolController';
import { KNIFE_STRINGS } from './strings';

// --- Fixtures ---------------------------------------------------------------

type S = { tag: string };
const NEXT_STATE: S = { tag: 'committed' };

const noopCommand: Command<S> = {
  kind: 'composite' as Command<S>['kind'],
  label: 'split',
  execute: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
  undo: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
  redo: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
};

const committed: ProcessResult<S> = {
  status: PROCESS_STATUS.Committed,
  state: NEXT_STATE,
  command: noopCommand,
};

/** A U13 outcome that REJECTS the split (増分 5 の手直し B3 の断りの経路)。 */
const rejectedResult: ProcessResult<S> = {
  status: PROCESS_STATUS.Rejected,
  kind: 'time-violation',
  message: 'この分割は受け付けられません。',
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
const ANCHOR = timePointYearMonthDay(1000, 1, 1);

const TARGET_ID = asFeatureId('leaf');

/** Build a single-territory leaf on TARGET_ID from an explicit coordinate ring. */
function leafFrom(coords: readonly ReturnType<typeof createCoordinate>[]): {
  feature: Feature;
  store: VertexStore;
} {
  const vids = coords.map((_, i) => asVertexId(`tv-${i}`));
  const vertices = coords.map((coord, i) => createVertex(vids[i]!, coord));
  const ring = createTerritoryRing(asRingId('tr-0'), vids);
  const feature = createLeafFeature(TARGET_ID, ATTRS, COLOR, createShape([ring]));
  return { feature, store: createVertexStore(vertices) };
}

/** A [0,10]² leaf feature + its store. */
function targetLeaf(): { feature: Feature; store: VertexStore } {
  return leafFrom([
    createCoordinate(0, 0),
    createCoordinate(10, 0),
    createCoordinate(10, 10),
    createCoordinate(0, 10),
  ]);
}

/**
 * 経度 −170°〜170° に広がる横長の面 (緯度は [0,10])。途中に頂点があるので 1 辺はどれも
 * 90 度以下 ―― この面自体は保存できる。だが横向きに切ると、集合演算が一直線上に並ぶ
 * 途中の頂点を落とすので、切り口と関係の無い外周が「1 本で 340 度」に化ける (N-51)。
 */
function wideTargetLeaf(): { feature: Feature; store: VertexStore } {
  return leafFrom([
    createCoordinate(-170, 0),
    createCoordinate(-90, 0),
    createCoordinate(0, 0),
    createCoordinate(90, 0),
    createCoordinate(170, 0),
    createCoordinate(170, 10),
    createCoordinate(90, 10),
    createCoordinate(0, 10),
    createCoordinate(-90, 10),
    createCoordinate(-170, 10),
  ]);
}

// Identity screen→world so a click at (clientX, clientY) lands at world (x, y).
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

let counter = 0;
const ids = () => ({
  nextFeatureId: () => asFeatureId(`nf-${counter++}`),
  nextVertexId: () => asVertexId(`nv-${counter++}`),
  nextRingId: () => asRingId(`nr-${counter++}`),
});

interface Harness {
  readonly store: StoreApi<SessionStore<S>>;
  readonly startProcess: ReturnType<typeof vi.fn>;
  readonly drawSink: KnifeDrawSink & { batches: number[] };
  /** 帯（オプションバー）―― 確定欄・次の一手・対象欄はここに出る（設計書 §C.4）。 */
  readonly optionBar: OptionBarStore;
  /** 右パネルへの橋 ―― 非継承側の素性入力はここを通って「新規の姿」になる。 */
  readonly addDraft: AddDraftStore;
  readonly unmount: () => void;
}

function mountKnife(
  startResult: ProcessResult<S> = committed,
  fixture: { feature: Feature; store: VertexStore } = targetLeaf(),
  onDrawingChange?: (drawing: boolean) => void,
  extra: {
    /** 確定を遅らせる口（既定は同期で即座に走らせる）。 */
    readonly commitScheduler?: (run: () => void) => void;
    /** 対象の形を解決する口（穴・飛び地の注記は形を見て出す）。 */
    readonly resolveLeafShape?: (
      fid: typeof TARGET_ID,
    ) => GeoMultiPolygon | undefined;
  } = {},
): Harness {
  const { feature, store: vstore } = fixture;
  const store = createSessionStore<S>({
    initialDomain: { tag: 'initial' },
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });

  const startProcess = vi.fn((): ProcessResult<S> => startResult);

  const batches: number[] = [];
  const drawSink: KnifeDrawSink & { batches: number[] } = {
    batches,
    drawKnife(prims) {
      batches.push(prims.length);
    },
  };

  const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
    fid === TARGET_ID ? feature : undefined;
  const resolveStore = (): VertexStore => vstore;
  // Clicking anywhere inside [0,10]² resolves the target; outside → miss.
  const featureAtPoint: FeatureAtPoint = (p) =>
    p.lon >= 0 && p.lon <= 10 && p.lat >= 0 && p.lat <= 10 ? TARGET_ID : null;

  // **増分 5d: 確定の列はオプションバーの確定欄に出る**（地図の上には無い）。
  // だから帯そのものを一緒に載せないと、［分断線を確定］が DOM に現れない ――
  // これは検査の都合ではなく、**実物がそうなっている**ということである。
  const optionBar = new OptionBarStore();
  // **司令塔の決定 (5): 非継承側の素性入力は右パネルの「新規の姿」で受ける**（設計書
  // §B.5 の台帳 #9 / §C.2 の 27）。地図の中央の板（`knife-props` の中身）は消したので、
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
      <KnifeToolController<S>
        store={store}
        optionBar={optionBar}
        addDraft={addDraft}
        startProcess={startProcess}
        ids={ids()}
        resolveFeature={resolveFeature}
        resolveStore={resolveStore}
        anchorTime={() => ANCHOR}
        screenToWorld={screenToWorld}
        featureAtPoint={featureAtPoint}
        drawSink={drawSink}
        defaultColor={DEFAULT_COLOR}
        // 確定を 1 コマ遅らせる口は **同期の実装**を差し込む（増分 7 の中身 9 の作法）。
        // 実機は rAF → setTimeout で遅らせるが、検査で押すのは「確定が通るか」なので同期で走らせる。
        commitScheduler={
          extra.commitScheduler ??
          ((run) => {
            run();
          })
        }
        {...(extra.resolveLeafShape
          ? { resolveLeafShape: extra.resolveLeafShape }
          : {})}
        {...(onDrawingChange ? { onDrawingChange } : {})}
      />
    </>,
  );

  return { store, startProcess, drawSink, optionBar, addDraft, unmount: utils.unmount };
}

function activateKnife(store: StoreApi<SessionStore<S>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditKnife);
  });
}

function clickInput(lon: number, lat: number): void {
  const layer = screen.getByTestId('knife-input-layer');
  fireEvent.pointerDown(layer, { clientX: lon, clientY: lat, button: 0 });
}

// --- 受け入れ基準 1: target select + cut + confirm splits --------------------

describe('KnifeToolController — target select → cut → confirm (受け入れ基準 1)', () => {
  it('starting the tool shows the overlay batch and the select-target guide', () => {
    const h = mountKnife();
    activateKnife(h.store);
    // The guide for SelectingTarget is shown (FR-92 日本語ガイド).
    expect(screen.getByTestId('knife-guide').textContent).toContain('末端地物を選択');
    // The render sink received at least one batch (overlay drawn; FR-90).
    expect(h.drawSink.batches.length).toBeGreaterThan(0);
    h.unmount();
  });

  it('HB3-6/18: selecting a leaf target promotes it into the store selection', () => {
    const h = mountKnife();
    activateKnife(h.store);
    // Activating the knife tool runs the reset契約 → no selection yet.
    expect(h.store.getState().activeFeature).toBeNull();
    // Clicking inside the target leaf selects it AND promotes it into the store
    // selection (so the target is highlighted + drawn in the selection color).
    clickInput(5, 5);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    h.unmount();
  });

  it('HB3-6/18 review: cancel (Escape) clears the promoted target selection (no leak)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    // Escape → knife.cancel() → onCancelled → clearSelection: the cancelled target must
    // NOT linger as the selection (else it stays highlighted + Delete-able).
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(h.store.getState().activeFeature).toBeNull();
    h.unmount();
  });

  it('clicking a leaf selects it, then cut points + confirm splits into two', () => {
    const h = mountKnife();
    activateKnife(h.store);

    // Select the target by clicking inside it.
    clickInput(5, 5);
    // Now drawing: place a vertical cut from below to above through x=5.
    clickInput(5, -5); // first point (outside, below)
    // A click at (5, 15) is outside the固定円 → a vertex add, not a close.
    clickInput(5, 15);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');

    // CONFIRM the cut (the COMPLETE trigger; 教訓 5.7) → 継承先選択モーダル appears.
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-inheritor-dialog')).toBeInTheDocument();
    h.unmount();
  });

  it('a non-piercing cut shows a Japanese rejection message and does not advance', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5); // select
    // Two points entirely below the square: does not pierce.
    clickInput(-5, -5);
    clickInput(15, -5);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    // No modal; a rejection message is shown (FR-90 / FR-115).
    expect(screen.queryByTestId('knife-inheritor-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('knife-message').textContent).toContain('貫く');
    h.unmount();
  });
});

// --- 受け入れ基準 5: inheritor modal + smaller-side preview + U13 ------------

describe('KnifeToolController — inheritor modal + save → U13 (受け入れ基準 5)', () => {
  function splitToModal(h: Harness): void {
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
  }

  it('the modal is centered, boxes the smaller side, and highlights the chosen side', () => {
    const h = mountKnife();
    splitToModal(h);
    expect(screen.getByTestId('knife-inheritor-modal-root')).toBeInTheDocument();
    expect(screen.getByTestId('knife-backdrop')).toBeInTheDocument();
    // The smaller-side preview box exists (FR-93 小さい方プレビュー).
    expect(screen.getByTestId('knife-smaller-box')).toBeInTheDocument();
    // Selecting piece 0 highlights it (aria-pressed flips); HB3-5/19 index-based.
    fireEvent.click(screen.getByTestId('knife-choose-0'));
    expect(screen.getByTestId('knife-choose-0')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('knife-choose-1')).toHaveAttribute('aria-pressed', 'false');
    h.unmount();
  });

  it('confirm inheritor → property form (U23 re-used) → save invokes U13', () => {
    const h = mountKnife();
    splitToModal(h);
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    // The U23 add property form is re-used for非継承側 props (FR-93 / 教訓 5.30).
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    // SAVE the form → the injected U13 adapter is called (受け入れ基準 5 / 教訓 5.7).
    fireEvent.submit(screen.getByTestId('add-property-form'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it('種別ラベルを入れると新しい地物に載る（フォームの入力を落とさない）', () => {
    // 中継が `attributes` と `color` の 2 つだけを取り出していたため、利用者がフォームへ
    // 入れた種別ラベルが黙って捨てられていた。追加の道具と同じく丸ごと渡す形に揃えた。
    const h = mountKnife();
    splitToModal(h);
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    act(() =>
      fireEvent.change(screen.getByTestId('add-kind-label'), { target: { value: '国' } }),
    );
    fireEvent.submit(screen.getByTestId('add-property-form'));
    const proposal = h.startProcess.mock.calls[0]![0] as EditProposal<SplitSnapshot>;
    expect(proposal.snapshot.newFeature.kindLabel).toBe('国');
    h.unmount();
  });
});

// --- 司令塔の決定 (5): 非継承側の素性は **右パネルの「新規の姿」**で受ける -----------
//
// 設計書 §B.5 の台帳 #9 / §C.2 の 27。旧版は地図の真ん中に板（`knife-props` の中身）を
// 出していた。同じ「新しい地物の素性を入れる」作業なのに置き場が追加の道具と 2 通り
// あり、板は **いま切った形の真上に出る**ので切り口を見ながら名前を入れられなかった。
//
// jsdom はレイアウトを計算しない（`getBoundingClientRect()` が常に 0）ので「覆っている
// か」は測れない（開発ガイド §5.49）。**代わりに木の位置を見る** ―― 素性欄が道具の覆い
// （`knife-tool`。地図セルの中に inset:0 で敷かれている）の**外**に居ることは、
// 「地図の上に出ていない」の必要条件であり、jsdom で嘘をつかずに測れる形である。
// 覆っていないことそのものは E2E（`e2e/inc5-shell.spec.ts`）が実寸で見る。
describe('KnifeToolController — 非継承側の素性は右パネルで受ける (司令塔の決定 (5))', () => {
  /** 対象を掴む → 分断線を引く → 確定 → 継承先を確定、で素性入力の局面まで進める。 */
  function enterProperties(h: Harness): void {
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
  }

  it('素性欄は道具の覆いの外に出る（地図の中央に押せる板を作らない）', () => {
    const h = mountKnife();
    enterProperties(h);

    const form = screen.getByTestId('add-property-form');
    const overlay = screen.getByTestId('knife-tool');
    // **わざと壊すなら**: `KnifeToolChrome` に `<AddPropertyForm>` を戻すと、素性欄が
    // 覆いの中に入ってここが赤くなる。
    expect(overlay).not.toContainElement(form);
    // 上位領域の欄は出さない ―― 非継承側の上位領域はドメインが元の面から継ぐ（FR-44）
    // ので、選ばせると「選んだのに反映されない欄」になる。
    // **わざと壊すなら**: 押し込みの `showParent: false` を外すと選択欄が出て赤くなる。
    expect(screen.queryByTestId('add-parent')).not.toBeInTheDocument();
    h.unmount();
  });

  it('覆いに残る `knife-props` は hidden の観測ミラーだけ（T-1 / T-2）', () => {
    const h = mountKnife();
    enterProperties(h);

    const mirror = screen.getByTestId('knife-props');
    // 役割（「素性入力の局面に居る」の観測）は持ち越すが、**見えてはいけない**。
    expect(mirror).not.toBeVisible();
    expect(screen.getByTestId('knife-tool')).toContainElement(mirror);
    h.unmount();
  });

  it('素性入力中の確定欄は［やめる］だけ、次の一手は右パネルへ誘導する', () => {
    const h = mountKnife();
    enterProperties(h);

    // 保存は右パネルの［保存］が持つので、帯に［確定］は出さない（同じ働きのボタンを
    // 2 か所に置かない）。［やめる］は残す ―― 空にすると名前を打っている途中で取りやめる
    // 手が Escape だけになり、その Escape も名前欄に焦点があるあいだは届かない。
    expect(screen.getByTestId('knife-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('knife-confirm-cut')).not.toBeInTheDocument();
    // **わざと壊すなら**: `nextStep` の局面分岐を外すと、ドメインの案内文
    //（どこで入れるのかを言っていない）に戻ってここが赤くなる。
    expect(screen.getByTestId('option-bar-next-step').textContent).toBe(
      KNIFE_STRINGS.nextStepEnterProperties,
    );
    h.unmount();
  });

  it('［やめる］で入力待ちは片付く（次に素性欄を開いた人が前の道具のフォームを見ない）', () => {
    const h = mountKnife();
    enterProperties(h);
    expect(h.addDraft.get()).not.toBeNull();

    fireEvent.click(screen.getByTestId('knife-cancel'));
    // **わざと壊すなら**: `addDraft` の effect の後片付け（`set(null)`）を外すと、
    // 道具を降りたあとも「新規の姿」が右パネルに居座ってここが赤くなる。
    expect(h.addDraft.get()).toBeNull();
    expect(screen.queryByTestId('add-property-form')).not.toBeInTheDocument();
    h.unmount();
  });

  it('アンマウントでも入力待ちは片付く（教訓 5.2 全経路で破棄）', () => {
    const h = mountKnife();
    enterProperties(h);
    expect(h.addDraft.get()).not.toBeNull();
    h.unmount();
    expect(h.addDraft.get()).toBeNull();
  });
});

// --- 増分 5 の手直し B2: 確定したあとも道具を持ったまま ----------------------
//
// **5 道具のうちナイフだけが確定で道具を降りていた**（GPT #10）。設計書 §D.2 の
// 「道具の確定」の行は「道具は保つ（次の対象待ち）」で、§D.4 も「確定したあとも同じ」と
// 書いている ―― 続けて分けたいときに、道具を選び直さなくてよいようにするためである。
//
// **ここが固定するのは道具側の契約だけ**である。合成ルート（App.tsx）の
// `onKnifeCommitted` が確定直後に `setActiveTool(null)` を呼んでいるので、実機でも
// 道具が残るようにするにはその 1 行を外す必要がある（司令塔へ申し送り）。

describe('KnifeToolController — 確定したあとも道具を持ったまま (増分 5 の手直し B2)', () => {
  function splitAndSave(h: Harness): void {
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    fireEvent.submit(screen.getByTestId('add-property-form'));
  }

  it('確定すると、道具は構えたまま次の対象待ちへ戻る（下書きは残らない）', async () => {
    const h = mountKnife();
    splitAndSave(h);
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    // 確定の後始末は queueMicrotask 越しに走る（更新関数の外へ逃がしてある）。
    await act(async () => {
      await Promise.resolve();
    });
    // 道具は残り、セッションは「対象を選んでください」へ戻っている。
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    expect(screen.getByTestId('knife-tool').dataset['flow']).toBe('selecting-target');
    // 分断線の下書きは残っていない（教訓 5.2 全経路で破棄）。
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('0');
    h.unmount();
  });

  it('確定直後は道具が鍵盤を持っていない（＝ Ctrl+Z が大域の履歴へ届く）', async () => {
    // 設計書 §D.4 の表: 確定した直後は `focusOwner` が `map` に戻っていること。道具が
    // 「下書きを持っている」と名乗り続けると、ホストが大域の割り振りを降ろしたままに
    // するので、間違えた直後の Ctrl+Z が無反応になる（報告 04 §3.5 と同じ形）。
    const drawing: boolean[] = [];
    const h = mountKnife(committed, targetLeaf(), (v) => drawing.push(v));
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    // 対象を掴んでいるあいだは名乗っている。
    expect(drawing[drawing.length - 1]).toBe(true);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    fireEvent.submit(screen.getByTestId('add-property-form'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(drawing[drawing.length - 1]).toBe(false);
    h.unmount();
  });

  it('対象も下書きも無い待機中は、鍵盤を取らない（構えただけでは名乗らない）', () => {
    const drawing: boolean[] = [];
    const h = mountKnife(committed, targetLeaf(), (v) => drawing.push(v));
    activateKnife(h.store);
    expect(drawing[drawing.length - 1]).toBe(false);
    h.unmount();
  });
});

// --- 増分 5 の手直し B3: 断り・対象欄・段階表示はオプションバーへ ---------------

describe('KnifeToolController — 断りと対象欄はオプションバーが出す (増分 5 の手直し B3)', () => {
  it('断られたら、地図には押せる板を出さず、帯の「次の一手」に理由と［やめる］が出る', () => {
    const h = mountKnife(rejectedResult);
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    fireEvent.submit(screen.getByTestId('add-property-form'));

    // 地図側は **hidden の観測ミラー**だけ（旧版はここに pointer-events: auto の板が
    // あって、断りが出ているあいだ地図のクリックを奪っていた＝K-2）。
    const mirror = screen.getByTestId('knife-rejected');
    expect(mirror).not.toBeVisible();
    // 押せる［やめる］は帯の確定欄にある（地図の上には無い）。
    expect(screen.queryByTestId('knife-rejected-dismiss')).not.toBeInTheDocument();
    expect(screen.getByTestId('knife-cancel')).toBeInTheDocument();
    // 断りの本文は帯の「次の一手」に出る。
    expect(h.optionBar.get().nextStep).toContain('受け付けられません');
    h.unmount();
  });

  it('対象欄は道具が自分で押し込む ―― 掴む前は空、掴んだら名前と「手順 n/4」が出る', () => {
    const h = mountKnife();
    activateKnife(h.store);
    // **まだ 1 度も対象を押していないので空**（バグ狩り #6: 旧版は一覧で選んだ地物の
    // 名前が出ていた）。段階表示は「手順 1/4」＝これから対象を選ぶ。
    expect(h.optionBar.get().target).toEqual({ stage: KNIFE_STRINGS.stage(1), name: null });

    clickInput(5, 5);
    expect(h.optionBar.get().target).toEqual({
      stage: KNIFE_STRINGS.stage(2),
      name: 'target（末端地物）',
    });
    h.unmount();
  });

  it('対象を離すと対象欄も空へ戻り、道具を降りると帯から消える', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    expect(h.optionBar.get().target.name).toBe('target（末端地物）');

    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 対象を離す
    expect(h.optionBar.get().target).toEqual({ stage: KNIFE_STRINGS.stage(1), name: null });

    act(() => h.store.getState().setActiveTool(null));
    expect(h.optionBar.get().target).toEqual({ stage: null, name: null });
    h.unmount();
  });
});

// --- 1 辺で経度 180 度以上を渡る切り口 (N-51 / 技術方針 §6.8) -----------------

describe('KnifeToolController — 保存できない長さの辺は画面で断る (N-51)', () => {
  it('横長の面を横向きに切ると、断りの理由が日本語で出て継承先選択へ進まない', () => {
    const h = mountKnife(committed, wideTargetLeaf());
    activateKnife(h.store);
    clickInput(5, 5); // 対象の面を選ぶ
    // 緯度 5 を西の外から東の外まで貫く分断線 (1 辺はどれも 90 度以下で引く)。切った結果の
    // 外周が「1 本で 340 度」になるので、保存できない形として断られる。
    clickInput(-175, 5);
    clickInput(-90, 5);
    clickInput(0, 5);
    clickInput(90, 5);
    clickInput(175, 5);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.queryByTestId('knife-inheritor-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('knife-message').textContent).toContain('世界を半周以上');
    expect(screen.getByTestId('knife-message').textContent).toContain('別の場所で切って');
    h.unmount();
  });
});

// --- 受け入れ基準 8: transient state discarded on every exit path ------------

describe('KnifeToolController — 一時状態全経路破棄 (受け入れ基準 8)', () => {
  it('inheritor cancel discards the session (modal gone; back to inactive chrome)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-inheritor-dialog')).toBeInTheDocument();
    // Cancel from the modal → ALL transient state dropped (教訓 5.2).
    fireEvent.click(screen.getByTestId('knife-modal-cancel'));
    expect(screen.queryByTestId('knife-inheritor-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  it('switching away from the knife tool discards a cut in progress', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('1');
    // Tool switch → reset (教訓 5.2 (d)). The chrome disappears.
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditSelect));
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    // The render sink got a final EMPTY batch on discard (overlay cleared).
    expect(h.drawSink.batches[h.drawSink.batches.length - 1]).toBe(0);
    // Re-activating starts a FRESH session (no carried-over cut points).
    activateKnife(h.store);
    clickInput(5, 5); // re-select target
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('0');
    h.unmount();
  });

  // **増分 5 の手直し B1 で契約が変わった**（設計書 §D.4）。旧版はここで「Escape 1 回で
  // 道具ごと消える」を固定していたが、それが GPT #8 の欠陥そのもの ―― 1 回の Escape で
  // 「手順の対象」「元からの選択」「道具」の三段がまとめて落ちていた。いまは 1 回で 1 段。
  it('Escape は分断線の点列だけをまとめて捨て、対象も道具も保つ（階段 1 段目）', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5); // 対象を掴む
    clickInput(5, -5); // 分断線 1 点目
    clickInput(5, 15); // 分断線 2 点目
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    // **分断線 2 点は「確定できる点数」なので 1 度だけ聞く**（設計書 §D.4.1 の 3。
    // 増分 5 の手直し 2 回目で足した段）。板が出ているあいだ点列はまだ生きている。
    expect(screen.getByTestId('knife-draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
    // 利用者自身の Escape で出た板なので、もう一度の Escape は「捨てる」＝先へ進む
    // （「このままにする」にすると板が開いては閉じるだけの輪になる＝教訓 5.70）。
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    // 点列だけが空になり、対象（DrawingCut）も道具も残っている。
    expect(screen.queryByTestId('knife-draft-discard-confirm')).toBeNull();
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('0');
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    h.unmount();
  });

  it('板が出ているあいだ、道具の打鍵は Escape 以外どれも分断線に届かない', () => {
    // **手直し 3 回目。** 実測で 4 道具 × 3 理由の 12 通りすべて、板の中の `Ctrl+Z` が
    // 点を 1 つ減らした（分断線 2→1）のに状態行は「いま使えません」と言っていた。
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    act(() => {
      h.store.getState().setActiveTool(TOOL_ID.EditSelect);
    });
    expect(screen.getByTestId('knife-draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');

    for (const key of [
      { key: 'z', ctrlKey: true },
      { key: 'Enter' },
      { key: 'Backspace' },
      { key: 'Delete' },
    ]) {
      act(() => {
        fireEvent.keyDown(window, key);
      });
      expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
      expect(screen.getByTestId('knife-draft-discard-confirm')).toBeInTheDocument();
    }

    act(() => fireEvent.click(screen.getByTestId('knife-draft-discard-no')));
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
    h.unmount();
  });

  it('確定できる点数の分断線は、道具の持ち替えでも確認なしには捨てない（§D.4.1 の 3）', () => {
    // **増分 5 の手直し 2 回目**。旧版は `activeTool` が外れた瞬間に `resetForSwitch()` を
    // 呼んでいたので、分断線 2 点が黙って消えた。いまは **切替先を構えないまま**聞く。
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');

    act(() => {
      h.store.getState().setActiveTool(TOOL_ID.EditSelect);
    });
    // 板が出て、**切替先はまだ構えられていない**（道具はナイフのまま）。
    expect(screen.getByTestId('knife-draft-discard-confirm')).toBeInTheDocument();
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');

    // ［続ける］＝ 何も起きない（もう戻してある）。
    act(() => fireEvent.click(screen.getByTestId('knife-draft-discard-no')));
    expect(screen.queryByTestId('knife-draft-discard-confirm')).toBeNull();
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');

    // ［捨てる］＝ 下書きを捨ててから、頼まれていた持ち替えをここで初めて実行する。
    act(() => {
      h.store.getState().setActiveTool(TOOL_ID.EditSelect);
    });
    expect(screen.getByTestId('knife-draft-discard-confirm')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByTestId('knife-draft-discard-yes')));
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditSelect);
    expect(screen.queryByTestId('knife-tool')).toBeNull();
    h.unmount();
  });

  it('Escape 2 回目で対象だけを離し、道具は持ったまま（階段 2 段目）', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 1 段目: 点列
    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 2 段目: 対象
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    expect(screen.getByTestId('knife-tool').dataset['flow']).toBe('selecting-target');
    // 道具が昇格させた対象だけが選択から外れる。道具は持ったまま。
    expect(h.store.getState().activeFeature).toBeNull();
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    h.unmount();
  });

  it('Escape 3 回目は道具が何もせず、大域の階段へ譲る（preventDefault しない）', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 対象を離す
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    // 道具は何もしない ―― 止めないので、大域の `escape-ladder` が続きを引き受けられる。
    expect(ev.defaultPrevented).toBe(false);
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    h.unmount();
  });

  // **元からの選択を巻き添えにしない**（GPT #8 の核心）。道具の外で選んだ地物は、階段の
  // 1 段目・2 段目では消えない ―― 消してよいのは道具が自分で昇格させた対象だけである。
  it('道具が掴んでいない選択は、階段の 1 段目・2 段目で消えない', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5); // 対象を掴む（＝道具が昇格させる）
    clickInput(5, -5); // 分断線 1 点
    // 利用者が道具の外で別の地物を選び直した（一覧の行を押した、など）。
    const OTHER = asFeatureId('other-leaf');
    act(() => h.store.getState().setActiveFeature(OTHER));
    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 1 段目
    expect(h.store.getState().activeFeature).toBe(OTHER);
    act(() => fireEvent.keyDown(window, { key: 'Escape' })); // 2 段目
    // 昇格させた id と一致しないので触らない（旧版は clearSelection でここが null になった）。
    expect(h.store.getState().activeFeature).toBe(OTHER);
    h.unmount();
  });
});

// --- W3-B: キャンセル後の再アーム (ring-edit 8950639 と対称) ---------------------
//
// CANCEL = ツールから出る. 対象選択の解除だけでは toolbar の aria-pressed が true のまま
// セッションだけ武装解除された状態が残り、同じボタンをもう一度押すとストアの press-toggle
// (tool → null) が走って「何も起きない」= 別ツールを経由しないと復活できなかった。
// `setActiveTool(null)` に一本化して toolbar の押下状態と session の armed を単一真実源に
// する (教訓 5.2 全経路で破棄 + 単一の真実源)。ring-edit と同じ規約。

describe('KnifeToolController — キャンセルはツール選択も解除して再アームできる (W3-B)', () => {
  // **増分 5 の手直し B1: 道具を降りるのは［やめる］ボタンだけになった。** Escape は
  // 1 段ずつ戻る階段で、道具を降りるのは大域の階段のいちばん下（設計書 §D.4）。ここが
  // 固定したいのは「取りやめたあと同じボタンをもう一度押せば構え直せる」ことなので、
  // 打鍵を［やめる］の押下に置き換えて残す。
  it('キャンセル（［やめる］）で activeTool が null になり、同じツールの再選択で復活する', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();

    act(() => {
      clickInput(5, -5); // 分断線を 1 点打つ（確定欄に［やめる］が出る局面）
      fireEvent.click(screen.getByTestId('knife-cancel'));
    });
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    // The toolbar's aria-pressed mirrors `activeTool`; it must NOT stay pressed.
    expect(h.store.getState().activeTool).toBeNull();

    // Re-selecting the SAME tool re-arms a fresh session (the 実機 repro: the user
    // pressed the same button again and nothing happened).
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditKnife));
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    clickInput(5, 5);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('0');
    h.unmount();
  });

  it('分断線キャンセルボタンも同じくツール選択を解除する (単一の解除経路)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    fireEvent.click(screen.getByTestId('knife-cancel'));
    expect(h.store.getState().activeTool).toBeNull();
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  it('継承先モーダルのキャンセルも同じ経路 (再アーム可能)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-modal-cancel'));
    expect(h.store.getState().activeTool).toBeNull();
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditKnife));
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    h.unmount();
  });

  // W3-AB fix-forward (レビュー LOW): while the U35 conflict modal is open the MODAL owns
  // Escape (its own useModalKeydown → onConflictCancel → the host's reArmActiveTool). The
  // tool-side Escape listener stayed live through ConflictPaused, so an Escape that missed
  // the dialog's React handler ran `knife.cancel()` → `setActiveTool(null)` UNDER the still
  // open modal; the later reArmActiveTool then read `activeTool === null` and toggled
  // null→null, so the tool never came back after the conflict was resolved.
  it('ConflictPaused 中の Escape はツールを解除しない (競合モーダルが Esc の持ち主)', () => {
    const h = mountKnife(conflictsPending);
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    fireEvent.click(screen.getByTestId('add-save'));
    expect(screen.getByTestId('knife-conflict-paused')).toBeInTheDocument();

    // Fire from a NON-editable element: the 非継承側 form is still mounted (the session
    // stays in EnteringProperties while paused) and its autofocused text input would
    // otherwise trip the focus guard, masking the listener entirely.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    // The session stays paused and the tool stays armed, so the host's reArmActiveTool
    // (which reads `activeTool` at conflict close) still has a tool to restore.
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    expect(screen.getByTestId('knife-conflict-paused')).toBeInTheDocument();
    h.unmount();
  });
});

// バグハント第11波 #3/#6 — the knife controller's OWN window keydown listener (Escape /
// Ctrl+Z, live while a session runs) MUST honour the SAME focus guard the global
// dispatcher does (教訓 5.13 single predicate). The timeline year field / sidebar inputs
// are live even while a cut is drawn; a Ctrl+Z / Escape with a text input focused must
// edit the TEXT natively, NOT undo a cut point (#3) or cancel the knife (#6). A
// non-editable focus still cancels / undoes as before.
describe('KnifeToolController — バグハント第11波 (#3/#6): focus guard on the keydown listener', () => {
  function focusedInput(type = 'text'): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  /** Select the target + place 2 cut points (DrawingCut, count = 2). */
  function drawTwoCutPoints(): void {
    clickInput(5, 5); // select target
    clickInput(5, -5); // first cut point
    clickInput(5, 15); // second cut point (outside the固定円 → vertex add)
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
  }

  it('Ctrl+Z with a text input focused does NOT undo a cut point and does NOT preventDefault (#3)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    drawTwoCutPoints();
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
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape with a text input focused does NOT cancel the knife and does NOT preventDefault (#6)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    drawTwoCutPoints();
    const input = focusedInput('text');
    const ev = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    // The knife session is still up (not cancelled) with its 2 cut points.
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape / Ctrl+Z from a NON-editable focus still undoes / cancels (no regression)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    drawTwoCutPoints();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    // Ctrl+Z undoes one cut point (2 → 1).
    act(() => fireEvent.keyDown(button, { key: 'z', ctrlKey: true }));
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('1');
    // Escape は階段の 1 段目 ―― 残りの点列をまとめて捨てる（道具は降りない。増分 5 の
    // 手直し B1 / 設計書 §D.4.1「1 つずつ戻すのは Ctrl+Z、まとめて捨てるのは Escape」）。
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('0');
    button.remove();
    h.unmount();
  });
});

// --- REGRESSION (bughunt: Knife の固定円半径/閉線判定が初期 zoom のまま stale) ----------
//
// ROOT BUG (bughunt): App.tsx passed `zoom={rendererRef.current?.zoom() ?? 1}` to
// this controller — read ONCE at React render time. The App does not re-render on a
// pan/wheel (the live draw path bypasses React, 技術方針 2.3), so after the user
// zoomed, the固定円 world radius (circleRadiusPx / zoom) and the閉線スナップ判定 stayed
// frozen at the first-render zoom and drifted from what the user sees.
//
// ROOT FIX (bughunt2): the controller SUBSCRIBES to store.camera.zoom INTERNALLY
// (useStore over its own `store` prop), so the zoom is no longer lifted to App and
// threaded down as a prop — lifting it put the zoom scalar on the App render path,
// re-rendering every overlay sibling once per wheel notch. The live render camera is
// still mirrored into store.camera on EVERY change, so the internal subscription sees
// the true zoom, but a wheel notch now re-renders ONLY this controller.
//
// This test proves the固定円閉線判定 follows the LIVE store zoom: a fixed click distance
// from the first point CLOSES at low zoom (large world radius) but is treated as a
// 頂点追加 at high zoom (small world radius) — i.e. the same gesture changes verdict
// purely because the store zoom changed, with NO re-mount.
describe('KnifeToolController — 固定円閉線判定 tracks the LIVE store camera zoom (回帰)', () => {
  // bughunt2: the controller now SUBSCRIBES to store.camera.zoom INTERNALLY (the
  // zoom scalar is no longer lifted to App / threaded as a prop — that put it on
  // the App render path and re-rendered every overlay sibling per wheel notch). So
  // the controller is rendered DIRECTLY here; a store camera change must re-render
  // it on its own and flip the固定円 verdict, with NO wrapper and NO re-mount.
  function mountZoomWired(initialZoom: number): Harness {
    const { feature, store: vstore } = targetLeaf();
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: {
        mode: EDIT_MODE.Edit,
        activeTool: null,
        camera: {
          zoom: initialZoom,
          centerLon: 0,
          centerLat: 0,
          panX: 0,
          panY: 0,
        },
      },
    });
    const startProcess = vi.fn((): ProcessResult<S> => committed);
    const batches: number[] = [];
    const drawSink: KnifeDrawSink & { batches: number[] } = {
      batches,
      drawKnife(prims) {
        batches.push(prims.length);
      },
    };
    const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
      fid === TARGET_ID ? feature : undefined;
    const resolveStore = (): VertexStore => vstore;
    const featureAtPoint: FeatureAtPoint = (p) =>
      p.lon >= 0 && p.lon <= 10 && p.lat >= 0 && p.lat <= 10 ? TARGET_ID : null;

    const optionBar = new OptionBarStore();
    // 素性入力は右パネルの「新規の姿」で受ける（司令塔の決定 (5)）。この describe は
    // 固定円の判定しか見ないが、**実物と同じ形で組む**ために橋も一緒に載せる。
    const addDraft = new AddDraftStore();
    const utils = render(
      <>
        <OptionBar store={optionBar} />
        <AddDraftForm store={addDraft} />
        <KnifeToolController<S>
          store={store}
          optionBar={optionBar}
          addDraft={addDraft}
          startProcess={startProcess}
          ids={ids()}
          resolveFeature={resolveFeature}
          resolveStore={resolveStore}
          anchorTime={() => ANCHOR}
          screenToWorld={screenToWorld}
          featureAtPoint={featureAtPoint}
          drawSink={drawSink}
          defaultColor={DEFAULT_COLOR}
        />
      </>,
    );
    return { store, startProcess, drawSink, optionBar, addDraft, unmount: utils.unmount };
  }

  // The固定円 world radius is DEFAULT_KNIFE_STYLE.circleRadiusPx / zoom. We click a
  // fixed CLOSE_GAP degrees from the first point; it lands INSIDE the circle iff
  // CLOSE_GAP <= circleRadiusPx / zoom. With circleRadiusPx = 28 and CLOSE_GAP = 5:
  //   zoom = 1  → radius 28 ≥ 5 → INSIDE  → closes (cut-count stays 3)
  //   zoom = 20 → radius 1.4 < 5 → OUTSIDE → 頂点追加 (cut-count becomes 4)
  const CLOSE_GAP = 5;
  const FIRST = { lon: 5, lat: -2 };

  /** Select the target then place exactly 3 cut points (closeable count). */
  function drawThreePoints(): void {
    clickInput(5, 5); // select target (inside the square)
    clickInput(FIRST.lon, FIRST.lat); // first cut point
    clickInput(5, 12); // pierces upward
    clickInput(6, 12); // third point — now ≥ MIN_POINTS_TO_CLOSE
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('3');
  }

  it('at low zoom a near-first click CLOSES the line (no extra vertex)', () => {
    const h = mountZoomWired(1);
    activateKnife(h.store);
    drawThreePoints();
    // Click CLOSE_GAP degrees from the first point → inside the (radius 28) circle.
    clickInput(FIRST.lon, FIRST.lat + CLOSE_GAP);
    // Closed: the line did NOT gain a vertex (count stays 3).
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('3');
    h.unmount();
  });

  it('at high zoom the SAME click is OUTSIDE the circle → 頂点追加 (not a close)', () => {
    const h = mountZoomWired(20);
    activateKnife(h.store);
    drawThreePoints();
    // Same gesture, but radius is now 1.4 deg → the click is outside → vertex add.
    clickInput(FIRST.lon, FIRST.lat + CLOSE_GAP);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('4');
    h.unmount();
  });

  it('changing the LIVE store zoom mid-session flips the verdict (the stale-zoom bug)', () => {
    // Start zoomed OUT (radius 28): the gesture would close. Then zoom IN via the
    // store (camera mirror) — WITHOUT re-mounting — and the SAME gesture must now be
    // a頂点追加. Before the fix the controller held the first-render zoom and the
    // verdict never changed (the stale固定円).
    const h = mountZoomWired(1);
    activateKnife(h.store);
    drawThreePoints();

    // Zoom in on the LIVE store (the path the render-camera mirror drives in App).
    act(() => {
      h.store.getState().updateCamera({ zoom: 20 });
    });

    // The near-first click is now OUTSIDE the (radius 1.4) circle → vertex add.
    clickInput(FIRST.lon, FIRST.lat + CLOSE_GAP);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('4');
    h.unmount();
  });
});

// --- REGRESSION (bughunt2: per-wheel-notch App re-render re-rendered ALL overlay
// controllers) ----------------------------------------------------------------
//
// ROOT BUG: App lifted the zoom subscription (useStore(store, s => s.camera.zoom))
// to its OWN body and threaded it to KnifeToolController as a `zoom` prop. Because
// the render-camera mirror writes a NEW store.camera.zoom on every wheel notch, that
// App-level subscription re-rendered App — and with it the ENTIRE overlay subtree
// (AddTool / Knife / FileOps / HelpTools / conflict modal) — once per notch, a
// partial regression of 技術方針 2.3 (the live draw path must bypass React).
//
// ROOT FIX: the zoom subscription moved INTO KnifeToolController (its only consumer).
// A wheel notch now re-renders ONLY the knife controller, NOT its overlay siblings.
//
// This test reproduces the App overlay shape: the knife controller mounted ALONGSIDE
// a sibling overlay that does NOT read camera.zoom. A store zoom change must re-render
// the knife controller (proven by the固定円 verdict tests above) WITHOUT re-rendering
// the sibling. Before the fix the shared App parent re-rendered, so the sibling's
// render count climbed per notch; after the fix it stays put.
describe('KnifeToolController — a wheel-notch zoom change does NOT re-render overlay siblings (回帰 bughunt2)', () => {
  it('the zoom subscription is local to the knife controller (sibling render count is flat)', () => {
    const { feature, store: vstore } = targetLeaf();
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: {
        mode: EDIT_MODE.Edit,
        activeTool: null,
        camera: { zoom: 1, centerLon: 0, centerLat: 0, panX: 0, panY: 0 },
      },
    });
    const startProcess = vi.fn((): ProcessResult<S> => committed);
    const drawSink: KnifeDrawSink = { drawKnife() {} };
    const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
      fid === TARGET_ID ? feature : undefined;
    const resolveStore = (): VertexStore => vstore;
    const featureAtPoint: FeatureAtPoint = (p) =>
      p.lon >= 0 && p.lon <= 10 && p.lat >= 0 && p.lat <= 10 ? TARGET_ID : null;

    // A sibling overlay that subscribes to the SAME store but NOT to camera.zoom
    // (it reads mode, like the real AddTool / FileOps / HelpTools controllers). Its
    // render count is the regression probe: it must NOT climb on a zoom-only change.
    let siblingRenders = 0;
    function SiblingOverlay(): JSX.Element {
      useStore(store, (s) => s.mode);
      siblingRenders += 1;
      return <div data-testid="sibling-overlay" />;
    }

    const utils = render(
      <>
        <SiblingOverlay />
        <KnifeToolController<S>
          store={store}
          startProcess={startProcess}
          ids={ids()}
          resolveFeature={resolveFeature}
          resolveStore={resolveStore}
          anchorTime={() => ANCHOR}
          screenToWorld={screenToWorld}
          featureAtPoint={featureAtPoint}
              drawSink={drawSink}
          defaultColor={DEFAULT_COLOR}
        />
      </>,
    );

    activateKnife(store); // a real overlay state change — both may render here
    const baseline = siblingRenders;

    // Spin the wheel: 5 notch-equivalent zoom writes through the live camera mirror.
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        store.getState().updateCamera({ zoom: 1 + (i + 1) * 0.25 });
      }
    });

    // The sibling did NOT re-render on any of the zoom-only notches (the bug made it
    // climb by 5 because the shared App parent re-rendered each time).
    expect(siblingRenders).toBe(baseline);
    utils.unmount();
  });
});

// --- 増分 8B（V10）: 片の呼び名・閉じたことの表示・押せない理由・幕・進行表示 --------------

/** [0,10]² の中央に [4,6]² の穴がある面（内陸の湖を持つ国のかわり）。 */
function holedLeaf(): {
  feature: Feature;
  store: VertexStore;
  shape: GeoMultiPolygon;
} {
  const outer = [
    createCoordinate(0, 0),
    createCoordinate(10, 0),
    createCoordinate(10, 10),
    createCoordinate(0, 10),
  ];
  const hole = [
    createCoordinate(4, 4),
    createCoordinate(6, 4),
    createCoordinate(6, 6),
    createCoordinate(4, 6),
  ];
  const ovids = outer.map((_, i) => asVertexId(`ho-${i}`));
  const hvids = hole.map((_, i) => asVertexId(`hh-${i}`));
  const vertices = [
    ...outer.map((c, i) => createVertex(ovids[i]!, c)),
    ...hole.map((c, i) => createVertex(hvids[i]!, c)),
  ];
  const feature = createLeafFeature(
    TARGET_ID,
    ATTRS,
    COLOR,
    createShape([
      createTerritoryRing(asRingId('hr-0'), ovids),
      createHoleRing(asRingId('hr-1'), hvids, asRingId('hr-0')),
    ]),
  );
  return {
    feature,
    store: createVertexStore(vertices),
    shape: [[outer, hole]],
  };
}

function nextStepText(): string {
  return screen.getByTestId('option-bar-next-step').textContent ?? '';
}

describe('増分 8B — 分断線を引いている間（N-10）', () => {
  it('0 点・1 点では［分断線を確定］を押せず、次の一手に理由が出る', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5); // 対象を掴む（0 点）
    expect(screen.getByTestId('knife-confirm-cut')).toBeDisabled();
    expect(nextStepText()).toContain(KNIFE_STRINGS.cutNeedsPoints(0));

    clickInput(5, -5); // 1 点
    expect(screen.getByTestId('knife-confirm-cut')).toBeDisabled();
    expect(nextStepText()).toContain(KNIFE_STRINGS.cutNeedsPoints(1));

    clickInput(5, 15); // 2 点 → 押せる
    expect(screen.getByTestId('knife-confirm-cut')).toBeEnabled();
    expect(nextStepText()).not.toContain(KNIFE_STRINGS.cutNeedsPoints(1));
    h.unmount();
  });

  it('分断線を閉じると次の一手が「閉じました」に変わる', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(2, 2);
    clickInput(8, 2);
    clickInput(8, 8);
    expect(nextStepText()).not.toBe(KNIFE_STRINGS.nextStepClosed);
    clickInput(2, 2); // 最初の点の円の中 → 閉じる
    expect(nextStepText()).toBe(KNIFE_STRINGS.nextStepClosed);
    expect(screen.getByTestId('knife-confirm-cut')).toBeEnabled();
    h.unmount();
  });

  it('穴のある面には「2 つにしか分かれない」を出さない（増分 8B の手直し: 穴のある面も n 分割になる）', () => {
    // 以前（V10 ③）は穴のある面を延長で切る 2 分割の経路へ回し、その旨を予告していた。
    // いまは外周を切片で分けて穴を差し引くので、穴だけを持つ面は 2 つにまとまらない（B69）。
    const fixture = holedLeaf();
    const h = mountKnife(committed, fixture, undefined, {
      resolveLeafShape: () => fixture.shape,
    });
    activateKnife(h.store);
    clickInput(1, 1);
    expect(nextStepText()).not.toContain('2 つにしか分かれません');
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-inheritor-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('knife-two-pieces-note')).not.toBeInTheDocument();
    // 穴を縦に貫く線は外周を 1 回だけ渡る切片なので、引いた所だけを切って 2 片。延長の注記も無い。
    expect(screen.queryByTestId('knife-beyond-line-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('knife-choose-1')).toBeInTheDocument();
    expect(screen.queryByTestId('knife-choose-2')).not.toBeInTheDocument();
    h.unmount();
  });

  it('穴の無い面には注記を出さない', () => {
    const h = mountKnife(committed, targetLeaf(), undefined, {
      resolveLeafShape: () => [
        [
          [
            createCoordinate(0, 0),
            createCoordinate(10, 0),
            createCoordinate(10, 10),
            createCoordinate(0, 10),
          ],
        ],
      ],
    });
    activateKnife(h.store);
    clickInput(5, 5);
    expect(nextStepText()).not.toContain('2 つにしか分かれません');
    expect(nextStepText().startsWith(KNIFE_STRINGS.cutNeedsPoints(0))).toBe(
      true,
    );
    h.unmount();
  });
});

describe('増分 8B — 継承先の板（N-09: 番号札・方角・面積で呼ぶ）', () => {
  it('片は「番号（方角・面積）」で呼ばれ、選んだ片が何を引き継ぐかを 1 文で言う', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));

    const labels = [0, 1].map(
      (i) => screen.getByTestId(`knife-choose-${String(i)}`).textContent ?? '',
    );
    // 縦に切ったので、片は東と西。番号は 1 と 2、面積の単位が付く。
    expect(labels.some((l) => /^1（(東|西)・.+ km²）$/.test(l))).toBe(true);
    expect(labels.some((l) => /^2（(東|西)・.+ km²）$/.test(l))).toBe(true);
    expect(labels.join('')).not.toContain('面 1');

    fireEvent.click(screen.getByTestId('knife-choose-1'));
    const sentence =
      screen.getByTestId('knife-inherit-sentence').textContent ?? '';
    expect(sentence).toContain(labels[1]!);
    expect(sentence).toContain('「target」として残り');
    // 下見に番号札が立つ。
    expect(screen.getByTestId('knife-piece-tag-0').textContent).toBe('1');
    expect(screen.getByTestId('knife-piece-tag-1').textContent).toBe('2');
    h.unmount();
  });
});

describe('増分 8B — 素性を入れている最終段階（N-13）と確定の進行表示（中身 3）', () => {
  it('地図の上に幕（入力の橋）が残り、押しても背後の地物は選ばれず理由が出る', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));

    const layer = screen.getByTestId('knife-input-layer');
    expect(layer).toHaveAttribute('data-locked', 'true');
    const before = h.store.getState().activeFeature;
    fireEvent.pointerDown(layer, { clientX: 50, clientY: 50, button: 0 });
    expect(h.store.getState().activeFeature).toBe(before);
    expect(nextStepText()).toBe(KNIFE_STRINGS.mapLockedWhileNaming);
    // 素性欄はそのまま使える。
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    h.unmount();
  });

  it('［保存］を押すと 1 コマ描かれて「分割しています…」になり、2 回目は走らない', () => {
    const queued: (() => void)[] = [];
    const h = mountKnife(committed, targetLeaf(), undefined, {
      // 実機の rAF → setTimeout のかわりに、手で 1 コマ進める。
      commitScheduler: (run) => {
        queued.push(run);
      },
    });
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    // 分断線の確定も同じ器を通る（増分 7 の結線）。ここで 1 コマ進める。
    act(() => queued.shift()?.());
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));

    fireEvent.submit(screen.getByTestId('add-property-form'));
    // まだ走っていない（1 コマ描かせてから走る）。その間、進行表示が出ている。
    expect(h.startProcess).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-save')).toHaveTextContent(
      KNIFE_STRINGS.committing,
    );
    expect(screen.getByTestId('add-save')).toBeDisabled();
    expect(screen.getByTestId('add-save-busy')).toHaveTextContent(
      KNIFE_STRINGS.committing,
    );
    expect(nextStepText()).toBe(KNIFE_STRINGS.committing);
    expect(screen.getByTestId('knife-cancel')).toBeDisabled();
    // 2 回目（ダブルクリック・Enter の連打）は積まれない。
    fireEvent.submit(screen.getByTestId('add-property-form'));
    expect(queued).toHaveLength(1);

    act(() => queued.shift()?.());
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});

describe('増分 8B — 飛び地のある面（V10 ④）', () => {
  it('飛び地のある面でも「2 つにしか分かれない」を確定の前に言う（板にも出る）', () => {
    const west = [
      createCoordinate(0, 0),
      createCoordinate(4, 0),
      createCoordinate(4, 10),
      createCoordinate(0, 10),
    ];
    const east = [
      createCoordinate(6, 0),
      createCoordinate(10, 0),
      createCoordinate(10, 10),
      createCoordinate(6, 10),
    ];
    const wv = west.map((_, i) => asVertexId(`ew-${i}`));
    const ev = east.map((_, i) => asVertexId(`ee-${i}`));
    const feature = createLeafFeature(
      TARGET_ID,
      ATTRS,
      COLOR,
      createShape([
        createTerritoryRing(asRingId('er-0'), wv),
        createTerritoryRing(asRingId('er-1'), ev),
      ]),
    );
    const vstore = createVertexStore([
      ...west.map((c, i) => createVertex(wv[i]!, c)),
      ...east.map((c, i) => createVertex(ev[i]!, c)),
    ]);
    const h = mountKnife(committed, { feature, store: vstore }, undefined, {
      resolveLeafShape: () => [[west], [east]],
    });
    activateKnife(h.store);
    clickInput(1, 1);
    const note = KNIFE_STRINGS.twoPiecesNote(
      KNIFE_STRINGS.twoPiecesReasonExclave,
    );
    expect(nextStepText()).toContain(
      KNIFE_STRINGS.twoPiecesShort(KNIFE_STRINGS.twoPiecesReasonExclave),
    );
    clickInput(2, -5);
    clickInput(2, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-two-pieces-note').textContent).toBe(note);
    h.unmount();
  });
});

// --- 増分 8B の手直し ----------------------------------------------------------------

/** 西 [0,4]×[0,10] と、飛び地の東 [6,10]×[0,10] を持つ面。 */
function exclaveLeaf(): {
  feature: Feature;
  store: VertexStore;
  shape: GeoMultiPolygon;
} {
  const west = [
    createCoordinate(0, 0),
    createCoordinate(4, 0),
    createCoordinate(4, 10),
    createCoordinate(0, 10),
  ];
  const east = [
    createCoordinate(6, 0),
    createCoordinate(10, 0),
    createCoordinate(10, 10),
    createCoordinate(6, 10),
  ];
  const wv = west.map((_, i) => asVertexId(`xw-${i}`));
  const ev = east.map((_, i) => asVertexId(`xe-${i}`));
  const feature = createLeafFeature(
    TARGET_ID,
    ATTRS,
    COLOR,
    createShape([
      createTerritoryRing(asRingId('xr-0'), wv),
      createTerritoryRing(asRingId('xr-1'), ev),
    ]),
  );
  return {
    feature,
    store: createVertexStore([
      ...west.map((c, i) => createVertex(wv[i]!, c)),
      ...east.map((c, i) => createVertex(ev[i]!, c)),
    ]),
    shape: [[west], [east]],
  };
}

/** U の字（[0,10]² から谷 [3,7]×[3,10] を除いた形）。水平線 y=5 で 3 片になる。 */
function uLeaf(): { feature: Feature; store: VertexStore } {
  return leafFrom([
    createCoordinate(0, 0),
    createCoordinate(10, 0),
    createCoordinate(10, 10),
    createCoordinate(7, 10),
    createCoordinate(7, 3),
    createCoordinate(3, 3),
    createCoordinate(3, 10),
    createCoordinate(0, 10),
  ]);
}

describe('増分 8B の手直し — 延ばした先でも切れたら、保存の前に言う（B69 の残り）', () => {
  it('飛び地の東を延長が割ると、継承先の板と、名前を入れる段の次の一手の両方で言う', () => {
    const fixture = exclaveLeaf();
    const h = mountKnife(committed, fixture, undefined, {
      resolveLeafShape: () => fixture.shape,
    });
    activateKnife(h.store);
    clickInput(1, 1);
    // 西だけを横切り、谷 (5,5) で止まる線。延長は東の飛び地を割る。
    clickInput(-1, 5);
    clickInput(5, 5);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-beyond-line-note').textContent).toBe(
      KNIFE_STRINGS.beyondLineNote,
    );
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    expect(nextStepText()).toBe(
      `${KNIFE_STRINGS.beyondLineShort}${KNIFE_STRINGS.nextStepEnterProperties}`,
    );
    h.unmount();
  });

  it('閉じた分断線では「2 つにしか分かれない」を板に出さない（設計適合 1-1）', () => {
    const fixture = exclaveLeaf();
    const h = mountKnife(committed, fixture, undefined, {
      resolveLeafShape: () => fixture.shape,
    });
    activateKnife(h.store);
    clickInput(1, 1);
    clickInput(1, 2);
    clickInput(3, 2);
    clickInput(3, 8);
    clickInput(1, 2); // 最初の点の円の中 → 閉じる
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-inheritor-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('knife-two-pieces-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('knife-beyond-line-note')).not.toBeInTheDocument();
    h.unmount();
  });
});

describe('増分 8B の手直し — 名前が何片に付くか（設計適合 2-1）と既定の継承先（設計適合 1-7）', () => {
  it('3 片に分けると、名前を入れる段の次の一手の先頭に「この名前と種別は 2 片すべてに付きます」が出る', () => {
    const h = mountKnife(committed, uLeaf());
    activateKnife(h.store);
    clickInput(1, 1);
    clickInput(-1, 5);
    clickInput(11, 5);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-choose-2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    // 帯は 1 行で末尾が切れるので、何片に付くかを行き先の案内より前に置く。
    expect(nextStepText()).toBe(
      `${KNIFE_STRINGS.sharedNameNote(2)}${KNIFE_STRINGS.nextStepEnterProperties}`,
    );
    h.unmount();
  });

  it('2 片なら注記は出さない（名前は 1 片にしか付かない）', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    expect(nextStepText()).toBe(KNIFE_STRINGS.nextStepEnterProperties);
    h.unmount();
  });

  it('既定の継承先はいちばん大きい片（赤い枠は今までどおり小さい方を囲む）', () => {
    const h = mountKnife(committed, uLeaf());
    activateKnife(h.store);
    clickInput(1, 1);
    clickInput(-1, 5);
    clickInput(11, 5);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    // 片は 3 つ: 左腕の上（3×5=15）・右腕の上（15）・根元（42）。既定は根元。
    const pressed = [0, 1, 2].filter(
      (i) =>
        screen.getByTestId(`knife-choose-${String(i)}`).getAttribute('aria-pressed') === 'true',
    );
    expect(pressed).toHaveLength(1);
    const label = screen.getByTestId(`knife-choose-${String(pressed[0]!)}`).textContent ?? '';
    // 札の方角: 根元は外接矩形の中心より南。
    expect(label).toMatch(/（(南|中央)/);
    expect(screen.getByTestId('knife-smaller-box')).toBeInTheDocument();
    h.unmount();
  });
});

describe('増分 8B の手直し — 素性入力の段の Escape は、打ちかけを中身で見る（反証 2-2）', () => {
  /** 縦に 2 等分して、継承先の板を既定のまま確定し、素性入力の段まで進める。 */
  function enterProperties(chooseIndex?: number): void {
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    if (chooseIndex !== undefined) {
      fireEvent.click(screen.getByTestId(`knife-choose-${String(chooseIndex)}`));
    }
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
  }

  it('名前を打つ → 地図（幕）を押す（焦点が欄から外れる）→ Escape で、捨てる前に聞く', () => {
    const h = mountKnife();
    activateKnife(h.store);
    enterProperties();
    const name = screen.getByTestId('add-name') as HTMLInputElement;
    name.focus();
    fireEvent.change(name, { target: { value: '北アルラーク' } });
    // 幕を押す。実機ではここで焦点が名前欄から外れる（jsdom は外さないので blur で代える）。
    fireEvent.pointerDown(screen.getByTestId('knife-input-layer'), {
      clientX: 5,
      clientY: 5,
      button: 0,
    });
    name.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    // **わざと壊すなら**: Escape の判定を「焦点のある欄の pristine」だけに戻すと、
    // 板が出ずに素性欄ごと消えてここが赤くなる。
    expect(screen.getByTestId('knife-draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    // ［続ける］で入力は残る。
    fireEvent.click(screen.getByTestId('knife-draft-discard-no'));
    expect(screen.getByTestId('add-name')).toHaveValue('北アルラーク');
    h.unmount();
  });

  it('継承先を既定から選び直していれば、名前が空でも聞く', () => {
    const h = mountKnife();
    activateKnife(h.store);
    // 2 等分なので既定は片 0（同じ面積なら番号の若いほう）。片 1 を選び直す。
    enterProperties(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('knife-draft-discard-confirm')).toBeInTheDocument();
    h.unmount();
  });

  it('名前も継承先も既定のままなら、聞かずに対象を離す段へ戻る（今までどおり）', () => {
    const h = mountKnife();
    activateKnife(h.store);
    enterProperties();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('knife-draft-discard-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('add-property-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('knife-tool')).toHaveAttribute('data-flow', 'selecting-target');
    h.unmount();
  });
});

describe('増分 8B の手直し — 3 片でも［保存］で確定が走る', () => {
  it('3 片に分けて名前を入れずに［保存］すると、U13 の確定が 1 回走る', () => {
    const h = mountKnife(committed, uLeaf());
    activateKnife(h.store);
    clickInput(1, 1);
    clickInput(-1, 5);
    clickInput(11, 5);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-choose-0'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    expect(nextStepText().startsWith(KNIFE_STRINGS.sharedNameNote(2))).toBe(true);
    fireEvent.click(screen.getByTestId('add-save'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});
