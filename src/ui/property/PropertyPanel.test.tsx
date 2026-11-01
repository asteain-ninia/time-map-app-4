// U32: PropertyPanel React operation tests (FR-83 / FR-84 / FR-97 / FR-99,
// 受け入れ基準 1/2/3/5, 教訓 5.10 / 5.12 / 5.13 / 5.15 / 5.24).

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useMemo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import {
  type AnchorSeries,
  createAnchorEntry,
  setEnd,
} from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate, type WorldCoordinate } from '../../domain/coordinate';
import { createGeoParams } from '../../domain/geo/geo-params';
import { shapeAreaKm2 } from '../../domain/geo/geodesy';
import { createLeafFeature, createPointFeature, type Feature } from '../../domain/feature';
import {
  asAnchorId,
  asFeatureId,
  asRingId,
  asVertexId,
  type FeatureId,
  type VertexId,
} from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { ownerLookupFromMap } from '../../domain/selection';
import { getCalendar } from '../../domain/time/calendar';
import {
  timePointYear,
  timePointYearMonthDay,
  type TimePoint,
} from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import { TOOL_ID } from '../shell/tools';
import { EDIT_MODE } from '../state/session';
import { createSessionStore, TIME_CHANGE_SOURCE } from '../state/store';

import type {
  AnchorIntervalEditDispatch,
  AnchorIntervalEditIntent,
  AnchorSeriesLookup,
  EditDispatch,
  FeatureLookup,
  PropertyEditIntent,
} from './contracts';
import { ANCHOR_INTERVAL_OP } from './contracts';
import { PropertyPanel } from './PropertyPanel';
import { PROPERTY_STRINGS, formatAreaKm2 } from './messages';
import { STYLE_STRINGS } from './style-section';

const cal = getCalendar('gregorian');
const color = createColorInfo(true, '#111111', '#222222', '#333333');

const fA = asFeatureId('A');
const vA1 = asVertexId('A-v1');
const fB = asFeatureId('B');
const vB1 = asVertexId('B-v1');

function featureA(): Feature {
  return createPointFeature(fA, createBasicAttributes('織田領', 1560, 1582), color, vA1);
}

function featureB(): Feature {
  return createPointFeature(fB, createBasicAttributes('武田領', 1540, 1582), color, vB1);
}

// FR-20 area fixtures: a 面 (leaf) feature `L` whose single territory ring is a
// unit square in world coordinates (0,0)-(1,1)-(1,0)... resolved through a vertex
// lookup. Point / line features carry no shape, so only this leaf should show a
// 面積 row.
const fL = asFeatureId('L');
const vL1 = asVertexId('L-v1');
const vL2 = asVertexId('L-v2');
const vL3 = asVertexId('L-v3');
const vL4 = asVertexId('L-v4');

const LEAF_VERTICES: ReadonlyMap<VertexId, WorldCoordinate> = new Map([
  [vL1, createCoordinate(0, 0)],
  [vL2, createCoordinate(1, 0)],
  [vL3, createCoordinate(1, 1)],
  [vL4, createCoordinate(0, 1)],
]);

function resolveLeafVertex(id: VertexId): WorldCoordinate | undefined {
  return LEAF_VERTICES.get(id);
}

function featureL(): Feature {
  const ring = createTerritoryRing(asRingId('L-r1'), [vL1, vL2, vL3, vL4]);
  return createLeafFeature(
    fL,
    createBasicAttributes('尾張国', 1560, 1582),
    color,
    createShape([ring]),
  );
}

function seriesFor(): AnchorSeries {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return {
    entries: [
      createAnchorEntry(createAnchor(asAnchorId('a1'), snap), timePointYearMonthDay(1560, 1, 1), timePointYearMonthDay(1573, 1, 1)),
      createAnchorEntry(createAnchor(asAnchorId('a2'), snap), timePointYearMonthDay(1573, 1, 1), null),
    ],
  };
}

function makeStore(opts?: { active?: boolean; vertices?: boolean; mode?: 'view' | 'edit' }) {
  return createSessionStore<Record<string, never>>({
    initialDomain: {},
    initial: {
      mode: opts?.mode === 'view' ? EDIT_MODE.View : EDIT_MODE.Edit,
      ...(opts?.active ? { activeFeature: fA } : {}),
      ...(opts?.vertices && opts.mode !== 'view' ? { activeTool: TOOL_ID.EditVertex } : {}),
      ...(opts?.vertices
        ? { vertexSelection: { ownerFeatureId: fA, vertexIds: new Set([vA1]) } }
        : {}),
    },
  });
}

// NOTE: each call returns a FRESH feature/series object (id-equal but
// reference-NEW), mirroring the real domain lookups. This is load-bearing for the
// regression tests below: it proves the panel/form key their reset to the feature
// ID, not the value object, so a re-resolve of the SAME feature does not churn the
// draft / message.
const featureLookup: FeatureLookup = {
  featureAt: (id) =>
    id === fA ? featureA() : id === fB ? featureB() : id === fL ? featureL() : null,
};
const anchorLookup: AnchorSeriesLookup = {
  anchorSeriesOf: (id) => (id === fA || id === fB || id === fL ? seriesFor() : null),
};
const ownerLookup = ownerLookupFromMap(
  new Map([
    [vA1, fA],
    [vB1, fB],
  ]),
);

function renderPanel(
  store: ReturnType<typeof makeStore>,
  dispatch: EditDispatch = { dispatchEdit: () => {} },
  onOpenDetail?: (id: FeatureId) => void,
) {
  return render(
    <PropertyPanel
      store={store}
      featureLookup={featureLookup}
      anchorLookup={anchorLookup}
      editDispatch={dispatch}
      calendar={cal}
      ownerLookup={ownerLookup}
      {...(onOpenDetail ? { onOpenDetail } : {})}
    />,
  );
}

describe('PropertyPanel — selection-display (FR-83, 教訓 5.10)', () => {
  it('empty selection shows the empty guidance', () => {
    renderPanel(makeStore());
    expect(screen.getByTestId('property-guidance')).toHaveTextContent(
      PROPERTY_STRINGS.emptySelection,
    );
  });

  it('active feature shows its basic info form', () => {
    renderPanel(makeStore({ active: true }));
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('織田領');
  });

  it('context-single (no active, one owner) shows the feature', () => {
    renderPanel(makeStore({ vertices: true }));
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();
  });
});

describe('PropertyPanel — anchor selection (FR-84, 教訓 5.6 / 5.15)', () => {
  it('selecting an anchor syncs current time to its start via setCurrentTime', () => {
    const store = makeStore({ active: true });
    const setCurrentTime = vi.spyOn(store.getState(), 'setCurrentTime');
    renderPanel(store);
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    expect(setCurrentTime).toHaveBeenCalledTimes(1);
    const [time, source] = setCurrentTime.mock.calls[0]!;
    expect((time as TimePoint).year).toBe(1573);
    expect(source).toBe(TIME_CHANGE_SOURCE.AnchorSync);
  });

  it('saving after anchor select dispatches an intent with the anchor start as edit time', () => {
    const intents: PropertyEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanel(store, { dispatchEdit: (i) => intents.push(i) });

    fireEvent.click(screen.getByTestId('anchor-row-a2')); // edit target = a2 (1573)
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '羽柴領' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    expect(intents).toHaveLength(1);
    expect(intents[0]!.editTime.year).toBe(1573); // 教訓 5.15: context time, not Date.now
    expect(intents[0]!.attributes.name).toBe('羽柴領');
  });

  it('a no-op save (unchanged values) does not dispatch (教訓 5.24)', () => {
    const intents: PropertyEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanel(store, { dispatchEdit: (i) => intents.push(i) });
    fireEvent.click(screen.getByTestId('anchor-row-a1'));
    fireEvent.click(screen.getByTestId('save-button')); // no field changed
    expect(intents).toHaveLength(0);
  });
});

