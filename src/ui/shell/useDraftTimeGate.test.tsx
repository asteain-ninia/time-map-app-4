// B112: 年の移動を止める関門の検査。追加の道具・輪郭・穴あけ・分ける が共有する 1 本。
//
// 肝は「動いてから戻す」ではなく「動かさない」こと。止めた移動で選択が洗い直されない（教訓 5.71）。

import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { asFeatureId } from '../../domain/ids';
import { timePointYear } from '../../domain/time/time-point';
import { createSessionStore, TIME_CHANGE_SOURCE } from '../state/store';
import type { ExistenceResolver } from '../state/existence';

import { useDraftTimeGate, type DraftTimeGateOptions } from './useDraftTimeGate';

type TestStore = ReturnType<typeof createSessionStore<{ readonly tag: string }>>;

/** どの地物も、どの年にも居ない（時刻が動けば選択は必ず外れる）。 */
const NOTHING_EXISTS: ExistenceResolver = {
  featureExistsAt: () => false,
  vertexExistsAt: () => false,
};

function makeStore(): TestStore {
  return createSessionStore<{ readonly tag: string }>({
    initialDomain: { tag: 'd0' },
    existence: NOTHING_EXISTS,
    initial: { activeFeature: asFeatureId('A') },
  });
}

function Harness(props: Omit<DraftTimeGateOptions<{ readonly tag: string }>, 'store'> & {
  readonly store: TestStore;
}): null {
  useDraftTimeGate(props);
  return null;
}

function options(overrides: Partial<Parameters<typeof Harness>[0]>) {
  return {
    isBoardOpen: () => false,
    hasDraft: true,
    asks: true,
    onAsk: vi.fn(),
    onDiscardSilently: vi.fn(() => '2 個'),
    onMovedAfterDiscard: vi.fn(),
    onRangeClamped: vi.fn(),
    ...overrides,
  };
}

const move = (store: TestStore, year: number): void => {
  store.getState().setCurrentTime(timePointYear(year), TIME_CHANGE_SOURCE.Playback);
};

