import { describe, expect, it, vi } from 'vitest';

import { PARENT_WATCH_INTERVAL_MS, isProcessAlive, startParentWatch } from './parent-watch';

describe('親のプロセスの見張り', () => {
  function setup(alive: () => boolean) {
    let tick: () => void = () => undefined;
    const onParentGone = vi.fn();
    const clear = vi.fn();
    const setter = vi.fn<(run: () => void, ms: number) => string>((run) => {
      tick = run;
      return 'handle';
    });
    startParentWatch({ isParentAlive: alive, onParentGone, setInterval: setter, clearInterval: clear });
    return { tick: () => tick(), onParentGone, clear, setter };
  }

  it('親が居る間は何もしない', () => {
    const { tick, onParentGone, clear, setter } = setup(() => true);
    tick();
    expect(setter.mock.calls[0]?.[1]).toBe(PARENT_WATCH_INTERVAL_MS);
    expect(onParentGone).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('親が消えたら 1 度だけ知らせて止まる', () => {
    const { tick, onParentGone, clear } = setup(() => false);
    tick();
    expect(onParentGone).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith('handle');
  });
});

describe('プロセスが生きているか', () => {
  const failing = (code: string) => (): never => {
    throw Object.assign(new Error(code), { code });
  };

  it('確かめが通れば生きている', () => {
    expect(isProcessAlive(1, () => true)).toBe(true);
  });
  it('ESRCH だけが「居ない」', () => {
    expect(isProcessAlive(1, failing('ESRCH'))).toBe(false);
  });
  it('権限で断られたのは居るということ', () => {
    expect(isProcessAlive(1, failing('EPERM'))).toBe(true);
  });
});