describe('PropertyPanel — view-only mode (FR-99前段, 教訓 5.13)', () => {
  it('disables every edit input and hides the save button in view mode', () => {
    renderPanel(makeStore({ active: true, mode: 'view' }));
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toBeDisabled();
    expect(screen.getByLabelText(PROPERTY_STRINGS.borderColorLabel)).toBeDisabled();
    // U33 style section is part of the U32 panel; view mode disables it whole
    // (sectionEnabled=false) — the palette dropdown and fill picker are disabled
    // even though the palette is normally operable in edit mode (教訓 5.13).
    expect(screen.getByLabelText(STYLE_STRINGS.paletteLabel)).toBeDisabled();
    expect(screen.getByLabelText(STYLE_STRINGS.fillColorLabel)).toBeDisabled();
    expect(screen.queryByTestId('save-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-only-notice')).toBeInTheDocument();
  });

  it('N-03: 「地物を削除」も同じ関門で無効になる（K-6 の抜け道を塞ぐ）', () => {
    // かつてはこのボタンだけが権限を素通りしていた（DeleteFeatureButton に権限の入力が
    // 無く、PropertyPanel が onDeleteFeature を直接渡していた）。値を変える入力が全部
    // disabled なのに、いちばん取り返しのつかない操作だけが生きている状態だった。
    const onDeleteFeature = vi.fn();
    render(
      <PropertyPanel
        store={makeStore({ active: true, mode: 'view' })}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
        onDeleteFeature={onDeleteFeature}
      />,
    );
    // **増分 7 の中身 5**: 削除の入口が 2 本になり、この節は「全部の年から消す」側になった
    // （目立つ位置には「この年に終わったことにする」が立つ）。ラベルは画面と同じ 1 本
    // （`PROPERTY_STRINGS.deleteAllYearsLabel`）から取る（開発ガイド §5.64）。
    const button = within(screen.getByTestId('delete-feature')).getByRole('button', {
      name: PROPERTY_STRINGS.deleteAllYearsLabel,
    });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onDeleteFeature).not.toHaveBeenCalled();
  });

  it('編集モードでは「地物を削除」が押せる（検査が空振りしていない証）', () => {
    const onDeleteFeature = vi.fn();
    render(
      <PropertyPanel
        store={makeStore({ active: true })}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
        onDeleteFeature={onDeleteFeature}
      />,
    );
    expect(
      within(screen.getByTestId('delete-feature')).getByRole('button', {
        name: PROPERTY_STRINGS.deleteAllYearsLabel,
      }),
    ).toBeEnabled();
    // 取り返しのつかない側は **畳んだ節の中**に置く（設計書 §A.3 / §C.6）。
    expect(screen.getByTestId('danger-zone')).toBeInTheDocument();
  });
});

