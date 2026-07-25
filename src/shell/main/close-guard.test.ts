// FR-107 close ブリッジの契約テスト（残 HIGH リスクの根治点）.
//
// 守るべき不変条件（どれもデータ損失に直結する）:
//   (1) × / Alt+F4 / OS シャットダウンで飛んでくる close は、レンダラの未保存確認
//       （quitGuard）が **許可を返すまで閉じない**（fail-closed 契約）。
//   (2) 許可されたときだけ one-shot フラグ付きで再 close する（無限ループ防止）。
//   (3) 確認ダイアログ表示中の再 × は **2 通目の IPC を送らない**（二重ダイアログ防止）。
//
// ─── 敵対レビュー所見の根治（ACK プロトコル）────────────────────────────────────
//   所見1 [HIGH] fail-OPEN: 生きているレンダラ（購読者あり）は「ロード状態」に依存せず
//     **必ず照会される**。中断ナビゲーション後の恒久 false ラッチで確認を素通しにしない。
//     購読者が居るかは片方向ラッチではなく **即時 ACK** で判定する。
//   所見1（最終レビュー）[HIGH] ACK タイムアウト ≠ 購読者不在: ACK が来なくても「フリーズ
//     （生きているが応答不能）」の可能性がある。**自動では閉じず**、ネイティブ確認ダイアログ
//     （依存注入でモック）でユーザーへ委ねる。キャンセルで閉じない・「終了する」で閉じる・
//     ダイアログ提示中に本物の ACK が届いたら通常フローへ復帰（後着選択は世代で失効）。
//   所見2 [MED] 複数購読者の先勝ち: preload 側の単一購読テストで固定（preload.test.ts）。
//   所見3 [MED] event.sender 非検証: 応答は要求を発行した webContents からのものだけ受理する
//     （sender 不一致は無視）。ここでは senderId を明示して受理 / 無視を固定する。
//   所見3（旧）タイムアウトが選択を無言破棄: ACK 後の判定には **恣意的な破棄タイムアウトを
//     置かない**。ユーザーが何分悩んでも遅れて届いた応答は必ず有効。ハングした/消えた
//     レンダラは「レンダラ死（再読み込み・プロセス消滅）」の購読で settle して wedge を防ぐ。
//   (4) レンダラが到達不能（クラッシュ/破棄済み）なときだけ確認を省略して閉じる
//       （その時点で未保存データは既に失われており、ブロックしても守るものが無い）。
//
// この単位は Electron を import しない純粋ロジック（開発ガイド §5.41）。合成ルート
// (main/index.ts) が実物の BrowserWindow / app / webContents を束縛する。

import { describe, expect, it, vi } from 'vitest';

import {
  CLOSE_DECISION,
  CLOSE_GUARD_LOG,
  createCloseGuardHub,
  type CloseGuardEnv,
  type CloseGuardWindowPorts,
} from './close-guard';

/** The webContents.id the harness's window reports (所見3 sender 検証の既定値). */
const SENDER = 42;

interface Harness {
  readonly env: CloseGuardEnv;
  readonly ports: CloseGuardWindowPorts;
  readonly sent: string[];
  readonly logs: string[];
  readonly closeWindow: ReturnType<typeof vi.fn>;
  readonly quitApp: ReturnType<typeof vi.fn>;
  /** Fire the pending ACK-timeout timer (simulates a renderer that returns no ACK). */
  readonly fireAckTimeout: () => void;
  /** Number of timers still armed (asserts the ACK path disarms its timer). */
  readonly armedTimers: () => number;
  /** How many native "unresponsive" dialogs are currently open (pending resolution). */
  readonly unresponsivePrompts: () => number;
  /**
   * Resolve the OLDEST open unresponsive-dialog with the user's choice
   * (true = 「終了する」 / false = キャンセル) and flush the awaiting continuation so
   * the guard's decision has been applied when this resolves.
   */
  readonly resolveUnresponsive: (quit: boolean) => Promise<void>;
  reachable: boolean;
}

