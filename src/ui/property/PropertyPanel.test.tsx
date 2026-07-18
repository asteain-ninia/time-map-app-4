// U32: PropertyPanel React operation tests (FR-83 / FR-84 / FR-97 / FR-99,
// 受け入れ基準 1/2/3/5, 教訓 5.10 / 5.12 / 5.13 / 5.15 / 5.24).

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import {
  type AnchorSeries,
  createAnchorEntry,
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

  it('a save-failure message survives selecting a DIFFERENT feature (spec 行188, 教訓 5.12)', () => {
    // 受け入れ基準 5: a held decision message must NOT be cleared by無関係操作,
    // and別地物の選択 is explicitly such an操作. Only re-save / dismiss / 再保存成功
    // may clear it.
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

    // Select a DIFFERENT feature (a genuine target change). The form re-syncs to
    // feature B's baseline, but the held message must REMAIN — this is not one of
    // the three allowed clear契機.
    act(() => {
      store.getState().setActiveFeature(fB);
    });
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

describe('PropertyPanel — AnchorSection view-mode reset on feature switch (BUG B, 教訓 5.2)', () => {
  it('switching the target feature remounts AnchorSection, resetting its view mode to List', () => {
    // The section's transient view mode (List/TimeBar) is documented as "reset on
    // selection change via the keyed remount upstream". The panel must therefore
    // mount <AnchorSection key={targetFeatureId}> so a feature switch REMOUNTS it.
    // Without the key the chosen mode persisted (stale) across features.
    const store = makeStore({ active: true });
    renderPanel(store);

    // Default = list view. Switch to the time-bar view on feature A.
    expect(screen.getByTestId('anchor-list')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anchor-mode-timebar'));
    expect(screen.getByTestId('anchor-timebar')).toBeInTheDocument();
    expect(screen.queryByTestId('anchor-list')).not.toBeInTheDocument();

    // Switch to a DIFFERENT feature: the section must remount back to list view.
    act(() => {
      store.getState().setActiveFeature(fB);
    });
    expect(screen.getByTestId('anchor-list')).toBeInTheDocument();
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
function renderPanelWithInterval(
  store: ReturnType<typeof makeStore>,
  anchorIntervalDispatch: AnchorIntervalEditDispatch,
) {
  return render(
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
    renderPanelWithInterval(store, { dispatchAnchorInterval: (i) => intents.push(i) });

    const del = screen.getByTestId('anchor-interval-delete-a2');
    expect(del).toBeEnabled(); // 2-anchor series: not the sole anchor.
    fireEvent.click(del);

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
    expect(screen.getByLabelText(PROPERTY_STRINGS.startYearLabel)).toHaveValue(100);

    // Move the current time forward to the a2 interval (as the timeline slider would).
    act(() => {
      store.getState().setCurrentTime(timePointYear(200), TIME_CHANGE_SOURCE.AnchorSync);
    });

    // The form must now reflect the a2 snapshot (Beta), NOT the frozen Alpha.
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('Beta');
    expect(screen.getByLabelText(PROPERTY_STRINGS.startYearLabel)).toHaveValue(200);
    expect(screen.getByLabelText(PROPERTY_STRINGS.endYearLabel)).toHaveValue(300);
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
    // Alpha's 100/200/#aa* — overwriting Beta on save (the data-loss bug).
    expect(intent.attributes.startYear).toBe(200);
    expect(intent.attributes.endYear).toBe(300);
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

// bughunt 第12波 #2 (HIGH — .tmap 全損防止): the基本情報 開始年/終了年 inputs (type=number)
// accept huge / negative-huge / fractional years. createBasicAttributes / edit-intent /
// the edit binding never validate the year, so a Committed save succeeds — but the READ
// side schema (yearSchema = int within ±MAX_YEAR, the SAME isPersistedYear bound the
// timeline WRITE side already enforces) rejects the WHOLE manifest on load, so the .tmap
// can never be reopened (書込⊆読込 asymmetry). handleSave now guards with the SAME
// isPersistedYear (single truth source) and returns an honest save-failure message.
describe('PropertyPanel — 基本情報 年境界 WRITE ガード (bughunt 第12波 #2, HIGH)', () => {
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

  it.each([
    ['開始年 が範囲外（+5,000,000）', PROPERTY_STRINGS.startYearLabel, '5000000'],
    ['終了年 が範囲外（+5,000,000）', PROPERTY_STRINGS.endYearLabel, '5000000'],
    ['開始年 が負の範囲外（-5,000,000）', PROPERTY_STRINGS.startYearLabel, '-5000000'],
    ['開始年 が小数（1.5）', PROPERTY_STRINGS.startYearLabel, '1.5'],
  ])(
    'rejects a save when %s → honest-failure message, NO dispatch (書込⊆読込)',
    (_label, fieldLabel, badValue) => {
      const intents: PropertyEditIntent[] = [];
      renderYearPanel({ dispatchEdit: (i) => intents.push(i) });

      fireEvent.change(screen.getByLabelText(fieldLabel), { target: { value: badValue } });
      fireEvent.click(screen.getByTestId('save-button'));

      // The edit must NOT dispatch (would otherwise become an un-loadable .tmap).
      expect(intents).toHaveLength(0);
      // The failure surfaces honestly through the existing save-message path.
      const msg = screen.getByTestId('save-message');
      expect(msg).toHaveTextContent(PROPERTY_STRINGS.yearOutOfRange);
    },
  );

  it('accepts a save when both years are in range (±MAX_YEAR) — the guard is not over-broad', () => {
    const intents: PropertyEditIntent[] = [];
    renderYearPanel({ dispatchEdit: (i) => intents.push(i) });

    // A normal edit at the boundary must still save (MAX_YEAR = 1,000,000).
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.startYearLabel), {
      target: { value: '-1000000' },
    });
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.endYearLabel), {
      target: { value: '1000000' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    expect(intents).toHaveLength(1);
    expect(intents[0]!.attributes.startYear).toBe(-1000000);
    expect(intents[0]!.attributes.endYear).toBe(1000000);
    expect(screen.queryByTestId('save-message')).not.toBeInTheDocument();
  });
});