describe('PropertyPanel — decision message persistence (教訓 5.12)', () => {
  it('a save-failure message survives an unrelated click and clears on dismiss', () => {
    const store = makeStore({ active: true });
    // Dispatch throws → save-failure message.
    renderPanel(store, {
      dispatchEdit: () => {
        throw new Error('境界違反');
      },
    });
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    // Unrelated click (on the panel, not a save retry) does NOT clear it.
    fireEvent.click(screen.getByTestId('property-panel'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    // Explicit dismiss clears it (意味のある操作).
    const msg = screen.getByTestId('save-message');
    fireEvent.click(within(msg).getByLabelText(PROPERTY_STRINGS.dismissMessage));
    expect(screen.queryByTestId('save-message')).not.toBeInTheDocument();
  });

  it('別の地物を選んでも、保存失敗の文言は残る（教訓 5.12）', () => {
    // 受け入れ基準 5: a held decision message must NOT be cleared by無関係操作,
    // and別地物の選択 is explicitly such an操作. Only re-save / dismiss / 再保存成功
    // may clear it.
    //
    // **増分 2 で 1 段増えた**（N-04）: 打ちかけの内容があるまま別の地物を選ぶと
    // **確認が出て下書きを抱えたままになる**ので、捨てると決めてから別の地物の姿になる。
    // どちらの段階でも判断用の文言は消えないことを見る。
    const store = makeStore({ active: true });
    renderPanel(store, {
      dispatchEdit: () => {
        throw new Error('境界違反');
      },
    });
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    act(() => {
      store.getState().setActiveFeature(fB);
    });
    // 打ちかけがあるので確認が出ている（N-04）。文言は残っている。
    expect(screen.getByTestId('draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    // 捨てると別の地物の姿へ切り替わる。文言はそれでも消えない。
    fireEvent.click(screen.getByTestId('draft-discard-drop'));
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('武田領');
    expect(screen.getByTestId('save-message')).toBeInTheDocument();
  });
});

describe('PropertyPanel — context-feature anchor select (FR-84, 教訓 5.2 / 5.12)', () => {
  it('a same-feature-same-anchor re-resolve (selection churn) preserves the in-progress draft', () => {
    // Root cause: for a vertex-context target (no active feature, single owner),
    // setCurrentTime → revalidateForTime rebuilds the vertex Set with a FRESH
    // reference, re-rendering the panel with a new selection object naming the
    // SAME feature. Without ID-keyed memoization the resolved feature object would
    // be new every such render, wiping the draft. The draft-reseed key is 地物×錨
    // (bughunt 第12波 #1), so churn that keeps the SAME feature AND the SAME
    // explicitly-picked anchor must NOT re-seed. Pick anchor a2 first (an explicit
    // pick wins over time, so effectiveAnchorId stays a2), type an edit, then fire
    // a time change WITHIN that pick: the selection object churns but the edit
    // target (fA × a2) is unchanged, so the draft must survive.
    const store = makeStore({ vertices: true });
    renderPanel(store);
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('anchor-row-a2')); // edit target = fA × a2
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '編集中' },
    });

    // A pure selection-object churn (revalidateForTime rebuilds the vertex Set).
    // The explicit anchor pick a2 still wins, so the edit target does not change.
    act(() => {
      store
        .getState()
        .setCurrentTime(timePointYearMonthDay(1590, 6, 1), TIME_CHANGE_SOURCE.AnchorSync);
    });

    // The in-progress draft must survive the churn (same 地物×錨).
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('編集中');
  });

  it('selecting an anchor on a vertex-context feature preserves a held save-failure message', () => {
    const store = makeStore({ vertices: true });
    renderPanel(store, {
      dispatchEdit: () => {
        throw new Error('境界違反');
      },
    });
    // Produce a save-failure message: select anchor → edit → save (throws).
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    // Selecting another anchor re-runs setCurrentTime → revalidateForTime (fresh
    // vertex Set). The held message must survive (教訓 5.12).
    fireEvent.click(screen.getByTestId('anchor-row-a1'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();
  });
});

describe('PropertyPanel — 錨の欄は地物を切り替えると作り直される (BUG B, 教訓 5.2)', () => {
  it('地物を切り替えると錨の欄が作り直され、一時状態が引き継がれない', () => {
    // 錨の欄は一時的な UI 状態（スクロール位置など）を持つので、地物が変わったら
    // 作り直す（<AnchorSection key={targetFeatureId}>）。
    // **増分 2 の手直し E1 で時間バー表示の切替そのものを外した**ので、旧版が見ていた
    // 「切り替えたモードが次の地物へ持ち越されない」は、時間バーが素性欄から
    // 無くなったことの検査に置き換わっている。
    const store = makeStore({ active: true });
    renderPanel(store);

    expect(screen.getByTestId('anchor-list')).toBeInTheDocument();
    expect(screen.queryByTestId('anchor-mode-timebar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anchor-timebar')).not.toBeInTheDocument();

    // 別の地物へ移っても錨の欄は出る（作り直しの key は残してある）。
    act(() => {
      store.getState().setActiveFeature(fB);
    });
    expect(screen.getByTestId('anchor-list')).toBeInTheDocument();
    expect(screen.queryByTestId('anchor-mode-timebar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anchor-timebar')).not.toBeInTheDocument();
  });
});

describe('PropertyPanel — U33 style section integration (FR-100 / FR-102, AC1)', () => {
  it('mounts the StyleSection inside the panel (palette dropdown + fill picker present)', () => {
    renderPanel(makeStore({ active: true }));
    expect(screen.getByTestId('style-section')).toBeInTheDocument();
    expect(screen.getByLabelText(STYLE_STRINGS.paletteLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(STYLE_STRINGS.fillColorLabel)).toBeInTheDocument();
  });

  it('a palette change saves as part of the SAME single anchor edit intent (AC1)', () => {
    const intents: PropertyEditIntent[] = [];
    const store = makeStore({ active: true });
    render(
      <PropertyPanel
        store={store}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: (i) => intents.push(i) }}
        calendar={cal}
        ownerLookup={ownerLookup}
        paletteThemes={['default', 'warm', 'cool']}
      />,
    );

    fireEvent.click(screen.getByTestId('anchor-row-a2')); // edit target = a2 (1573)
    // Change the palette theme through the real StyleSection dropdown.
    fireEvent.change(screen.getByLabelText(STYLE_STRINGS.paletteLabel), {
      target: { value: 'warm' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    expect(intents).toHaveLength(1);
    // ONE intent (one undo unit) that carries the new palette theme (AC1).
    expect(intents[0]!.attributes.paletteTheme).toBe('warm');
    expect(intents[0]!.editTime.year).toBe(1573);
  });

  it('a 透過度（アルファ）slider edit saves as part of the single anchor edit intent (AC1・AC5)', () => {
    const intents: PropertyEditIntent[] = [];
    const store = makeStore({ active: true });
    render(
      <PropertyPanel
        store={store}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: (i) => intents.push(i) }}
        calendar={cal}
        ownerLookup={ownerLookup}
        paletteThemes={['default', 'warm', 'cool']}
      />,
    );

    fireEvent.click(screen.getByTestId('anchor-row-a2')); // edit target = a2 (1573)
    // Auto-color is ON for featureA, so the slider is read-only; release it first.
    fireEvent.click(screen.getByLabelText(STYLE_STRINGS.autoColorLabel)); // ON -> OFF
    // Drag the fill透過 slider to a non-default value through the real StyleSection.
    fireEvent.change(
      screen.getByLabelText(`${STYLE_STRINGS.fillColorLabel}${STYLE_STRINGS.opacityLabel}`),
      { target: { value: '0.4' } },
    );
    fireEvent.click(screen.getByTestId('save-button'));

    expect(intents).toHaveLength(1);
    // ONE intent (one undo unit) that carries the new透過度 (AC1・AC5), proving the
    // slider is bound to the persisted edit draft, not a view-only presentation value.
    expect(intents[0]!.attributes.fillOpacity).toBe(0.4);
    expect(intents[0]!.attributes.autoColorEnabled).toBe(false);
    expect(intents[0]!.editTime.year).toBe(1573);
  });

  it('turning auto-color OFF in the section releases the fill picker (FR-102)', () => {
    // featureA has autoColorEnabled=true (color fixture). The section shows the
    // pickers read-only until auto-color is toggled OFF — one permission gate.
    renderPanel(makeStore({ active: true }));
    expect(screen.getByLabelText(STYLE_STRINGS.fillColorLabel)).toBeDisabled();
    fireEvent.click(screen.getByLabelText(STYLE_STRINGS.autoColorLabel)); // ON -> OFF
    expect(screen.getByLabelText(STYLE_STRINGS.fillColorLabel)).toBeEnabled();
  });
});

describe('PropertyPanel — detail open (FR-99後段)', () => {
  it('the 詳細表示 button requests opening a detail panel for the feature', () => {
    const onOpenDetail = vi.fn();
    renderPanel(makeStore({ active: true }), undefined, onOpenDetail);
    fireEvent.click(screen.getByTestId('open-detail-button'));
    expect(onOpenDetail).toHaveBeenCalledWith(fA);
  });
});

// HB3-12: the存続期間編集 control wires the anchor list's per-anchor 開始/終了/削除
// buttons to the host's AnchorIntervalEditDispatch (the SAME single-dispatch discipline
// the attribute save uses, 教訓 5.6). These prove the UI ASSEMBLES + DISPATCHES the
// correct typed intent (the command-base then runs the U09 op — covered by
// consistency-binding.test.tsx). The editor is gated on editable mode + a wired dispatch
// (no dead control, 教訓 5.7 / 5.13).
/**
 * 存続期間エディタを見るための描画。
 *
 * **増分 2 で、エディタは「選ばれている錨 1 本ぶんだけ」一覧の下に出るようになった。**
 * 錨表の行を 28px 固定にして仮想スクロールするためで、行の中に畳んだエディタを
 * 埋めると行の高さが可変になって成り立たない（設計書 §C.6 の錨表の規模）。
 * だからテストも「さわる錨を選ぶ」ところから始める——実利用の手順と同じである。
 */
function renderPanelWithInterval(
  store: ReturnType<typeof makeStore>,
  anchorIntervalDispatch: AnchorIntervalEditDispatch,
  selectAnchor: 'a1' | 'a2' | null = 'a1',
) {
  const view = render(
    <PropertyPanel
      store={store}
      featureLookup={featureLookup}
      anchorLookup={anchorLookup}
      editDispatch={{ dispatchEdit: () => {} }}
      anchorIntervalDispatch={anchorIntervalDispatch}
      calendar={cal}
      ownerLookup={ownerLookup}
    />,
  );
  if (selectAnchor !== null && screen.queryByTestId(`anchor-row-${selectAnchor}`) !== null) {
    fireEvent.click(screen.getByTestId(`anchor-row-${selectAnchor}`));
  }
  return view;
}

describe('PropertyPanel — 存続期間編集 wiring (HB3-12 / FR-70, 教訓 5.7)', () => {
  it('反映 on 開始 dispatches a changeStart intent for that anchor', () => {
    const intents: AnchorIntervalEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanelWithInterval(store, { dispatchAnchorInterval: (i) => intents.push(i) });

    // seriesFor() anchor a1 starts 1560年1月1日; edit the year to 1500 and 反映.
    fireEvent.change(screen.getByTestId('anchor-interval-start-a1-year'), {
      target: { value: '1500' },
    });
    fireEvent.click(screen.getByTestId('anchor-interval-start-a1-confirm'));

    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.op).toBe(ANCHOR_INTERVAL_OP.ChangeStart);
    expect(intent.featureId).toBe(fA);
    expect(intent.anchorId).toBe('a1');
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart.year).toBe(1500);
    }
  });

  it('FR-70: editing the 開始 day dispatches a yearMonthDay start (月日粒度が届く)', () => {
    const intents: AnchorIntervalEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanelWithInterval(store, { dispatchAnchorInterval: (i) => intents.push(i) });

    // a1 seeds as 1560年1月1日 (month/day already 指定); change the day to 15.
    fireEvent.change(screen.getByTestId('anchor-interval-start-a1-day'), {
      target: { value: '15' },
    });
    fireEvent.click(screen.getByTestId('anchor-interval-start-a1-confirm'));

    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart.granularity).toBe('yearMonthDay');
      expect(intent.newStart).toEqual(timePointYearMonthDay(1560, 1, 15));
    }
  });

  it('FR-70: turning 月 未指定 dispatches a year-granularity start (後方互換)', () => {
    const intents: AnchorIntervalEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanelWithInterval(store, { dispatchAnchorInterval: (i) => intents.push(i) });

    // a1 seeds yearMonthDay(1560,1,1); 月を未指定に戻す (日も未指定になる) → 年粒度.
    fireEvent.click(screen.getByTestId('anchor-interval-start-a1-month-toggle'));
    fireEvent.click(screen.getByTestId('anchor-interval-start-a1-confirm'));

    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart.granularity).toBe('year');
      expect(intent.newStart).toEqual(timePointYear(1560));
    }
  });

  it('反映 on 終了 dispatches a setEnd intent; 継続中にする clears it (null)', () => {
    const intents: AnchorIntervalEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanelWithInterval(store, { dispatchAnchorInterval: (i) => intents.push(i) });

    fireEvent.change(screen.getByTestId('anchor-interval-end-a1-year'), {
      target: { value: '1570' },
    });
    fireEvent.click(screen.getByTestId('anchor-interval-end-a1-confirm'));
    fireEvent.click(screen.getByTestId('anchor-interval-end-a1-clear'));

    expect(intents).toHaveLength(2);
    const setEndIntent = intents[0]!;
    expect(setEndIntent.op).toBe(ANCHOR_INTERVAL_OP.SetEnd);
    if (setEndIntent.op === ANCHOR_INTERVAL_OP.SetEnd) {
      expect(setEndIntent.newEnd?.year).toBe(1570);
    }
    const clearIntent = intents[1]!;
    expect(clearIntent.op).toBe(ANCHOR_INTERVAL_OP.SetEnd);
    if (clearIntent.op === ANCHOR_INTERVAL_OP.SetEnd) {
      expect(clearIntent.newEnd).toBeNull();
    }
  });

  it('この錨を削除 dispatches a delete intent (series has >1 anchor so the button is enabled)', () => {
    const intents: AnchorIntervalEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanelWithInterval(store, { dispatchAnchorInterval: (i) => intents.push(i) }, 'a2');

    const del = screen.getByTestId('anchor-interval-delete-a2');
    expect(del).toBeEnabled(); // 2-anchor series: not the sole anchor.
    fireEvent.click(del);

    // **増分 7 の中身 7**: 押した瞬間には消さず、影響の一覧を出してから確定する
    // （N-05 / 設計書 §A.3。器は地物・輪郭・頂点の削除と同じ 1 つ）。
    expect(intents).toHaveLength(0);
    expect(screen.getByTestId('anchor-delete-impact')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anchor-delete-impact-confirm'));

    expect(intents).toHaveLength(1);
    expect(intents[0]!.op).toBe(ANCHOR_INTERVAL_OP.Delete);
    expect(intents[0]!.anchorId).toBe('a2');
  });

  it('surfaces the dispatch rejection message inline (honest failure, 教訓 5.26)', () => {
    const store = makeStore({ active: true });
    renderPanelWithInterval(store, {
      dispatchAnchorInterval: () => {
        throw new Error('存続期間を変更できません: テスト拒否');
      },
    });
    fireEvent.click(screen.getByTestId('anchor-interval-start-a1-confirm'));
    expect(screen.getByTestId('anchor-interval-message-a1')).toHaveTextContent(
      'テスト拒否',
    );
  });

  it('does NOT render the存続期間 editor without a wired dispatch (no dead control, 教訓 5.7)', () => {
    renderPanel(makeStore({ active: true }));
    expect(screen.queryByTestId('anchor-interval-a1')).not.toBeInTheDocument();
  });

  it('does NOT render the存続期間 editor in view mode (whole-form gate, 教訓 5.13)', () => {
    renderPanelWithInterval(makeStore({ active: true, mode: 'view' }), {
      dispatchAnchorInterval: () => {},
    });
    expect(screen.queryByTestId('anchor-interval-a1')).not.toBeInTheDocument();
  });
});