describe('useDraftTimeGate', () => {
  it('聞く下書き: 年も選択も動かさず、頼まれた移動を手渡す。呼ぶと動く', () => {
    const store = makeStore();
    const onAsk = vi.fn<(moveTime: () => void) => void>();
    render(<Harness store={store} {...options({ onAsk })} />);
    const before = store.getState().currentTime;

    move(store, 1500);

    expect(store.getState().currentTime).toBe(before);
    expect(store.getState().activeFeature).toBe('A');
    expect(onAsk).toHaveBeenCalledTimes(1);

    act(() => onAsk.mock.calls[0]![0]());
    expect(store.getState().currentTime.year).toBe(1500);
    expect(store.getState().lastTimeChangeSource).toBe(TIME_CHANGE_SOURCE.Playback);
    expect(store.getState().activeFeature).toBeNull();
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it('板が開いているあいだは、どの移動も素通りしない（再生の次のコマも止まる）', () => {
    const store = makeStore();
    const onAsk = vi.fn();
    render(<Harness store={store} {...options({ onAsk, isBoardOpen: () => true })} />);
    const before = store.getState().currentTime;

    move(store, 1);
    move(store, 2);

    expect(store.getState().currentTime).toBe(before);
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('板のあいだに元の年へ戻す要求が来たら、行き先を差し替える（［捨てる］で途中の年へ行かない。指摘 3）', () => {
    const store = makeStore();
    const here = store.getState().currentTime.year;
    let open = false;
    const onAsk = vi.fn<(moveTime: () => void) => void>(() => {
      open = true;
    });
    const andThen = vi.fn();
    render(<Harness store={store} {...options({ onAsk, isBoardOpen: () => open })} />);

    move(store, 3998);
    expect(onAsk).toHaveBeenCalledTimes(1);
    store.getState().setCurrentTime(timePointYear(here), TIME_CHANGE_SOURCE.Slider, andThen);
    expect(andThen).not.toHaveBeenCalled();
    open = false;
    act(() => onAsk.mock.calls[0]![0]());

    expect(store.getState().currentTime.year).toBe(here);
    expect(andThen).toHaveBeenCalledTimes(1);
  });

  it('板が無ければ同じ年への要求で聞かない（続きは走る）', () => {
    const store = makeStore();
    const onAsk = vi.fn();
    const andThen = vi.fn();
    render(<Harness store={store} {...options({ onAsk })} />);
    const here = store.getState().currentTime.year;

    store.getState().setCurrentTime(timePointYear(here), TIME_CHANGE_SOURCE.Slider, andThen);

    expect(onAsk).not.toHaveBeenCalled();
    expect(andThen).toHaveBeenCalledTimes(1);
  });

  it('聞くまでもない下書き: 捨ててから動き、動いたあとで数を知らせる', () => {
    const store = makeStore();
    const order: string[] = [];
    const yearAt = (): number => store.getState().currentTime.year;
    render(
      <Harness
        store={store}
        {...options({
          asks: false,
          onDiscardSilently: () => {
            order.push(`捨てる@${String(yearAt())}`);
            return '2 個';
          },
          onMovedAfterDiscard: (what) => order.push(`知らせる ${what}@${String(yearAt())}`),
        })}
      />,
    );
    const start = yearAt();

    move(store, 1500);

    expect(order).toEqual([`捨てる@${String(start)}`, '知らせる 2 個@1500']);
  });

  it('年の移動の続き: 止めたら走らず、捨てると答えられたら年のあとで走る。［続ける］なら走らない', () => {
    const store = makeStore();
    const onAsk = vi.fn<(moveTime: () => void) => void>();
    render(<Harness store={store} {...options({ onAsk })} />);
    const before = store.getState().currentTime;
    const yearsSeen: number[] = [];
    const andThen = (): void => {
      yearsSeen.push(store.getState().currentTime.year);
    };

    store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.AnchorSync, andThen);
    expect(store.getState().currentTime).toBe(before);
    expect(yearsSeen).toEqual([]);

    act(() => onAsk.mock.calls[0]![0]());
    expect(yearsSeen).toEqual([1500]);
    // 2 回呼んでも 2 回は動かない。
    act(() => onAsk.mock.calls[0]![0]());
    expect(yearsSeen).toEqual([1500]);
  });

  it('聞くまでもない下書きでも、続きは年のあとで走る', () => {
    const store = makeStore();
    render(<Harness store={store} {...options({ asks: false })} />);
    const yearsSeen: number[] = [];

    store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.AnchorSync, () => {
      yearsSeen.push(store.getState().currentTime.year);
    });

    expect(yearsSeen).toEqual([1500]);
  });

  it('板のあいだに頼まれた移動は、行き先と続きを差し替える（レールを引いている途中）', () => {
    const store = makeStore();
    let open = false;
    const onAsk = vi.fn<(moveTime: () => void) => void>(() => {
      open = true;
    });
    render(<Harness store={store} {...options({ onAsk, isBoardOpen: () => open })} />);
    const ran: string[] = [];

    store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.Slider, () => {
      ran.push('古い');
    });
    store.getState().setCurrentTime(timePointYear(1800), TIME_CHANGE_SOURCE.Slider, () => {
      ran.push('新しい');
    });
    expect(onAsk).toHaveBeenCalledTimes(1);

    open = false;
    act(() => onAsk.mock.calls[0]![0]());
    expect(store.getState().currentTime.year).toBe(1800);
    expect(ran).toEqual(['新しい']);
  });

  it('設定の補正: 止められない。聞かずに下書きを捨てて年を受け入れる', () => {
    const store = makeStore();
    const onAsk = vi.fn();
    const onRangeClamped = vi.fn();
    store.getState().setProjectTimelineRangeYears(0, 2000);
    store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.NumericJump);
    render(<Harness store={store} {...options({ onAsk, onRangeClamped })} />);

    store.getState().setProjectTimelineRangeYears(0, 1400);

    expect(store.getState().currentTime.year).toBe(1400);
    expect(onAsk).not.toHaveBeenCalled();
    expect(onRangeClamped).toHaveBeenCalledTimes(1);
    expect(onRangeClamped.mock.calls[0]![0]).toMatchObject({ year: 1400 });
  });

  it('設定の補正: 年が動かない範囲の変更では何もしない。下書きが無ければ何もしない', () => {
    const store = makeStore();
    const onRangeClamped = vi.fn();
    store.getState().setProjectTimelineRangeYears(0, 2000);
    store.getState().setCurrentTime(timePointYear(1000), TIME_CHANGE_SOURCE.NumericJump);
    const view = render(<Harness store={store} {...options({ onRangeClamped })} />);

    store.getState().setProjectTimelineRangeYears(0, 1400);
    expect(onRangeClamped).not.toHaveBeenCalled();
    view.unmount();

    render(<Harness store={store} {...options({ hasDraft: false, onRangeClamped })} />);
    store.getState().setProjectTimelineRangeYears(0, 900);
    expect(store.getState().currentTime.year).toBe(900);
    expect(onRangeClamped).not.toHaveBeenCalled();
  });

  it('読み込みの補正は関門へ知らせない（世代の印で別に片付く）', () => {
    const store = makeStore();
    const onRangeClamped = vi.fn();
    store.getState().setProjectTimelineRangeYears(0, 2000);
    store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.NumericJump);
    render(<Harness store={store} {...options({ onRangeClamped })} />);

    const { projectSettings } = store.getState();
    store.getState().reflectLoadedProject(
      { tag: 'd1' },
      { projectSettings: { ...projectSettings, timelineMinYear: 0, timelineMaxYear: 1400 } },
    );

    expect(store.getState().currentTime.year).toBe(1400);
    expect(onRangeClamped).not.toHaveBeenCalled();
  });

  it('下書きが無ければ何もしない', () => {
    const store = makeStore();
    const onAsk = vi.fn();
    const onDiscardSilently = vi.fn(() => '');
    render(<Harness store={store} {...options({ hasDraft: false, onAsk, onDiscardSilently })} />);

    move(store, 1500);

    expect(store.getState().currentTime.year).toBe(1500);
    expect(onAsk).not.toHaveBeenCalled();
    expect(onDiscardSilently).not.toHaveBeenCalled();
  });

  it('同じ時刻への書き込みは動きではないので関門を通らない', () => {
    const store = makeStore();
    const onAsk = vi.fn();
    render(<Harness store={store} {...options({ onAsk })} />);

    store.getState().setCurrentTime(store.getState().currentTime, TIME_CHANGE_SOURCE.NumericJump);

    expect(onAsk).not.toHaveBeenCalled();
  });

  it('外れたら関門は働かない', () => {
    const store = makeStore();
    const onAsk = vi.fn();
    const view = render(<Harness store={store} {...options({ onAsk })} />);
    view.unmount();

    move(store, 1500);

    expect(store.getState().currentTime.year).toBe(1500);
    expect(onAsk).not.toHaveBeenCalled();
  });
});