function harness(overrides: Partial<CloseGuardWindowPorts> = {}): Harness {
  const sent: string[] = [];
  const logs: string[] = [];
  const closeWindow = vi.fn();
  const quitApp = vi.fn();
  const timers = new Map<number, () => void>();
  // Injected native-dialog stub (所見1): each ACK-timeout opens one dialog; its
  // resolver is queued here so a test can drive the user's choice deterministically.
  const dialogResolvers: ((quit: boolean) => void)[] = [];
  let nextTimer = 1;
  let nextId = 1;

  const h: Harness = {
    reachable: true,
    sent,
    logs,
    closeWindow,
    quitApp,
    fireAckTimeout: () => {
      const entries = [...timers.entries()];
      expect(entries.length, 'an ACK-timeout timer must be armed').toBeGreaterThan(0);
      const [id, fn] = entries[entries.length - 1]!;
      timers.delete(id);
      fn();
    },
    armedTimers: () => timers.size,
    unresponsivePrompts: () => dialogResolvers.length,
    resolveUnresponsive: async (quit) => {
      const resolve = dialogResolvers.shift();
      expect(resolve, 'a native unresponsive dialog must have been shown').toBeDefined();
      resolve!(quit);
      // Let the guard's `await ports.confirmUnresponsiveClose()` continuation run.
      await Promise.resolve();
      await Promise.resolve();
    },
    env: {
      newRequestId: () => `req-${String(nextId++)}`,
      setTimer: (fn, ms) => {
        expect(ms).toBeGreaterThan(0);
        const id = nextTimer++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (timer) => {
        timers.delete(timer as number);
      },
      log: (message) => {
        logs.push(message);
      },
      ackTimeoutMs: 2_000,
    },
    ports: {
      requestGuard: (requestId) => {
        sent.push(requestId);
      },
      closeWindow,
      quitApp,
      rendererReachable: () => h.reachable,
      senderId: () => SENDER,
      confirmUnresponsiveClose: () =>
        new Promise<boolean>((resolve) => {
          dialogResolvers.push(resolve);
        }),
      ...overrides,
    },
  };
  return h;
}

/** Drive one window through the full ACK → verdict handshake and return its guard/hub. */
function wired(overrides: Partial<CloseGuardWindowPorts> = {}) {
  const h = harness(overrides);
  const hub = createCloseGuardHub(h.env);
  const guard = hub.attach(h.ports);
  return { h, hub, guard };
}

describe('close ブリッジ: 未保存確認が許可するまで閉じない (FR-107)', () => {
  it('最初の close は BLOCK し、レンダラへ確認要求を1通だけ送る', () => {
    const { h, guard } = wired();
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.sent).toEqual(['req-1']);
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.quitApp).not.toHaveBeenCalled();
  });

  it('所見1: 生きているレンダラは ACK を返すので確認を素通ししない（ロード状態に依存しない）', () => {
    // 中断ナビゲーション後でも、元 document(App+購読者) が生きていれば ACK が返る。ACK を
    // 受けたら「購読者実在」なので ackTimeout を解除し、判定を待つ（勝手に閉じない）。
    const { h, hub, guard } = wired();
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.armedTimers()).toBe(1); // ACK 待ちタイマー armed
    hub.acceptAck({ requestId: 'req-1' });
    expect(h.armedTimers()).toBe(0); // ACK 受領でタイマー解除（誤 fail-open しない）
    expect(h.closeWindow).not.toHaveBeenCalled(); // ACK だけでは閉じない
    expect(h.logs).toContain(CLOSE_GUARD_LOG.acked);
  });

  it('ACK → 許可応答で one-shot 許可 → 再 close を1回だけ発行し、その close は ALLOW', () => {
    const { h, hub, guard } = wired();
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    hub.acceptAck({ requestId: 'req-1' });
    hub.acceptVerdict({ requestId: 'req-1', allow: true });

    expect(h.closeWindow).toHaveBeenCalledTimes(1);
    // 再入した close イベントは素通しする（= 無限ループしない）.
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Allow);
    // ...そして2度目の確認要求は送らない（one-shot）.
    expect(h.sent).toEqual(['req-1']);
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('拒否応答では閉じず、次の × で確認をやり直せる（wedge しない）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' });
    hub.acceptVerdict({ requestId: 'req-1', allow: false });
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.logs).toContain(CLOSE_GUARD_LOG.blocked);

    // 2 回目の × は新しい要求 ID で再照会される（ガードが固まらない）.
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.sent).toEqual(['req-1', 'req-2']);
  });

  it('確認ダイアログ表示中の再 × は BLOCK のみ（2 通目の IPC を送らない = 二重ダイアログ防止）', () => {
    const { h, hub, guard } = wired();
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    hub.acceptAck({ requestId: 'req-1' }); // asking へ
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.sent).toEqual(['req-1']);
    expect(h.logs.filter((m) => m === CLOSE_GUARD_LOG.duplicate)).toHaveLength(2);
  });

  it('ACK 前（awaitingAck）の再 × も BLOCK のみで新規要求を送らない', () => {
    const { h, guard } = wired();
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.sent).toEqual(['req-1']);
  });
});