// FR-20 / FR-35: a 面 feature's プロパティパネル shows its 面積（km²）as a read-only
// derived row, for BOTH a 末端 (leaf) AND an 集約 (aggregate) feature. The value comes
// from the HOST's `resolveAreaKm2(id)` port (which resolves the live shape + geoParams
// via the single truth source — see SidebarContent tests) — this unit only asks by ID
// and displays. It re-derives when the port returns a new value (a structural / 赤道長
// change swaps the port reference upstream). Point / line features have no area and
// never show the row; an unwired / undefined port shows no row (honest-stub).
describe('PropertyPanel — 面情報の面積表示 (FR-20 / FR-35)', () => {
  const GEO = createGeoParams(40000, 0.0034);

  // The leaf fixture's resolved shape area (the value the real host would compute).
  const LEAF_AREA = shapeAreaKm2(
    createShape([createTerritoryRing(asRingId('L-r1'), [vL1, vL2, vL3, vL4])]),
    resolveLeafVertex,
    GEO,
  );

  function makeLeafStore() {
    return createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: { mode: EDIT_MODE.Edit, activeFeature: fL },
    });
  }

  function renderAreaPanel(
    store: ReturnType<typeof makeLeafStore>,
    resolveAreaKm2: (id: FeatureId) => number | undefined,
  ) {
    return render(
      <PropertyPanel
        store={store}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
        resolveAreaKm2={resolveAreaKm2}
      />,
    );
  }

  it('shows the 面積 row for a leaf feature with the value the port returns', () => {
    renderAreaPanel(makeLeafStore(), () => LEAF_AREA);
    expect(screen.getByTestId('area-row')).toBeInTheDocument();
    expect(screen.getByTestId('area-value')).toHaveTextContent(formatAreaKm2(LEAF_AREA));
  });

  it('re-derives the 面積 when the port returns a NEW value (FR-109 / 構造編集後, 教訓 5.3)', () => {
    // The panel is keyed to the target ID, so a re-render that swaps the resolver
    // (the host does this on a 赤道長 change OR a structural edit — the domain
    // reference changes) MUST reflect the new value, proving the display is derived
    // from the live port, not cached against the feature object (bughunt review 穴1).
    const store = makeLeafStore();
    const { rerender } = renderAreaPanel(store, () => LEAF_AREA);
    expect(screen.getByTestId('area-value')).toHaveTextContent(formatAreaKm2(LEAF_AREA));

    const bigger = LEAF_AREA * 4;
    rerender(
      <PropertyPanel
        store={store}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
        resolveAreaKm2={() => bigger}
      />,
    );
    expect(screen.getByTestId('area-value')).toHaveTextContent(formatAreaKm2(bigger));
  });

  it('shows the 面積 row for an AGGREGATE feature too (FR-35, bughunt review 穴2)', () => {
    // The panel is NOT leaf-gated: any feature id whose port returns a value shows the
    // row. featureA stands in as the selected feature; the host would resolve an
    // aggregate's child-union area — here the port returns it directly.
    const AGG_AREA = LEAF_AREA * 3;
    render(
      <PropertyPanel
        store={makeStore({ active: true })}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
        resolveAreaKm2={(id) => (id === fA ? AGG_AREA : undefined)}
      />,
    );
    expect(screen.getByTestId('area-row')).toBeInTheDocument();
    expect(screen.getByTestId('area-value')).toHaveTextContent(formatAreaKm2(AGG_AREA));
  });

  it('does NOT show the 面積 row when the port returns undefined (point/line — no area)', () => {
    // A point / line — or any feature the host resolves as arealess — yields undefined.
    render(
      <PropertyPanel
        store={makeStore({ active: true })}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
        resolveAreaKm2={() => undefined}
      />,
    );
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();
    expect(screen.queryByTestId('area-row')).not.toBeInTheDocument();
  });

  it('does NOT show the 面積 row when the host has not wired the area port (honest-stub)', () => {
    // No resolveAreaKm2: the feature still renders, but with no fabricated area value
    // (no dead / guessed row, 教訓 5.7).
    render(
      <PropertyPanel
        store={makeLeafStore()}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
      />,
    );
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();
    expect(screen.queryByTestId('area-row')).not.toBeInTheDocument();
  });
});

// bughunt 第12波 #1 (HIGH — データ安全): a多錨 feature carries a DIFFERENT full-state
// snapshot at each anchor. The production FeatureLookup resolves featuresAt(root, TIME),
// a TIME-DEPENDENT snapshot, but the composition root memoizes the lookup WITHOUT
// currentTime (stable reference). Keying the panel's `feature` memo only to
// [featureLookup, targetFeatureId] froze it at the SELECTION-time snapshot even after
// the current time — and thus the edit-target anchor / editTime — advanced. A save then
// wrote the frozen earlier-anchor attributes onto the later anchor, DESTROYING it. These
// tests use a TIME-DEPENDENT lookup (mirroring production) to prove the save now carries
// the CURRENT anchor's snapshot, and that the draft re-seeds on the anchor change.
describe('PropertyPanel — 多錨 time-move save integrity (bughunt 第12波 #1, HIGH)', () => {
  const fM = asFeatureId('M');
  const vM = asVertexId('M-v');

  // Alpha = the snapshot effective at anchor a1 (100..200); Beta = at a2 (200..).
  // They differ in EVERY basic field so a stale write is unambiguous.
  const ALPHA = createPointFeature(
    fM,
    createBasicAttributes('Alpha', 100, 200),
    createColorInfo(false, '#aa0000', '#aa1111', '#aa2222'),
    vM,
  );
  const BETA = createPointFeature(
    fM,
    createBasicAttributes('Beta', 200, 300),
    createColorInfo(false, '#00bb00', '#00bb11', '#00bb22'),
    vM,
  );

  function multiSeries(): AnchorSeries {
    const snap = createAnchorSnapshot([], createVertexStore([]));
    return {
      entries: [
        createAnchorEntry(createAnchor(asAnchorId('a1'), snap), timePointYear(100), timePointYear(200)),
        createAnchorEntry(createAnchor(asAnchorId('a2'), snap), timePointYear(200), null),
      ],
    };
  }

  const anchorLookupM: AnchorSeriesLookup = {
    anchorSeriesOf: (id) => (id === fM ? multiSeries() : null),
  };

  // A TIME-DEPENDENT lookup mirroring production (SidebarContent.featureLookupOf →
  // featuresAt(getRoot(), getTime())): it resolves the feature snapshot at the store's
  // CURRENT time. Returns a FRESH object each call (id-equal but reference-new), like the
  // real domain lookup. The OBJECT REFERENCE stays stable across a time change would be
  // the bug's precondition — but the value it returns depends on the time.
  function timeDependentLookup(store: ReturnType<typeof makeStore>): FeatureLookup {
    return {
      featureAt: (id) => {
        if (id !== fM) return null;
        const t = store.getState().currentTime;
        // < 200 → anchor a1 (Alpha); >= 200 → anchor a2 (Beta).
        return t.year < 200 ? ALPHA : BETA;
      },
    };
  }

  function makeMultiStore() {
    return createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: {
        mode: EDIT_MODE.Edit,
        activeFeature: fM,
        currentTime: timePointYear(100),
      },
    });
  }

  function renderMulti(
    store: ReturnType<typeof makeMultiStore>,
    dispatch: EditDispatch,
  ) {
    return render(
      <PropertyPanel
        store={store}
        featureLookup={timeDependentLookup(store)}
        anchorLookup={anchorLookupM}
        editDispatch={dispatch}
        calendar={cal}
        ownerLookup={ownerLookup}
      />,
    );
  }

  it('after a time move 100→200 the form re-seeds to the CURRENT anchor snapshot (Beta, not Alpha)', () => {
    const store = makeMultiStore();
    renderMulti(store, { dispatchEdit: () => {} });

    // At time 100 the form shows the a1 snapshot (Alpha).
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('Alpha');
    expect(screen.getByTestId('decorative-start-year')).toHaveTextContent('100');

    // Move the current time forward to the a2 interval (as the timeline slider would).
    act(() => {
      store.getState().setCurrentTime(timePointYear(200), TIME_CHANGE_SOURCE.AnchorSync);
    });

    // The form must now reflect the a2 snapshot (Beta), NOT the frozen Alpha.
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('Beta');
    expect(screen.getByTestId('decorative-start-year')).toHaveTextContent('200');
    expect(screen.getByTestId('decorative-end-year')).toHaveTextContent('300');
  });

  it('editing ONE field after a time move saves the CURRENT anchor (Beta) attributes at editTime=200 — never the frozen Alpha', () => {
    const intents: PropertyEditIntent[] = [];
    const store = makeMultiStore();
    renderMulti(store, { dispatchEdit: (i) => intents.push(i) });

    // Move to the a2 interval, then rename ONLY the name.
    act(() => {
      store.getState().setCurrentTime(timePointYear(200), TIME_CHANGE_SOURCE.AnchorSync);
    });
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'Gamma' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    // editTime is the CURRENT anchor's start (a2 = 200), 教訓 5.15.
    expect(intent.editTime.year).toBe(200);
    // The edited field carries the new value…
    expect(intent.attributes.name).toBe('Gamma');
    // …but EVERY un-edited field carries BETA's snapshot, NOT the frozen Alpha's.
    // Before the fix the draft/feature were frozen at Alpha, so these would be
    // Alpha's #aa* — overwriting Beta on save (the data-loss bug).
    expect(intent.attributes.fillColor).toBe('#00bb00');
    expect(intent.attributes.borderColor).toBe('#00bb22');
    expect(intent.featureId).toBe(fM);
  });

  it('a no-op save (unchanged) after a time move does not dispatch — the baseline is the CURRENT anchor (Beta)', () => {
    // The no-op guard compares the draft to the CURRENT feature (Beta). If the draft
    // had stayed frozen at Alpha the guard would see a "change" (Alpha≠Beta) and
    // dispatch a ghost Alpha→Beta overwrite. Re-seeding to Beta makes an untouched
    // save a true no-op.
    const intents: PropertyEditIntent[] = [];
    const store = makeMultiStore();
    renderMulti(store, { dispatchEdit: (i) => intents.push(i) });

    act(() => {
      store.getState().setCurrentTime(timePointYear(200), TIME_CHANGE_SOURCE.AnchorSync);
    });
    fireEvent.click(screen.getByTestId('save-button')); // nothing changed
    expect(intents).toHaveLength(0);
  });
});

