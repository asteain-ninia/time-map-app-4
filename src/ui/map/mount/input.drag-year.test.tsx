// 引いている最中の年（`mount/input.ts` の関門と見張り）。止められずに年や書類が変わる経路のうち、
// 実機では板が先に押下を畳むもの（設定の補正）も、生きた押下に当たる形で確かめる（教訓 5.41）。
// 実機の通しは `e2e/drag-year.spec.ts`。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { timePointYear } from '../../../domain/time/time-point';
import { TOOL_ID } from '../../shell/tools';
import { EDIT_MODE } from '../../state/session';
import { createSessionStore, TIME_CHANGE_SOURCE } from '../../state/store';
import { DRAG_CANCEL_CAUSE, type DragYearHost } from '../drag-year';
import type { EditSessionPort, MapCameraInput } from '../ports';
import { CursorPositionStore } from '../../shell/cursor-position';

import { createMountInput, type MountInput } from './input';
import type { MountStore, MountTransients } from './shared';

type Domain = ReturnType<MountStore['getState']>['domain'];

const CAMERA = { centerLon: 0, centerLat: 0, zoom: 4 };
const VIEWPORT = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };

describe('引いている最中の年 — 地図の入力の層', () => {
  let input: MountInput;
  let store: MountStore;
  let target: HTMLDivElement;
  let session: { begin: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let host: { pressBegan: ReturnType<typeof vi.fn>; timeMoveRefused: ReturnType<typeof vi.fn>; cancelled: ReturnType<typeof vi.fn> };
  let boardOpened: { current: (() => void) | null };

  const press = (): void => {
    target.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true, clientX: 10, clientY: 10 }),
    );
  };
  const release = (): void => {
    target.dispatchEvent(
      new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true, clientX: 60, clientY: 10 }),
    );
  };
  const year = (): number => store.getState().currentTime.year;
  const move = (y: number): void => {
    store.getState().setCurrentTime(timePointYear(y), TIME_CHANGE_SOURCE.NumericJump);
  };

  beforeEach(() => {
    store = createSessionStore({
      initialDomain: { tag: 'd0' } as unknown as Domain,
      existence: { featureExistsAt: () => true, vertexExistsAt: () => true },
      initial: { mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditVertex, currentTime: timePointYear(1500) },
    }) as unknown as MountStore;
    target = document.createElement('div');
    document.body.appendChild(target);
    session = { begin: vi.fn(() => true), cancel: vi.fn(), release: vi.fn() };
    host = { pressBegan: vi.fn(), timeMoveRefused: vi.fn(), cancelled: vi.fn() };
    boardOpened = { current: null };
    input = createMountInput({
      store,
      ports: {
        readCamera: () => ({ camera: CAMERA, viewport: VIEWPORT }),
        writeCamera: () => {},
        effectiveZoomRange: () => undefined,
        screenToWorld: () => ({ lon: 0, lat: 0 }),
      } as unknown as Parameters<typeof createMountInput>[0]['ports'],
      hookTarget: target,
      mapCell: target,
      transients: { flushRedraw: () => {} } as unknown as MountTransients,
      cursorPositionStore: new CursorPositionStore(),
      cameraInputRef: { current: null as MapCameraInput | null },
      hitTester: { hitTest: () => ({ kind: 'empty' }) as never },
      selectionPort: { start: () => {}, move: () => {}, end: () => {}, cancel: () => {} },
      editSession: {
        begin: session.begin,
        update: () => {},
        release: session.release,
        cancel: session.cancel,
      } as unknown as EditSessionPort,
      contextMenu: { request: () => {} },
      boardOpenedRef: boardOpened,
      dragYearHostRef: { current: host as unknown as DragYearHost },
    });
  });

  afterEach(() => {
    input.dispose();
    target.remove();
  });

  it('掴んでいる間は年を止めて知らせ、離したら止めない', () => {
    move(1600);
    expect(year()).toBe(1600);
    press();
    move(1700);
    expect(year()).toBe(1600);
    expect(host.timeMoveRefused).toHaveBeenCalledTimes(1);
    expect(host.timeMoveRefused).toHaveBeenCalledWith(TIME_CHANGE_SOURCE.NumericJump);
    release();
    expect(session.release).toHaveBeenCalledTimes(1);
    move(1700);
    expect(year()).toBe(1700);
    expect(host.timeMoveRefused).toHaveBeenCalledTimes(1);
  });

  it('掴まなかった押下では止めない', () => {
    session.begin.mockReturnValue(false);
    press();
    move(1700);
    expect(year()).toBe(1700);
    expect(host.timeMoveRefused).not.toHaveBeenCalled();
  });

  it('同じ年への書き込みは断らない（続きは走る）', () => {
    press();
    const andThen = vi.fn();
    store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.NumericJump, andThen);
    expect(andThen).toHaveBeenCalledTimes(1);
    expect(host.timeMoveRefused).not.toHaveBeenCalled();
  });

  it('表示年の範囲で年が補正されたら、記録せずに取り消して言う。範囲の中なら引き続ける', () => {
    press();
    store.getState().setTimelineRange(timePointYear(0), timePointYear(2000));
    expect(session.cancel).not.toHaveBeenCalled();
    expect(host.cancelled).not.toHaveBeenCalled();

    store.getState().setProjectTimelineRangeYears(0, 1400);
    expect(year()).toBe(1400);
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(host.cancelled).toHaveBeenCalledTimes(1);
    expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.Time);
    release();
    expect(session.release).not.toHaveBeenCalled();
  });

  it('書類の中身が変わったら、記録せずに取り消して言う', () => {
    press();
    store.setState({ domain: { tag: 'd1' } as unknown as Domain });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.Document);
    release();
    expect(session.release).not.toHaveBeenCalled();
  });

  it('読み込みの印が動いたら、読み込みとして言う（中身も変わっていても）', () => {
    press();
    store.setState({
      domain: { tag: 'd2' } as unknown as Domain,
      projectLoadNonce: store.getState().projectLoadNonce + 1,
    });
    expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.Project);
  });

  it('板が開いたら、記録せずに取り消して言う', () => {
    press();
    boardOpened.current?.();
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.Board);
    release();
    expect(session.release).not.toHaveBeenCalled();
  });

  it('外したら関門は残らない', () => {
    press();
    input.dispose();
    move(1700);
    expect(year()).toBe(1700);
    input = { dispose: () => {} };
  });
});