describe('所見1（最終レビュー）: ACK タイムアウト ≠ 購読者不在 — 自動では閉じずダイアログで確認', () => {
  it('ACK が来なくても自動では閉じない: ネイティブ確認ダイアログを 1 枚だけ提示する', () => {
    // 旧実装は ackTimeout で「購読者不在」とみなし確認を省略して閉じた。フリーズした
    // （生きているが JS がブロックした）未保存レンダラを黙って閉じる fail-closed 契約の破れ。
    const { h, guard } = wired();
    guard.onCloseAttempt();
    expect(h.closeWindow).not.toHaveBeenCalled();
    h.fireAckTimeout(); // ACK が返らない（フリーズ or 購読者不在 — 区別できない）
    // 自動では閉じない — ダイアログを提示するだけ.
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.unresponsivePrompts()).toBe(1);
    expect(h.logs).toContain(CLOSE_GUARD_LOG.unresponsivePrompting);
  });

  it('ダイアログで「終了する」を明示選択すると閉じる', async () => {
    const { h, guard } = wired();
    guard.onCloseAttempt();
    h.fireAckTimeout();
    await h.resolveUnresponsive(true); // ユーザーが「終了する」を選ぶ
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
    expect(h.logs).toContain(CLOSE_GUARD_LOG.unresponsiveQuit);
  });

  it('ダイアログをキャンセルすると閉じず、次の × で再照会できる（wedge しない）', async () => {
    const { h, guard } = wired();
    guard.onCloseAttempt();
    h.fireAckTimeout();
    await h.resolveUnresponsive(false); // キャンセル → 閉じない
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.logs).toContain(CLOSE_GUARD_LOG.unresponsiveCancelled);
    // idle に戻っているので次の × は新規要求で再照会される.
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.sent).toEqual(['req-1', 'req-2']);
  });

  it('ダイアログ表示が失敗（reject）したら閉じない（安全側）', async () => {
    const { h, guard } = wired({
      confirmUnresponsiveClose: () => Promise.reject(new Error('dialog failed')),
    });
    guard.onCloseAttempt();
    h.fireAckTimeout();
    // reject は onAckTimeout 内で握られ「閉じない」に倒れる（microtask を流す）.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.logs).toContain(CLOSE_GUARD_LOG.unresponsiveCancelled);
  });

  it('ダイアログ提示中の再 × は BLOCK のみ（2 枚目のダイアログも 2 通目の IPC も無い）', () => {
    const { h, guard } = wired();
    guard.onCloseAttempt();
    h.fireAckTimeout();
    expect(h.unresponsivePrompts()).toBe(1);
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.unresponsivePrompts()).toBe(1);
    expect(h.sent).toEqual(['req-1']);
    expect(h.logs.filter((m) => m === CLOSE_GUARD_LOG.duplicate)).toHaveLength(2);
  });

  it('ダイアログ提示中に本物の ACK が届いたら通常フローへ復帰し、後着の「終了する」は無視する', async () => {
    // 遅れて ACK が届く = レンダラは生きていた（一時的にフリーズしていただけ）。判定を待ち、
    // その後にネイティブダイアログが「終了する」で解決しても、世代不一致で失効させて無視する
    // （ACK 到着後の verdict を優先 — 二重決定を requestId 世代で一貫させる）。
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    h.fireAckTimeout(); // → unresponsive, ダイアログ提示
    hub.acceptAck({ requestId: 'req-1' }, SENDER); // 遅れて本物の ACK → asking へ復帰
    expect(h.logs).toContain(CLOSE_GUARD_LOG.acked);

    // ここでダイアログが「終了する」で後から解決しても無視される（既に asking）.
    await h.resolveUnresponsive(true);
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.logs).toContain(CLOSE_GUARD_LOG.unresponsiveStale);

    // 通常の判定は依然として有効（無視が状態を壊していない）.
    hub.acceptVerdict({ requestId: 'req-1', allow: true }, SENDER);
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('ダイアログ解決後に届いた ACK / 応答は失効 ID として無視される', async () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    h.fireAckTimeout();
    await h.resolveUnresponsive(false); // キャンセル → idle, pending 解放
    hub.acceptAck({ requestId: 'req-1' }, SENDER);
    hub.acceptVerdict({ requestId: 'req-1', allow: true }, SENDER);
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.logs).toContain(CLOSE_GUARD_LOG.staleVerdict);
  });

  it('quit 由来で応答不能 → ダイアログの「終了する」で app.quit を再発行する', async () => {
    const { h, hub, guard } = wired();
    hub.noteQuitRequested();
    guard.onCloseAttempt();
    h.fireAckTimeout();
    await h.resolveUnresponsive(true);
    expect(h.quitApp).toHaveBeenCalledTimes(1);
    expect(h.closeWindow).not.toHaveBeenCalled();
  });

  it('quit 由来で応答不能 → ダイアログをキャンセルすると quit 要求フラグも畳む', async () => {
    const { h, hub, guard } = wired();
    hub.noteQuitRequested();
    guard.onCloseAttempt();
    h.fireAckTimeout();
    await h.resolveUnresponsive(false); // キャンセル → quitRequested を畳む
    // 次の × は通常の close 経路（quit ではない）で許可される.
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-2' }, SENDER);
    hub.acceptVerdict({ requestId: 'req-2', allow: true }, SENDER);
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
    expect(h.quitApp).not.toHaveBeenCalled();
  });

  it('応答不能ダイアログ提示中にレンダラがクラッシュしたら確認を省略して閉じる', () => {
    const { h, guard } = wired();
    guard.onCloseAttempt();
    h.fireAckTimeout(); // → unresponsive
    guard.noteRendererGone(); // プロセス消滅 = 未保存はもう失われている
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
    expect(h.logs).toContain(CLOSE_GUARD_LOG.rendererGone);
  });

  it('応答不能ダイアログ提示中にレンダラが再読み込みしたら idle へ戻す（閉じない）', () => {
    const { h, guard } = wired();
    guard.onCloseAttempt();
    h.fireAckTimeout(); // → unresponsive
    guard.noteRendererReloading(); // document 破棄開始
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.logs).toContain(CLOSE_GUARD_LOG.rendererReloading);
    // 次の × で再照会される.
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.sent).toEqual(['req-1', 'req-2']);
  });
});