// 増分 2 の手直し A7 / GPT#8 — 飾りの開始年／終了年は **保存の対象ではない**。
//
// 旧: この 2 欄は type=number の入力欄で、巨大整数・負巨大・小数を受理していた
// （bughunt 第12波 #2。READ 側 schema が load 時に manifest 全体を拒否し .gimoza が
// 二度と開けなくなる）。handleSave に isPersistedYear のガードを置いて塞いでいた。
// 新: **入力欄そのものを無くした。** 設計書 §C.6 の契約（保存の対象は名前・種別ラベル・
// 見た目・詳細文書の 4 つ）に型と画面を合わせたので、「表示専用の飾り」と説明した欄を
// 触っただけで現在年に錨が立つ、という事故ごと消えている。値は U-28 に従って
// 折りたたみの中に読み取り専用で出す。
describe('PropertyPanel — 飾りの開始年／終了年は読み取り専用（A7 / GPT#8）', () => {
  function renderYearPanel(dispatch: EditDispatch) {
    const store = makeStore({ active: true });
    render(
      <PropertyPanel
        store={store}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={dispatch}
        calendar={cal}
        ownerLookup={ownerLookup}
      />,
    );
    fireEvent.click(screen.getByTestId('anchor-row-a1')); // establish an edit target
  }

  it('入力欄が無い（触れないので範囲外の年を書き込めない）', () => {
    renderYearPanel({ dispatchEdit: () => undefined });
    expect(screen.queryByLabelText(PROPERTY_STRINGS.startYearLabel)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(PROPERTY_STRINGS.endYearLabel)).not.toBeInTheDocument();
  });

  it('値は畳んだ「詳しい属性」に読み取り専用で出る（U-28）', () => {
    renderYearPanel({ dispatchEdit: () => undefined });
    expect(screen.getByTestId('decorative-start-year')).toBeInTheDocument();
    expect(screen.getByTestId('decorative-end-year')).toBeInTheDocument();
  });

  it('保存の意図に開始年／終了年は載らない（保存の対象は 4 つだけ）', () => {
    const intents: PropertyEditIntent[] = [];
    renderYearPanel({ dispatchEdit: (i) => intents.push(i) });
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '新しい名前' },
    });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(intents).toHaveLength(1);
    expect(Object.keys(intents[0]!.attributes).sort()).toEqual(
      [
        'autoColorEnabled',
        'borderColor',
        'detailDocument',
        'fillColor',
        'fillOpacity',
        'kindLabel',
        'name',
        'paletteTheme',
        'selectedColor',
        'selectedOpacity',
      ].sort(),
    );
  });
});

