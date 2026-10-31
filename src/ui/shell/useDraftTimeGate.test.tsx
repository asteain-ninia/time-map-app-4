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
    onDiscardSilently: vi.fn(() => 2),
    onMovedAfterDiscard: vi.fn(),
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
            return 2;
          },
          onMovedAfterDiscard: (lost) => order.push(`知らせる ${String(lost)}@${String(yearAt())}`),
        })}
      />,
    );
    const start = yearAt();

    move(store, 1500);

    expect(order).toEqual([`捨てる@${String(start)}`, '知らせる 2@1500']);
  });

  it('下書きが無ければ何もしない', () => {
    const store = makeStore();
    const onAsk = vi.fn();
    const onDiscardSilently = vi.fn(() => 0);
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