describe('所見3: 応答は要求を発行した webContents からのものだけ受理する（sender 検証）', () => {
  it('別 sender からの ACK は無視される（購読者確認を偽造できない）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' }, SENDER + 1); // 別 webContents
    expect(h.armedTimers()).toBe(1); // ACK は受理されず ackTimer は armed のまま
    expect(h.logs).toContain(CLOSE_GUARD_LOG.senderMismatch);
    // 正しい sender の ACK は効く（検証が正常系を壊していない）.
    hub.acceptAck({ requestId: 'req-1' }, SENDER);
    expect(h.armedTimers()).toBe(0);
  });

  it('別 sender からの判定は無視される（他ウィンドウの close を詐称で許可させない）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' }, SENDER);
    hub.acceptVerdict({ requestId: 'req-1', allow: true }, SENDER + 1); // 別 webContents
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.logs).toContain(CLOSE_GUARD_LOG.senderMismatch);
    // 正しい sender の判定は効く.
    hub.acceptVerdict({ requestId: 'req-1', allow: true }, SENDER);
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('正しい sender の ACK → 判定は通常どおり閉じる（検証は防御的で正常系を妨げない）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' }, SENDER);
    hub.acceptVerdict({ requestId: 'req-1', allow: true }, SENDER);
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
  });
});