// F1 (FR-70 Codex 敵対レビュー, HIGH — 存続期間データ安全): after a 存続期間 edit the panel
// must RE-DERIVE the shown series. Production memoizes the anchorLookup with a STABLE
// identity (SidebarContent.anchorLookupOf(getRoot) is built ONCE in buildSidebarContent,
// whose useMemo deps EXCLUDE the domain) and the host (PropertyPanelHost) re-renders the
// panel on every committed-domain swap. Keying the panel's `series` memo only to
// [anchorLookup, targetFeatureId] therefore FROZE it at the pre-edit series: a「継続中に
// する」that stored end=null still displayed the old bounded end, and re-「反映」re-closed
// it (data corruption). This harness mirrors production: a STABLE live-store anchorLookup
// + a host subscribed to the domain, driving a REAL setEnd through the store swap. It can
// NOT be caught by the AnchorList-only harness (which feeds the series via React state).
describe('PropertyPanel — 存続期間編集後の series 再導出 (F1, HIGH — production wiring)', () => {
  const fF = asFeatureId('F');
  const vF = asVertexId('F-v1');

  // A minimal live domain: exactly the slice the production anchorLookup reads
  // (root.histories[].series), so setDomainState can swap it while selection/time hold.
  type LiveDomain = {
    readonly histories: readonly { readonly featureId: FeatureId; readonly series: AnchorSeries }[];
  };

  function boundedSeries(): AnchorSeries {
    // 「続く」行は **その地物がその錨に居るか** を見て区間を切る（B3）ので、
    // スナップショットに当の地物を入れておく（本物の系列と同じ形）。
    const snap = createAnchorSnapshot([featureFF()], createVertexStore([]));
    return {
      entries: [
        createAnchorEntry(
          createAnchor(asAnchorId('a1'), snap),
          timePointYear(1000),
          timePointYear(2000),
        ),
      ],
    };
  }

  function featureFF(): Feature {
    return createPointFeature(fF, createBasicAttributes('継続テスト', 1000, 2000), color, vF);
  }

  function makeLiveStore() {
    return createSessionStore<LiveDomain>({
      initialDomain: { histories: [{ featureId: fF, series: boundedSeries() }] },
      initial: {
        mode: EDIT_MODE.Edit,
        activeFeature: fF,
        currentTime: timePointYear(1500),
      },
    });
  }

  // Mirrors SidebarContent.PropertyPanelHost: (1) a STABLE anchorLookup reading the LIVE
  // store domain (identity fixed across swaps — memoized on [store], NOT the domain), (2)
  // a host subscription to `domain` so the panel re-renders on a commit, and (3) a real
  // setEnd dispatch that swaps the domain via setDomainState (selection/time preserved).
  function LiveHost(props: { readonly store: ReturnType<typeof makeLiveStore> }): JSX.Element {
    const { store } = props;
    useStore(store, (s) => s.domain); // re-render the host (hence the panel) on a swap

    const anchorLookup = useMemo<AnchorSeriesLookup>(
      () => ({
        anchorSeriesOf: (id) =>
          store.getState().domain.histories.find((h) => h.featureId === id)?.series ?? null,
      }),
      [store],
    );
    const liveFeatureLookup = useMemo<FeatureLookup>(
      () => ({ featureAt: (id) => (id === fF ? featureFF() : null) }),
      [],
    );
    const anchorIntervalDispatch = useMemo<AnchorIntervalEditDispatch>(
      () => ({
        dispatchAnchorInterval: (intent) => {
          if (intent.op !== ANCHOR_INTERVAL_OP.SetEnd) return;
          const root = store.getState().domain;
          const history = root.histories.find((h) => h.featureId === intent.featureId);
          if (history === undefined) return;
          const result = setEnd(history.series, intent.anchorId, intent.newEnd, cal);
          if (!result.ok) throw new Error('rejected');
          store.getState().setDomainState({
            histories: root.histories.map((h) =>
              h.featureId === intent.featureId
                ? { featureId: h.featureId, series: result.series }
                : h,
            ),
          });
        },
      }),
      [store],
    );

    return (
      <PropertyPanel<LiveDomain>
        store={store}
        featureLookup={liveFeatureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        anchorIntervalDispatch={anchorIntervalDispatch}
        calendar={cal}
        ownerLookup={ownerLookup}
      />
    );
  }

  it('継続中にしたあと、錨の行と「続く」行の両方が作り直される（古い終了年で凍らない）', () => {
    const store = makeLiveStore();
    render(<LiveHost store={store} />);

    // The a1 row initially shows its bounded end (…2000年).
    const rowBefore = screen.getByTestId('anchor-row-a1');
    expect(rowBefore).toHaveTextContent('2000');
    // 本物の存続期間の行（増分 2 で初期表示へ出したもの。裁定 §N-5）も終わりを言っている。
    expect(screen.getByTestId('existence-value')).toHaveTextContent('2000');

    // 継続中にする through the wired dispatch → the domain now stores end=null.
    act(() => {
      fireEvent.click(screen.getByTestId('anchor-interval-end-a1-clear'));
    });

    // The store IS updated…
    expect(store.getState().domain.histories[0]!.series.entries[0]!.end).toBeNull();
    // …and the panel's series memo RE-DERIVED. 錨の行は終了年を言わなくなり、
    // 「続く」行が継続中になる。**同じ系列から導く 2 つの表示が食い違わない**ことを見る。
    expect(screen.getByTestId('anchor-row-a1')).not.toHaveTextContent('2000');
    expect(screen.getByTestId('existence-value')).toHaveTextContent(
      PROPERTY_STRINGS.existenceOpenEnd,
    );
  });

  it('re-「反映」on the end after 継続中にする does NOT re-close the interval (round-trip safe, F1+F2)', () => {
    const store = makeLiveStore();
    render(<LiveHost store={store} />);

    // Make the anchor 継続中.
    act(() => {
      fireEvent.click(screen.getByTestId('anchor-interval-end-a1-clear'));
    });
    expect(store.getState().domain.histories[0]!.series.entries[0]!.end).toBeNull();

    // The re-seeded end editor now models 継続中 directly (F2): 反映 is disabled, and
    // clicking it dispatches NO concrete setEnd — the open interval stays open. Before the
    // fixes the panel showed the frozen bounded end (F1), so 反映 re-dispatched setEnd and
    // silently re-closed the interval (存続期間データ破損).
    const confirm = screen.getByTestId('anchor-interval-end-a1-confirm');
    expect(confirm).toBeDisabled();
    act(() => {
      fireEvent.click(confirm);
    });
    expect(store.getState().domain.histories[0]!.series.entries[0]!.end).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 増分 2 — 編集時刻の一本化と、行き先の明示
// ---------------------------------------------------------------------------
//
// ここから下は実装計画 増分 2（設計書 §D.3 / 裁定 §N-2 の (A)）の受け入れ条件を
// 固定する。**以前は保存が「選んでいる錨の開始年」に効いていた**ので、画面に 1200 年と
// 出ていても 0 年の錨が黙って書き換わった。この変更は危険を裏返しにする（上書きの
// つもりが錨を増やす）ので、裁定は「押す前に行き先を必ず見せる」ことを条件にしている。

/** 現在時刻を指定してストアを作る（錨を選ばずに年を動かす経路を見るため）。 */
function storeAt(time: TimePoint) {
  return createSessionStore<Record<string, never>>({
    initialDomain: {},
    initial: { mode: EDIT_MODE.Edit, activeFeature: fA, currentTime: time },
  });
}

describe('増分 2 — 編集時刻は常に現在時刻（設計書 §D.3 / FR-57）', () => {
  it('錨の無い年で保存すると、**その年**を編集時刻として送る（錨の開始年ではない）', () => {
    const intents: PropertyEditIntent[] = [];
    // 系列の錨は 1560 と 1573。1200 年には錨が無い。
    renderPanel(storeAt(timePointYear(1200)), { dispatchEdit: (i) => intents.push(i) });

    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '尾張国' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    expect(intents).toHaveLength(1);
    expect(intents[0]!.editTime).toEqual(timePointYear(1200));
  });

  it('送る時刻は **年だけ**（錨の開始に月日を焼き付けない、U-14）', () => {
    const intents: PropertyEditIntent[] = [];
    // 錨を選ぶと現在時刻は 1573年1月1日（年月日粒度）へ同期する。
    renderPanel(makeStore({ active: true }), { dispatchEdit: (i) => intents.push(i) });
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '尾張国' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    expect(intents).toHaveLength(1);
    expect(intents[0]!.editTime.granularity).toBe('year');
    expect(intents[0]!.editTime).toEqual(timePointYear(1573));
  });

  // A3: 上書きのときは、その錨の開始と同じ時刻をそのまま渡す（年ちょうどなら年へ
  // 丸める＝上の 1 本）。**年ちょうどでない開始を持つ錨だけが編集できない**のを直した。

  it('保存の対象に種別ラベルと詳細文書が含まれる（設計書 §C.6 の「保存の対象」）', () => {
    const intents: PropertyEditIntent[] = [];
    renderPanel(storeAt(timePointYear(1200)), { dispatchEdit: (i) => intents.push(i) });

    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.kindLabelLabel), {
      target: { value: '国' },
    });
    fireEvent.click(screen.getByTestId('detail-doc-mode-edit'));
    fireEvent.change(screen.getByTestId('detail-doc-textarea'), {
      target: { value: '本文' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    // **1 回の押下で 1 つの取り消し単位**（N-46: 保存の契機が 2 つに割れていた）。
    expect(intents).toHaveLength(1);
    expect(intents[0]!.attributes.kindLabel).toBe('国');
    expect(intents[0]!.attributes.detailDocument).toBe('本文');
  });

  it('詳細文書に専用の保存ボタンは無い（N-46 を揃えた結果）', () => {
    renderPanel(storeAt(timePointYear(1200)));
    fireEvent.click(screen.getByTestId('detail-doc-mode-edit'));
    expect(screen.queryByTestId('detail-doc-save')).not.toBeInTheDocument();
  });
});

describe('増分 2 — 編集時刻バッジと保存ボタンの文言が 4 通りに変わる', () => {
  it('①その年に錨がある ⇒ 上書きと書いてある', () => {
    renderPanel(makeStore({ active: true }));
    fireEvent.click(screen.getByTestId('anchor-row-a1')); // 1560 へ同期
    expect(screen.getByTestId('save-button')).toHaveTextContent('1560年の錨を上書き保存');
    expect(screen.getByTestId('edit-time-badge')).toHaveAttribute('data-plan', 'overwrite');
  });

  it('②その年に錨が無い ⇒ 新しく作ると書いてある', () => {
    renderPanel(storeAt(timePointYear(1200)));
    expect(screen.getByTestId('save-button')).toHaveTextContent('1200年に錨を作って保存');
    expect(screen.getByTestId('edit-time-badge')).toHaveAttribute('data-plan', 'newAnchor');
    expect(screen.getByTestId('edit-time-badge-note')).toHaveTextContent('錨を新しく作ります');
  });

  it('③年ちょうどでない ⇒ 押せない。理由と「年に丸める」が出る', () => {
    const store = storeAt(timePointYearMonthDay(5080, 12, 31));
    renderPanel(store);
    expect(screen.getByTestId('save-button')).toBeDisabled();
    expect(screen.getByTestId('save-disabled-reason')).toHaveTextContent('5080年12月31日');
    expect(screen.getByTestId('edit-time-badge')).toHaveAttribute('data-plan', 'notYearAligned');

    // 丸めると理由が消える（「次の一手をボタンにする」、設計書 §H.5）。
    fireEvent.click(screen.getByTestId('round-to-year-button'));
    expect(store.getState().currentTime).toEqual(timePointYear(5080));
    expect(screen.queryByTestId('save-disabled-reason')).not.toBeInTheDocument();
    // まだ値を変えていないので押せない（A6）。何か直せば押せる。
    expect(screen.getByTestId('save-no-change-note')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '尾張国' },
    });
    expect(screen.getByTestId('save-button')).toBeEnabled();
  });

  it('④その年に地物が無い ⇒ 素性欄そのものが案内文になり、保存列は出ない', () => {
    // 実アプリでは時刻が動くと選択が外れるので、この状態は現在とどきにくいが、
    // 「押せないなら理由を必ず出す」規則を素性欄側で固定しておく（増分 5 の裁定 3
    // で「読むだけでも選べる」になると到達しやすくなる）。
    const store = makeStore({ active: true });
    render(
      <PropertyPanel
        store={store}
        featureLookup={{ featureAt: () => null }}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
      />,
    );
    // 地物が解決できないとパネルは案内文になる（現行の振る舞い）。
    expect(screen.getByTestId('property-guidance')).toBeInTheDocument();
    expect(screen.queryByTestId('save-button')).not.toBeInTheDocument();
  });
});

describe('増分 2 — 打ちかけの内容は、時間を動かしても黙って消えない（N-04）', () => {
  it('名前を打ちかけて時間を動かすと確認が出て、下書きは残る', () => {
    const store = storeAt(timePointYear(1200));
    renderPanel(store);

    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '打ちかけ' },
    });
    act(() => {
      store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.Slider);
    });

    expect(screen.getByTestId('draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('打ちかけ');
  });

  it('「元の場所へ戻る」で、打っていた年へ戻って続きが打てる', () => {
    const store = storeAt(timePointYear(1200));
    renderPanel(store);
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '打ちかけ' },
    });
    act(() => {
      store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.Slider);
    });

    fireEvent.click(screen.getByTestId('draft-discard-keep'));
    expect(store.getState().currentTime).toEqual(timePointYear(1200));
    expect(screen.queryByTestId('draft-discard-confirm')).not.toBeInTheDocument();
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('打ちかけ');
  });

  it('「捨てる」で、移った先の姿へ作り直される', () => {
    const store = storeAt(timePointYear(1200));
    renderPanel(store);
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '打ちかけ' },
    });
    act(() => {
      store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.Slider);
    });

    fireEvent.click(screen.getByTestId('draft-discard-drop'));
    expect(screen.queryByTestId('draft-discard-confirm')).not.toBeInTheDocument();
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('織田領');
  });

  it('打ちかけが無ければ確認は出ない（連拍で邪魔にならない）', () => {
    const store = storeAt(timePointYear(1200));
    renderPanel(store);
    act(() => {
      store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.Slider);
    });
    expect(screen.queryByTestId('draft-discard-confirm')).not.toBeInTheDocument();
  });
});

