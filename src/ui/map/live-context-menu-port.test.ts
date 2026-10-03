// REGRESSION (bughunt2: FR-96 right-click context menu wired to a NO-OP port).
//
// The defect: the U40 dispatcher routes EVERY right-button press to the
// `contextMenu` port (dispatch.ts:「Right button is always a context-menu request」),
// but the composition root backed it with NOOP_CONTEXT_MENU_PORT — `request(){}` —
// so a real right-click opened NOTHING (the menu component + registry path existed
// and were unit-tested, but were never reached from pointer input, 教訓 5.7).
//
// These tests pin the missing 結線 at the seam the bug lived at: a right-button
// press, routed through the REAL PointerDispatcher, must reach the LIVE port, which
// (1) promotes the hit feature into selection (so a menu command targets it,
// 教訓 5.11), (2) converts the surface point to client px, and (3) opens the menu.
// A test that drives NOOP_CONTEXT_MENU_PORT instead would observe nothing — exactly
// the bug. The dispatcher's right-button branch is also re-asserted as "never pans".

import { describe, expect, it } from 'vitest';

import { PointerDispatcher, type NormalizedPointer } from './PointerDispatcher';
import { POINTER_BUTTON } from './dispatch';
import {
  EMPTY_HIT_TESTER,
  NO_MODIFIERS,
  NOOP_ADD_PORT,
  NOOP_SELECTION_PORT,
  type CameraPort,
  type HitTester,
} from './ports';
import {
  createLiveContextMenuPort,
  promoteHitToSelection,
} from './live-context-menu-port';
import {
  EMPTY_HIT,
  EMPTY_SELECTION,
  edgeHit,
  featureBodyHit,
  replaceVertices,
  vertexHit,
  withActiveFeature,
  type HitResult,
  type SelectionState,
} from '../../domain/selection';
import { asFeatureId, asVertexId } from '../../domain/ids';
import { EDIT_MODE } from '../state/session';
import type { Camera, ScreenPoint, Viewport } from '../../render';

const VIEWPORT: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const CAMERA: Camera = { centerLon: 0, centerLat: 0, zoom: 1 } as unknown as Camera;

/** A camera port that records writes so we can assert a right-click never pans. */
function recordingCameraPort(): CameraPort & { readonly writes: Camera[] } {
  const writes: Camera[] = [];
  return {
    writes,
    read: () => ({ camera: CAMERA, viewport: VIEWPORT }),
    write: (c) => {
      writes.push(c);
    },
  };
}

function rightDown(x = 30, y = 40): NormalizedPointer {
  return { pointerId: 1, x, y, button: POINTER_BUTTON.Right, modifiers: NO_MODIFIERS };
}

interface PortHarness {
  readonly promoted: HitResult[];
  readonly opened: { clientX: number; clientY: number; hit: HitResult }[];
  readonly port: ReturnType<typeof createLiveContextMenuPort>;
}

/** Build the live port with recording deps + a +100/+200 surface→client offset. */
function harness(): PortHarness {
  const promoted: HitResult[] = [];
  const opened: { clientX: number; clientY: number; hit: HitResult }[] = [];
  const port = createLiveContextMenuPort({
    surfaceToClient: (p: ScreenPoint) => ({ x: p.x + 100, y: p.y + 200 }),
    promoteHit: (hit) => promoted.push(hit),
    open: (req) => opened.push(req),
  });
  return { promoted, opened, port };
}

describe('createLiveContextMenuPort (FR-96 right-click wiring, bughunt2)', () => {
  it('a feature-body right-click promotes the hit feature and opens the menu at the cursor', () => {
    const h = harness();
    const hit = featureBodyHit(asFeatureId('f-1'));
    h.port.request({ x: 30, y: 40 }, hit);

    expect(h.promoted).toEqual([hit]); // 削除 etc. now target the right-clicked feature
    expect(h.opened).toEqual([{ clientX: 130, clientY: 240, hit }]);
  });

  it('a vertex right-click promotes the vertex hit and opens the menu', () => {
    const h = harness();
    const hit = vertexHit(asFeatureId('f-2'), asVertexId('v-9'));
    h.port.request({ x: 1, y: 2 }, hit);

    expect(h.promoted).toEqual([hit]);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.hit).toBe(hit);
  });

  it('an empty-space right-click opens the menu but does NOT touch the selection', () => {
    const h = harness();
    h.port.request({ x: 5, y: 6 }, EMPTY_HIT);

    expect(h.promoted).toEqual([]); // never silently clears the current selection
    expect(h.opened).toEqual([{ clientX: 105, clientY: 206, hit: EMPTY_HIT }]);
  });
});