describe('所見3: ACK 後は破棄タイムアウトを置かない（長考しても選択は必ず有効）', () => {
  it('ACK 受領後はタイマーが1本も残らない（判定に破棄タイムアウトが無い）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    expect(h.armedTimers()).toBe(1); // ACK 待ちのみ
    hub.acceptAck({ requestId: 'req-1' });
    expect(h.armedTimers()).toBe(0); // ACK 後は無タイマー = 破棄タイムアウトが存在しない
  });

  it('ACK 後に（どれだけ待っても）届いた許可応答は有効で閉じる', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' });
    // ここで「何分でも」経過した想定 — 破棄タイマーは無いので発火しようがない.
    expect(h.armedTimers()).toBe(0);
    hub.acceptVerdict({ requestId: 'req-1', allow: true });
    expect(h.closeWindow).toHaveBeenCalledTimes(1); // 無言破棄されない
  });

  it('照会中にレンダラが再読み込みを開始したら idle へ戻す（wedge せず再照会可能）', () => {
    // 別 document の commit / App root アンマメント等で購読者が消える経路の un-wedge.
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' });
    guard.noteRendererReloading(); // did-start-loading = document 破棄開始
    expect(h.logs).toContain(CLOSE_GUARD_LOG.rendererReloading);
    expect(h.closeWindow).not.toHaveBeenCalled(); // 自動では閉じない（中断ナビで fail-open しない）
    // idle に戻っているので次の × は新規要求で再照会される.
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(h.sent).toEqual(['req-1', 'req-2']);
  });

  it('照会中にレンダラがクラッシュしたら確認を省略して閉じる（ダイアログのまま wedge しない）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' });
    guard.noteRendererGone(); // render-process-gone
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
    expect(h.logs).toContain(CLOSE_GUARD_LOG.rendererGone);
  });

  it('close 照会中でないときの再読み込み / クラッシュ通知は無視する（通常操作を閉じない）', () => {
    const { h, guard } = wired();
    guard.noteRendererReloading();
    guard.noteRendererGone();
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.quitApp).not.toHaveBeenCalled();
  });
});

