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
import { createPointFeature, type Feature } from '../../domain/feature';
import {
  asAnchorId,
  asFeatureId,
  asVertexId,
  type FeatureId,
} from '../../domain/ids';
import { ownerLookupFromMap } from '../../domain/selection';
import { getCalendar } from '../../domain/time/calendar';
import {
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
import { PROPERTY_STRINGS } from './messages';
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
  featureAt: (id) => (id === fA ? featureA() : id === fB ? featureB() : null),
};
const anchorLookup: AnchorSeriesLookup = {
  anchorSeriesOf: (id) => (id === fA || id === fB ? seriesFor() : null),
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
  it('selecting an anchor on a vertex-context feature preserves the in-progress draft', () => {
    // Root cause: for a vertex-context target (no active feature, single owner),
    // setCurrentTime → revalidateForTime rebuilds the vertex Set with a FRESH
    // reference, re-rendering the panel with a new selection object naming the
    // SAME feature. Without ID-keyed memoization the resolved feature object would
    // be new every such render, wiping the draft.
    const store = makeStore({ vertices: true });
    renderPanel(store);
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();

    // Type an edit, THEN select an anchor (the core FR-84 path).
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '編集中' },
    });
    fireEvent.click(screen.getByTestId('anchor-row-a2'));

    // The in-progress draft must survive the anchor selection.
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

describe('PropertyPanel — 存続期間編集 wiring (HB3-12, 教訓 5.7)', () => {
  it('反映 on 開始年 dispatches a changeStart intent for that anchor', () => {
    const intents: AnchorIntervalEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanelWithInterval(store, { dispatchAnchorInterval: (i) => intents.push(i) });

    // seriesFor() anchor a1 starts 1560; edit it to 1500 and 反映.
    fireEvent.change(screen.getByTestId('anchor-interval-start-a1'), {
      target: { value: '1500' },
    });
    fireEvent.click(screen.getByTestId('anchor-interval-apply-start-a1'));

    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.op).toBe(ANCHOR_INTERVAL_OP.ChangeStart);
    expect(intent.featureId).toBe(fA);
    expect(intent.anchorId).toBe('a1');
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart.year).toBe(1500);
    }
  });

  it('反映 on 終了年 dispatches a setEnd intent; 継続中にする clears it (null)', () => {
    const intents: AnchorIntervalEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanelWithInterval(store, { dispatchAnchorInterval: (i) => intents.push(i) });

    fireEvent.change(screen.getByTestId('anchor-interval-end-a1'), {
      target: { value: '1570' },
    });
    fireEvent.click(screen.getByTestId('anchor-interval-apply-end-a1'));
    fireEvent.click(screen.getByTestId('anchor-interval-clear-end-a1'));

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
    fireEvent.click(screen.getByTestId('anchor-interval-apply-start-a1'));
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