// --- 段階7 優先規則: suspended right-click drops the request whole (must_include #5) --
// While a tool draft / modal is active the right-click must NOT open a menu AND must
// NOT mutate the selection (a stray promoteHit would desync the in-progress gesture,
// 教訓 5.2). Both side effects are skipped TOGETHER.

describe('createLiveContextMenuPort — suspended gate (段階7)', () => {
  function suspendedHarness(suspended: () => boolean): PortHarness {
    const promoted: HitResult[] = [];
    const opened: { clientX: number; clientY: number; hit: HitResult }[] = [];
    const port = createLiveContextMenuPort({
      surfaceToClient: (p: ScreenPoint) => ({ x: p.x + 100, y: p.y + 200 }),
      promoteHit: (hit) => promoted.push(hit),
      open: (req) => opened.push(req),
      suspended,
    });
    return { promoted, opened, port };
  }

  it('suspended ⇒ a feature-body right-click neither promotes (selection unchanged) nor opens', () => {
    const h = suspendedHarness(() => true);
    h.port.request({ x: 30, y: 40 }, featureBodyHit(asFeatureId('f-1')));
    // No promoteHit → the LIVE selection is left exactly as it was (段階7 / 教訓 5.2).
    expect(h.promoted).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it('not suspended ⇒ behaves normally (promotes + opens)', () => {
    const h = suspendedHarness(() => false);
    const hit = featureBodyHit(asFeatureId('f-1'));
    h.port.request({ x: 30, y: 40 }, hit);
    expect(h.promoted).toEqual([hit]);
    expect(h.opened).toHaveLength(1);
  });
});

// --- promoteHitToSelection — the right-click promote RULE (bughunt5 HOLE-2) ----
// The degradation: a right-click feature-body promote set the active feature ONLY
// and did NOT clear a stale vertex selection (from a prior rubber-band on ANOTHER
// feature). A following 削除 then read the vertex branch and wrongly deleted THAT
// feature's vertices instead of the right-clicked body. The left-click reducer path
// already cleared the vertex set (reducer.ts body branch); these pin the SAME rule
// for the right-click promote so the two paths are symmetric (単一の真実源).

/** A selection with a rubber-band vertex set owned by feature A. */
function withVertexSelectionOnA(): SelectionState {
  return replaceVertices(
    withActiveFeature(EMPTY_SELECTION, asFeatureId('A')),
    asFeatureId('A'),
    new Set([asVertexId('a-1'), asVertexId('a-2')]),
  );
}

describe('promoteHitToSelection (right-click promote rule, HOLE-2 degradation)', () => {
  it('a FEATURE BODY hit on B clears a stale vertex selection on A (no ghost target)', () => {
    const before = withVertexSelectionOnA();
    const after = promoteHitToSelection(before, featureBodyHit(asFeatureId('B')));

    expect(after.activeFeature).toBe(asFeatureId('B'));
    // The stale A-owned vertex set is gone — a following 削除 targets B's body, not A.
    expect(after.vertexOwner).toBeNull();
    expect(after.vertexIds.size).toBe(0);
  });

  it('a VERTEX hit is UNCHANGED: selects that feature + replaces the set with the one vertex', () => {
    const before = withVertexSelectionOnA();
    const after = promoteHitToSelection(before, vertexHit(asFeatureId('B'), asVertexId('b-9')));

    expect(after.activeFeature).toBe(asFeatureId('B'));
    expect(after.vertexOwner).toBe(asFeatureId('B'));
    expect([...after.vertexIds]).toEqual([asVertexId('b-9')]);
  });

  it('matches the LEFT-click reducer body branch (withoutVertexSet ∘ withActiveFeature)', () => {
    // Single truth source: the promote result equals the reducer's body-branch value.
    const before = withVertexSelectionOnA();
    const promoted = promoteHitToSelection(before, featureBodyHit(asFeatureId('B')));
    const reducerBody = { ...before, activeFeature: asFeatureId('B'), vertexOwner: null, vertexIds: new Set() };
    expect(promoted.activeFeature).toBe(reducerBody.activeFeature);
    expect(promoted.vertexOwner).toBe(reducerBody.vertexOwner);
    expect(promoted.vertexIds.size).toBe(0);
  });

  it('an EMPTY / EDGE hit leaves the current selection untouched (no promote target)', () => {
    const before = withVertexSelectionOnA();
    expect(promoteHitToSelection(before, EMPTY_HIT)).toBe(before);
    expect(
      promoteHitToSelection(
        before,
        edgeHit(asFeatureId('A'), asVertexId('a-1'), asVertexId('a-2')),
      ),
    ).toBe(before);
  });
});

describe('PointerDispatcher → live context-menu port (the bug seam)', () => {
  function dispatcherWith(
    hitTester: HitTester,
    port: ReturnType<typeof createLiveContextMenuPort>,
    cam = recordingCameraPort(),
  ): { dispatcher: PointerDispatcher; cam: ReturnType<typeof recordingCameraPort> } {
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.View,
      camera: cam,
      hitTester,
      selection: NOOP_SELECTION_PORT,
      add: NOOP_ADD_PORT,
      contextMenu: port,
    });
    return { dispatcher, cam };
  }

  it('a right-button press in View mode reaches the live port (not a no-op) and never pans', () => {
    const h = harness();
    const hitTester: HitTester = { hitTest: () => featureBodyHit(asFeatureId('f-7')) };
    const { dispatcher, cam } = dispatcherWith(hitTester, h.port);

    dispatcher.pointerDown(rightDown());

    // The defect was: NOOP port ⇒ zero opens. The live port must have opened once.
    expect(h.opened).toHaveLength(1);
    expect(h.promoted).toHaveLength(1);
    // Right button is always a context-menu request, never a pan (受け入れ基準 3).
    expect(cam.writes).toHaveLength(0);
    expect(dispatcher.isPanning).toBe(false);
    expect(dispatcher.activeCount).toBe(0); // no tracked sequence started
  });

  it('a right-button press in Edit mode over empty space still opens the menu', () => {
    const h = harness();
    const port = h.port;
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.Edit,
      camera: recordingCameraPort(),
      hitTester: EMPTY_HIT_TESTER,
      selection: NOOP_SELECTION_PORT,
      add: NOOP_ADD_PORT,
      contextMenu: port,
    });

    dispatcher.pointerDown(rightDown(10, 20));

    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.hit).toEqual(EMPTY_HIT);
    expect(h.promoted).toEqual([]);
  });
});