describe('増分 2 — 集約地物の下位領域でも錨の欄が消えない（設計書 §C.6 / 裁定 §N-15）', () => {
  const fChild = asFeatureId('child');
  const fParent = asFeatureId('parent');
  const vChild = asVertexId('child-v1');

  function childNamed(name: string): Feature {
    return createPointFeature(fChild, createBasicAttributes(name, 0, 9999), color, vChild);
  }
  function parentFeature(): Feature {
    return createPointFeature(
      fParent,
      createBasicAttributes('デーレ共和国', 0, 9999),
      color,
      asVertexId('parent-v1'),
    );
  }

  /** 親の系列: 0 年に子が現れ、1200 年に子が改名、2000 年は子に関係ない変化。 */
  function parentSeries(): AnchorSeries {
    const mk = (year: number, childName: string, parentName: string) =>
      createAnchorEntry(
        createAnchor(
          asAnchorId(`p${String(year)}`),
          createAnchorSnapshot(
            [
              childNamed(childName),
              createPointFeature(
                fParent,
                createBasicAttributes(parentName, 0, 9999),
                color,
                asVertexId('parent-v1'),
              ),
            ],
            createVertexStore([]),
          ),
        ),
        timePointYear(year),
        null,
      );
    return {
      entries: [
        mk(0, 'アアウェン州', 'デーレ共和国'),
        mk(1200, '北アアウェン州', 'デーレ共和国'),
        mk(2000, '北アアウェン州', 'デーレ連邦'),
      ],
    };
  }

  const inheritedLookup: AnchorSeriesLookup = {
    // 子は **自分の系列を持たない**（実データの 86 件と同じ形）。
    anchorSeriesOf: () => null,
    governingSeriesOf: (id) =>
      id === fChild
        ? {
            series: parentSeries(),
            ownerFeatureId: fParent,
            ownerName: 'デーレ共和国',
            effectiveSize: { featureCount: 61, vertexCount: 3067 },
          }
        : null,
  };

  function renderChildPanel(time: TimePoint) {
    const store = createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: { mode: EDIT_MODE.Edit, activeFeature: fChild, currentTime: time },
    });
    render(
      <PropertyPanel
        store={store}
        featureLookup={{ featureAt: (id) => (id === fChild ? childNamed('北アアウェン州') : id === fParent ? parentFeature() : null) }}
        anchorLookup={inheritedLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookupFromMap(new Map([[vChild, fChild]]))}
      />,
    );
    return store;
  }

  it('錨の欄が出て、誰が歴史を持っているかを名前つきで書く', () => {
    renderChildPanel(timePointYear(1200));
    expect(screen.getByTestId('anchor-list')).toBeInTheDocument();
    expect(screen.getByTestId('inherited-anchor-notice')).toHaveTextContent('デーレ共和国');
  });

  it('**その子に関わる錨だけ**が出る（他人の変化を混ぜない）', () => {
    renderChildPanel(timePointYear(1200));
    expect(screen.getByTestId('anchor-row-p0')).toBeInTheDocument();
    expect(screen.getByTestId('anchor-row-p1200')).toBeInTheDocument();
    // 2000 年は親の改名だけなので、この子の画面には出ない。
    expect(screen.queryByTestId('anchor-row-p2000')).not.toBeInTheDocument();
  });

  it('行に差分の文が出る（N-45）', () => {
    renderChildPanel(timePointYear(1200));
    expect(screen.getByTestId('anchor-diff-p1200')).toHaveTextContent('名前が変わった');
  });

  it('保存の行き先は **親の系列** で判定する（教訓 5.46）', () => {
    // 1200 年には親の系列に錨がある ⇒ 上書き。子の系列だけを見ていたら
    // （null なので）常に「新設」になり、画面が実際の振る舞いと食い違う。
    renderChildPanel(timePointYear(1200));
    expect(screen.getByTestId('edit-time-badge')).toHaveAttribute('data-plan', 'overwrite');
  });

  it('錨の無い年では、増える保存量の概算を添える（設計書 §A.3）', () => {
    renderChildPanel(timePointYear(1500));
    const badge = screen.getByTestId('edit-time-badge');
    expect(badge).toHaveAttribute('data-plan', 'newAnchor');
    expect(screen.getByTestId('edit-time-badge-note')).toHaveTextContent('ファイルが');
    expect(screen.getByTestId('edit-time-badge-note')).toHaveTextContent('KB');
  });

  it('借り物の系列を子の画面から書き換えさせない（存続期間のエディタを出さない）', () => {
    const store = createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: { mode: EDIT_MODE.Edit, activeFeature: fChild, currentTime: timePointYear(1200) },
    });
    render(
      <PropertyPanel
        store={store}
        featureLookup={{ featureAt: () => childNamed('北アアウェン州') }}
        anchorLookup={inheritedLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        anchorIntervalDispatch={{ dispatchAnchorInterval: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookupFromMap(new Map([[vChild, fChild]]))}
      />,
    );
    expect(screen.queryByTestId('anchor-interval-p1200')).not.toBeInTheDocument();
  });
});

// 増分 2 の手直し A1 / A6 — 保存の「効く範囲」を押す前に見せる。
//
// 錨は「その時点の全体の写し」なので、いま見ている年より後ろの錨は **直す前の値の写し**
// を持っている。保存はその写しも「次にその属性が本当に変わる錨」まで引き継ぐので、
// **どこまで効くのかを押す前に文字で出す**（設計書 §D.3 の「危険と打ち消し方」）。
describe('PropertyPanel — 保存の効く範囲を押す前に見せる（A1 / A6）', () => {
  const fC = asFeatureId('C');
  const vC = asVertexId('C-v');
  const OLD = createPointFeature(
    fC,
    createBasicAttributes('旧名', 0, 0),
    createColorInfo(false, '#111111', '#222222', '#333333'),
    vC,
  );
  const RENAMED = createPointFeature(
    fC,
    createBasicAttributes('別の名前', 0, 0),
    createColorInfo(false, '#111111', '#222222', '#333333'),
    vC,
  );

  /** 0 年（旧名）・2000 年（旧名の写し）・3000 年（旧名の写し）・4000 年（本当の改名）。 */
  function carrySeries(): AnchorSeries {
    const withOld = createAnchorSnapshot([OLD], createVertexStore([]));
    const withNew = createAnchorSnapshot([RENAMED], createVertexStore([]));
    return {
      entries: [
        createAnchorEntry(createAnchor(asAnchorId('c0'), withOld), timePointYear(0), null),
        createAnchorEntry(createAnchor(asAnchorId('c2000'), withOld), timePointYear(2000), null),
        createAnchorEntry(createAnchor(asAnchorId('c3000'), withOld), timePointYear(3000), null),
        createAnchorEntry(createAnchor(asAnchorId('c4000'), withNew), timePointYear(4000), null),
      ],
    };
  }

  const carryLookup: AnchorSeriesLookup = {
    anchorSeriesOf: (id) => (id === fC ? carrySeries() : null),
  };
  const carryFeatureLookup: FeatureLookup = { featureAt: (id) => (id === fC ? OLD : null) };

  function renderCarry(currentYear: number) {
    const store = createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: {
        mode: EDIT_MODE.Edit,
        activeFeature: fC,
        currentTime: timePointYear(currentYear),
      },
    });
    render(
      <PropertyPanel
        store={store}
        featureLookup={carryFeatureLookup}
        anchorLookup={carryLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
      />,
    );
    return store;
  }

  it('改名すると、後ろの錨のうち書き換わるものがボタンに出る', () => {
    renderCarry(1000);
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '新名' },
    });
    const label = screen.getByTestId('save-button').textContent ?? '';
    expect(label).toContain('1000年に錨を作って保存');
    expect(label).toContain('2000年');
    expect(label).toContain('3000年');
    // 本当に別の名前になっている 4000 年は書き換えない。
    expect(label).not.toContain('4000年');
  });

  it('「この姿がいつまで続くか」を出す（引き継ぎが済んだあとの姿で見る）', () => {
    renderCarry(1000);
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '新名' },
    });
    expect(screen.getByTestId('save-effect-range')).toHaveTextContent('4000年まで続きます');
  });

  it('この先ずっと同じ姿なら、その行は出さない（保存列を太らせない）', () => {
    renderCarry(4500); // 4000 年より後ろ。これ以降に姿が変わる錨は無い。
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'さらに新しい名前' },
    });
    expect(screen.queryByTestId('save-effect-range')).not.toBeInTheDocument();
  });

  it('値を変えていないときは保存を押せず、代わりの一手を出す（A6 / GPT#6）', () => {
    renderCarry(1000);
    expect(screen.getByTestId('save-button')).toBeDisabled();
    expect(screen.getByTestId('save-no-change-note')).toHaveTextContent('値が変わっていません');
    expect(screen.getByTestId('save-no-change-note')).toHaveTextContent('1000年に錨を作る');
  });

  it('上書きになる年では、代わりの一手に「錨を作る」を出さない（起きないことを言わない）', () => {
    renderCarry(2000);
    expect(screen.getByTestId('save-button')).toBeDisabled();
    expect(screen.getByTestId('save-no-change-note')).toHaveTextContent('値が変わっていません。');
    expect(screen.getByTestId('save-no-change-note')).not.toHaveTextContent('錨を作る');
  });
});