describe('close ブリッジ: 異常系は fail-closed', () => {
  it('不正な形の応答（レンダラは信用しない）は無視する', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' });
    for (const bad of [null, undefined, 'req-1', 42, {}, { requestId: 'req-1' }, { allow: true },
      { requestId: 1, allow: true }, { requestId: 'req-1', allow: 'yes' }]) {
      hub.acceptVerdict(bad);
    }
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.logs.filter((m) => m === CLOSE_GUARD_LOG.invalidVerdict)).toHaveLength(9);
    // ...そして正しい応答は依然として効く（無視が状態を壊していない）.
    hub.acceptVerdict({ requestId: 'req-1', allow: true });
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('不正な形の ACK は無視する（購読者確認を偽造できない）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    for (const bad of [null, undefined, 42, {}, { requestId: 1 }, { requestId: '' }]) {
      hub.acceptAck(bad);
    }
    // ACK が確定していないので ackTimeout はまだ armed（購読者確認が偽造で解除されない）.
    expect(h.armedTimers()).toBe(1);
  });

  it('レンダラが到達不能なら確認を省略して閉じる（ウィンドウをブリックしない）', () => {
    const h = harness();
    h.reachable = false;
    const hub = createCloseGuardHub(h.env);
    const guard = hub.attach(h.ports);

    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Allow);
    expect(h.sent).toEqual([]);
    expect(h.logs).toContain(CLOSE_GUARD_LOG.rendererGone);
  });

  it('確認要求の送信が throw しても閉じられる（送信不能 = 到達不能と同じ扱い）', () => {
    const { h, guard } = wired({
      requestGuard: () => {
        throw new Error('webContents destroyed');
      },
    });
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Allow);
    expect(h.logs).toContain(CLOSE_GUARD_LOG.rendererGone);
    // 送信に失敗した要求はタイマーごと畳まれている（漏れた ACK タイマーで後から状態が動かない）.
    expect(h.armedTimers()).toBe(0);
  });
});

describe('close ブリッジ: quit 経路との整合 / 多重ウィンドウ', () => {
  it('app quit 由来の close を許可したら window.close ではなく app.quit を再発行する', () => {
    const { h, hub, guard } = wired();
    hub.noteQuitRequested(); // app.on('before-quit')
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' });
    hub.acceptVerdict({ requestId: 'req-1', allow: true });

    expect(h.quitApp).toHaveBeenCalledTimes(1);
    expect(h.closeWindow).not.toHaveBeenCalled();
  });

  it('quit を拒否したら quit 要求フラグも畳む（後の × が勝手にアプリ終了にならない）', () => {
    const { h, hub, guard } = wired();
    hub.noteQuitRequested();
    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-1' });
    hub.acceptVerdict({ requestId: 'req-1', allow: false });

    guard.onCloseAttempt();
    hub.acceptAck({ requestId: 'req-2' });
    hub.acceptVerdict({ requestId: 'req-2', allow: true });
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
    expect(h.quitApp).not.toHaveBeenCalled();
  });

  it('応答は要求 ID でウィンドウごとに振り分けられる（混線しない）', () => {
    const h1 = harness();
    const hub = createCloseGuardHub(h1.env);
    const g1 = hub.attach(h1.ports);
    const other = harness();
    const g2 = hub.attach(other.ports);

    g1.onCloseAttempt(); // req-1
    g2.onCloseAttempt(); // req-2
    hub.acceptAck({ requestId: 'req-2' });
    hub.acceptVerdict({ requestId: 'req-2', allow: true });

    expect(other.closeWindow).toHaveBeenCalledTimes(1);
    expect(h1.closeWindow).not.toHaveBeenCalled();
    expect(g1.onCloseAttempt()).toBe(CLOSE_DECISION.Block);
    expect(g2.onCloseAttempt()).toBe(CLOSE_DECISION.Allow);
  });

  it('dispose 済みガードへの ACK / 応答は無視される（ウィンドウ再作成でリスナが混ざらない）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    guard.dispose();
    expect(h.armedTimers()).toBe(0);
    hub.acceptAck({ requestId: 'req-1' });
    hub.acceptVerdict({ requestId: 'req-1', allow: true });
    expect(h.closeWindow).not.toHaveBeenCalled();
  });

  it('forceAllow は以後の close を素通しする（E2E ハーネスの後始末専用の脱出口）', () => {
    const { h, hub, guard } = wired();
    guard.onCloseAttempt();
    hub.forceAllow('E2E teardown');
    expect(guard.onCloseAttempt()).toBe(CLOSE_DECISION.Allow);
    // 強制許可はそれ自体では閉じない（素通しにするだけ）.
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.armedTimers()).toBe(0);
    expect(h.logs.some((m) => m.startsWith(CLOSE_GUARD_LOG.forceAllowed))).toBe(true);
  });
});