// --- A1: 下書きを持っている間の右クリックは「開くが、選択は変えない」 ------------
//
// 増分 5 の手直し A1 / バグ狩り #1。増分 5c で「右クリックはダイアログのときだけ止める」
// に直した結果、**作図中の右クリックが選択を書き換え、それを見張っていた追加の道具が
// 下書きを捨てて視点まで飛ばす**という事故が起きた（実データで再現・重症度 4）。
//
// 直し方は「メニューを開かない」ではない ―― 設計書 §I.3 の原則①は「いつでも開ける
// （道具を持っている間も。中身が変わるだけ）」である。**止めるのは昇格だけ**にする。
//
// だから `suspended`（要求ごと捨てる）と `promotes`（昇格だけ止める）は **別の口**で
// なければならない。同じ真偽値 1 本に畳み直したら、下の 2 つの describe のどちらかが
// 必ず落ちる。

describe('createLiveContextMenuPort — promotes gate（A1: 開くが昇格しない）', () => {
  function promotesHarness(promotes: () => boolean): PortHarness {
    const promoted: HitResult[] = [];
    const opened: { clientX: number; clientY: number; hit: HitResult }[] = [];
    const port = createLiveContextMenuPort({
      surfaceToClient: (p: ScreenPoint) => ({ x: p.x + 100, y: p.y + 200 }),
      promoteHit: (hit) => promoted.push(hit),
      open: (req) => opened.push(req),
      promotes,
    });
    return { promoted, opened, port };
  }

  it('promotes:false ⇒ 地物の当たりでも昇格しない（選択はそのまま）', () => {
    const h = promotesHarness(() => false);
    const hit = featureBodyHit(asFeatureId('f-1'));
    h.port.request({ x: 30, y: 40 }, hit);
    expect(h.promoted).toEqual([]);
  });

  it('promotes:false でも open は必ず呼ばれる（メニューは開く。設計書 §I.3 の原則①）', () => {
    // 「昇格しない」を「メニューも出さない」で実装すると、道具を構えている間だけ
    // 右クリックが死ぬ ―― §I.3 が名指しで禁じている退行なので、独立に固定する。
    const h = promotesHarness(() => false);
    const hit = featureBodyHit(asFeatureId('f-1'));
    h.port.request({ x: 30, y: 40 }, hit);
    expect(h.opened).toEqual([{ clientX: 130, clientY: 240, hit }]);
  });

  it('promotes:false ⇒ 頂点の当たりでも同じ（開くだけ・昇格しない）', () => {
    const h = promotesHarness(() => false);
    const hit = vertexHit(asFeatureId('f-2'), asVertexId('v-9'));
    h.port.request({ x: 1, y: 2 }, hit);
    expect(h.promoted).toEqual([]);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.hit).toBe(hit);
  });

  it('promotes:true ⇒ 従来どおり昇格して開く', () => {
    const h = promotesHarness(() => true);
    const hit = featureBodyHit(asFeatureId('f-1'));
    h.port.request({ x: 30, y: 40 }, hit);
    expect(h.promoted).toEqual([hit]);
    expect(h.opened).toHaveLength(1);
  });

  it('promotes を渡さなければ従来どおり昇格する（既定は「昇格する」）', () => {
    // 省略時に昇格が止まると、合成ルートが渡し忘れた瞬間に右クリックの［削除］が
    // 「右クリックした地物」に効かなくなる（教訓 5.11 の退行）。既定を固定する。
    const h = harness(); // promotes を渡していない harness
    const hit = featureBodyHit(asFeatureId('f-3'));
    h.port.request({ x: 7, y: 8 }, hit);
    expect(h.promoted).toEqual([hit]);
    expect(h.opened).toHaveLength(1);
  });

  it('promotes は要求のたびに読み直す（古い写しを掴まない。教訓 5.6）', () => {
    // 下書きの有無は要求ごとに変わる。作った時点の値を焼き付けていると、道具を
    // 構えた瞬間の値のまま昇格し続ける／止まり続ける。
    let drawing = true;
    const h = promotesHarness(() => !drawing);
    const hit = featureBodyHit(asFeatureId('f-4'));
    h.port.request({ x: 0, y: 0 }, hit);
    expect(h.promoted).toEqual([]);
    drawing = false; // 下書きを捨てた
    h.port.request({ x: 0, y: 0 }, hit);
    expect(h.promoted).toEqual([hit]);
    expect(h.opened).toHaveLength(2); // どちらの回もメニューは開いている
  });

  it('suspended:true が勝つ ―― promotes:true でも両方とも走らない（既存の契約）', () => {
    // `suspended`（ダイアログ）と `promotes`（下書き）は別の口である。畳んで 1 本に
    // すると、ここか上の「開く」のどちらかが必ず落ちる。
    const promoted: HitResult[] = [];
    const opened: { clientX: number; clientY: number; hit: HitResult }[] = [];
    const port = createLiveContextMenuPort({
      surfaceToClient: (p: ScreenPoint) => ({ x: p.x + 100, y: p.y + 200 }),
      promoteHit: (hit) => promoted.push(hit),
      open: (req) => opened.push(req),
      suspended: () => true,
      promotes: () => true,
    });
    port.request({ x: 30, y: 40 }, featureBodyHit(asFeatureId('f-5')));
    expect(promoted).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('suspended:true は promotes:false と組んでも両方とも走らない（既存の契約）', () => {
    const promoted: HitResult[] = [];
    const opened: { clientX: number; clientY: number; hit: HitResult }[] = [];
    const port = createLiveContextMenuPort({
      surfaceToClient: (p: ScreenPoint) => ({ x: p.x + 100, y: p.y + 200 }),
      promoteHit: (hit) => promoted.push(hit),
      open: (req) => opened.push(req),
      suspended: () => true,
      promotes: () => false,
    });
    port.request({ x: 30, y: 40 }, featureBodyHit(asFeatureId('f-6')));
    expect(promoted).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('空振りの右クリックは promotes に関係なく昇格しない（選択を黙って消さない）', () => {
    for (const promotes of [true, false]) {
      const h = promotesHarness(() => promotes);
      h.port.request({ x: 5, y: 6 }, EMPTY_HIT);
      expect(h.promoted).toEqual([]);
      expect(h.opened).toEqual([{ clientX: 105, clientY: 206, hit: EMPTY_HIT }]);
    }
  });
});

// --- 増分 8C: 測量の線の右クリック（設計書 §E.1 V15）-----------------------------
//
// 地図から来た右クリックだけが、押した点に当たる測量の線の id を要求に載せる。線に
// 当たったときは、その線が押した相手なので **地物を昇格しない**（下の国を黙って選択へ
// 引き上げない）。当たらなければ従来どおり。

describe('createLiveContextMenuPort — 測量の線（増分 8C）', () => {
  function surveyHarness(
    probe: (p: ScreenPoint) => readonly number[],
    extra: { suspended?: () => boolean } = {},
  ) {
    const promoted: HitResult[] = [];
    const opened: { clientX: number; clientY: number; hit: HitResult; surveyLineIds?: readonly number[] | undefined }[] = [];
    const probed: ScreenPoint[] = [];
    const port = createLiveContextMenuPort({
      surfaceToClient: (p: ScreenPoint) => ({ x: p.x + 100, y: p.y + 200 }),
      promoteHit: (hit) => promoted.push(hit),
      open: (req) => opened.push(req),
      probeSurveyLines: (p) => {
        probed.push(p);
        return probe(p);
      },
      ...extra,
    });
    return { promoted, opened, probed, port };
  }

  it('当たった線の id を、押した面（surface）の点で調べて要求に載せる', () => {
    const h = surveyHarness(() => [3, 1]);
    h.port.request({ x: 30, y: 40 }, EMPTY_HIT);
    expect(h.probed).toEqual([{ x: 30, y: 40 }]);
    expect(h.opened).toEqual([
      { clientX: 130, clientY: 240, hit: EMPTY_HIT, surveyLineIds: [3, 1] },
    ]);
  });

  it('線に当たったら、下に地物があっても昇格しない（押した相手は線）', () => {
    const h = surveyHarness(() => [2]);
    const hit = featureBodyHit(asFeatureId('f-under'));
    h.port.request({ x: 30, y: 40 }, hit);
    expect(h.promoted).toEqual([]);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.surveyLineIds).toEqual([2]);
    expect(h.opened[0]?.hit).toBe(hit);
  });

  it('線に当たらなければ従来どおり（地物は昇格し、要求に surveyLineIds は付かない）', () => {
    const h = surveyHarness(() => []);
    const hit = featureBodyHit(asFeatureId('f-1'));
    h.port.request({ x: 30, y: 40 }, hit);
    expect(h.promoted).toEqual([hit]);
    expect(h.opened).toEqual([{ clientX: 130, clientY: 240, hit }]);
  });

  it('suspended のときは線を調べもしない（要求ごと捨てる既存の契約）', () => {
    const h = surveyHarness(() => [1], { suspended: () => true });
    h.port.request({ x: 30, y: 40 }, EMPTY_HIT);
    expect(h.probed).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it('probeSurveyLines を渡さなければ従来どおり（要求に surveyLineIds は付かない）', () => {
    const h = harness();
    h.port.request({ x: 5, y: 6 }, EMPTY_HIT);
    expect(h.opened).toEqual([{ clientX: 105, clientY: 206, hit: EMPTY_HIT }]);
  });
});