// 増分 2 の手直し A4 — 打ちかけ（N-04）の状態機械。
//
// 旧版の穴は 3 つあった（反証 F3 / GPT#2）。
//   (a) 確認 UI が「地物が解決できたとき」の枝の中にあり、**選択が外れる経路では出なかった**。
//   (b) 「汚れている」を「種とも、いまの確定済みの姿とも違う」で定義していたので、
//       移動先の確定値がたまたま打ちかけと同じだと、確認なしで意図が消えた。
//   (c) 確認が出ているあいだ、背後の編集（存続期間・削除・保存）が止まっていなかった。
describe('PropertyPanel — 打ちかけの状態機械（A4 / N-04）', () => {
  function renderWithDraft(extra?: { onDraftConfirmChange?: (open: boolean) => void }) {
    const store = makeStore({ active: true });
    render(
      <PropertyPanel
        store={store}
        featureLookup={featureLookup}
        anchorLookup={anchorLookup}
        editDispatch={{ dispatchEdit: () => {} }}
        anchorIntervalDispatch={{ dispatchAnchorInterval: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
        onDeleteFeature={() => {}}
        {...(extra?.onDraftConfirmChange
          ? { onDraftConfirmChange: extra.onDraftConfirmChange }
          : {})}
      />,
    );
    fireEvent.click(screen.getByTestId('anchor-row-a1'));
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '打ちかけ' },
    });
    return store;
  }

  it('(a) 選択が外れて素性欄が案内文になっても、確認は描かれる', () => {
    const store = renderWithDraft();
    act(() => {
      store.getState().clearSelection();
    });
    expect(screen.getByTestId('property-guidance')).toBeInTheDocument();
    expect(screen.getByTestId('draft-discard-confirm')).toBeInTheDocument();
  });

  it('(b) 移動先の確定値がたまたま打ちかけと同じでも、意図は黙って消えない', () => {
    // 100 年で「Alpha → Beta」と打ち、移動先 200 年の確定名が **たまたま Beta** の場合。
    // 旧版は「いまの確定済みの姿と同じ」を理由に確認を出さず、「100 年に Beta を保存する」
    // という意図だけが黙って消えていた（GPT#2）。
    const fZ = asFeatureId('Z');
    const vZ = asVertexId('Z-v');
    const alpha = createPointFeature(fZ, createBasicAttributes('Alpha', 0, 0), color, vZ);
    const beta = createPointFeature(fZ, createBasicAttributes('Beta', 0, 0), color, vZ);
    const store = createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: { mode: EDIT_MODE.Edit, activeFeature: fZ, currentTime: timePointYear(100) },
    });
    const emptySnap = createAnchorSnapshot([], createVertexStore([]));
    render(
      <PropertyPanel
        store={store}
        featureLookup={{
          featureAt: (id) =>
            id !== fZ ? null : store.getState().currentTime.year < 200 ? alpha : beta,
        }}
        anchorLookup={{
          anchorSeriesOf: () => ({
            entries: [
              createAnchorEntry(
                createAnchor(asAnchorId('z1'), emptySnap),
                timePointYear(100),
                timePointYear(200),
              ),
              createAnchorEntry(createAnchor(asAnchorId('z2'), emptySnap), timePointYear(200), null),
            ],
          }),
        }}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
      />,
    );
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'Beta' },
    });
    act(() => {
      store.getState().setCurrentTime(timePointYear(200), TIME_CHANGE_SOURCE.NumericJump);
    });
    expect(screen.getByTestId('draft-discard-confirm')).toBeInTheDocument();
  });

  it('(c) 確認が出ているあいだは、保存・存続期間・削除がすべて止まる', () => {
    const store = renderWithDraft();
    act(() => {
      store.getState().setCurrentTime(timePointYear(1590), TIME_CHANGE_SOURCE.NumericJump);
    });
    expect(screen.getByTestId('draft-discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('save-button')).toBeDisabled();
    // 存続期間のエディタは丸ごと出ない（押す先が無い）。
    expect(screen.queryByTestId('anchor-interval-a1')).not.toBeInTheDocument();
    // 地物の削除ボタンは押せない。
    expect(within(screen.getByTestId('delete-feature')).getByRole('button')).toBeDisabled();
  });

  it('(c) 確認の開閉をホストへ伝える（鍵盤の大域ショートカットを止めるため）', () => {
    const seen: boolean[] = [];
    const store = renderWithDraft({ onDraftConfirmChange: (open) => seen.push(open) });
    expect(seen.at(-1)).toBe(false);
    act(() => {
      store.getState().setCurrentTime(timePointYear(1590), TIME_CHANGE_SOURCE.NumericJump);
    });
    expect(seen.at(-1)).toBe(true);
    fireEvent.click(screen.getByTestId('draft-discard-drop'));
    expect(seen.at(-1)).toBe(false);
  });

  it('鍵を「読むだけ」にすると、打ちかけは黙って捨てられる（K-5）', () => {
    // store.setMode は一時状態として選択も捨てる。だから素性欄は案内文になるが、
    // **確認は出さない**（利用者自身が閉じた操作なので、聞く相手がいない）。
    const store = renderWithDraft();
    act(() => {
      store.getState().setMode(EDIT_MODE.View);
    });
    expect(screen.queryByTestId('draft-discard-confirm')).not.toBeInTheDocument();
    // 開け直して同じ地物を選び直しても、古い打ちかけは復活しない。
    act(() => {
      store.getState().setMode(EDIT_MODE.Edit);
      store.getState().setActiveFeature(fA);
    });
    expect(screen.queryByTestId('draft-discard-confirm')).not.toBeInTheDocument();
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('織田領');
  });

  it('(d) 確認の本文に内部 id を出さない（U-1）', () => {
    const nameless = createPointFeature(
      asFeatureId('N'),
      createBasicAttributes('', 0, 0),
      color,
      asVertexId('N-v'),
    );
    const store = createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: { mode: EDIT_MODE.Edit, activeFeature: asFeatureId('N') },
    });
    render(
      <PropertyPanel
        store={store}
        featureLookup={{ featureAt: (id) => (id === asFeatureId('N') ? nameless : null) }}
        anchorLookup={{ anchorSeriesOf: () => seriesFor() }}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
      />,
    );
    expect(screen.getByTestId('property-title-name')).toHaveTextContent(
      PROPERTY_STRINGS.unnamedFeature,
    );
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '打ちかけ' },
    });
    act(() => {
      store.getState().setCurrentTime(timePointYear(1590), TIME_CHANGE_SOURCE.NumericJump);
    });
    const confirm = screen.getByTestId('draft-discard-confirm');
    expect(confirm).toHaveTextContent(PROPERTY_STRINGS.unnamedFeature);
    expect(confirm.textContent ?? '').not.toContain('N');
  });
});

// 増分 2 の手直し B3 — 「続く」行は親の系列そのものから出し、穴を隠さない
// （設計 C4 / 反証 F7 / バグ狩り #7）。旧版は「錨表に出している並び」の先頭と末尾しか
// 見ていなかったので、途中で存在しない期間があっても 1 本に見せていた。
describe('PropertyPanel — 「続く」行は穴を隠さない（B3）', () => {
  const fH = asFeatureId('H');
  const vH = asVertexId('H-v');
  const featureH = createPointFeature(fH, createBasicAttributes('穴あき', 0, 0), color, vH);

  function holedSeries(): AnchorSeries {
    const snap = createAnchorSnapshot([featureH], createVertexStore([]));
    return {
      entries: [
        createAnchorEntry(createAnchor(asAnchorId('h1'), snap), timePointYear(0), timePointYear(2000)),
        createAnchorEntry(createAnchor(asAnchorId('h2'), snap), timePointYear(3000), null),
      ],
    };
  }

  it('途中に存在しない期間があると 2 区間で出る', () => {
    const store = createSessionStore<Record<string, never>>({
      initialDomain: {},
      initial: { mode: EDIT_MODE.Edit, activeFeature: fH, currentTime: timePointYear(0) },
    });
    render(
      <PropertyPanel
        store={store}
        featureLookup={{ featureAt: (id) => (id === fH ? featureH : null) }}
        anchorLookup={{ anchorSeriesOf: () => holedSeries() }}
        editDispatch={{ dispatchEdit: () => {} }}
        calendar={cal}
        ownerLookup={ownerLookup}
      />,
    );
    const value = screen.getByTestId('existence-value');
    expect(value).toHaveTextContent('0年 → 2000年');
    expect(value).toHaveTextContent('3000年 → 継続中');
  });
});
