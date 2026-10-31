// E2E の起動の使い回し（e2e/shared-launch.ts、開発ガイド §1.12）を Electron 抜きで確かめる。
//
// 本物の `launchApp` → `launchShared` の道を通し、外側（Playwright の起動、アプリ、プロセス）だけを
// 偽物に替える（§5.41）。本物の Electron での確かめは `npm run e2e:shared` が受け持つ。
//
// 見ているのは「本体の取り違え」と「本体の取り残し」である:
//   - 親の環境変数が変わったのに、前の値で起動した本体を渡さない
//   - 値の表現が衝突して、残したものを見逃さない（null と文字列 "null"）
//   - 閉じずに終わった本体や、閉じるのに失敗した本体を止めてから次を起動し、記録に書く
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeProcess extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  killCount: number;
  kill: () => boolean;
}

interface FakeApp extends EventEmitter {
  id: number;
  env: Record<string, string>;
  args: readonly string[];
  mainState: { probe: Record<string, unknown> };
  processHandle: FakeProcess;
  /** 本物の close の動き。 */
  closeBehavior: 'exit' | 'reject' | 'reject-and-stay' | 'resolve-and-stay' | 'hang';
  /** 強制終了が効かないプロセス。 */
  unkillable: boolean;
  closeCalls: number;
  events: string[];
}

const world = vi.hoisted(() => ({
  apps: [] as unknown[],
  events: [] as string[],
  nextProbe: (): Record<string, unknown> => ({ backupSourceCandidate: null, loadCommitCount: 0 }),
  info: null as null | Record<string, unknown>,
  launch: null as null | ((options: { env: Record<string, string>; args: string[] }) => Promise<unknown>),
  forceKill: null as null | ((pid: number) => void),
}));

vi.mock('@playwright/test', () => ({
  test: {
    info: (): unknown => {
      if (world.info === null) throw new Error('検査の外');
      return world.info;
    },
  },
  expect: () => ({ toHaveCount: () => Promise.resolve() }),
}));

vi.mock('playwright', () => ({
  _electron: { launch: (options: { env: Record<string, string>; args: string[] }) => world.launch?.(options) },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    // 強制終了が本物の PID へ飛ばないようにする。
    spawnSync: (command: string, args: readonly string[]) => {
      const at = args.indexOf('/pid');
      if (command === 'taskkill' && at >= 0) world.forceKill?.(Number(args[at + 1]));
      return { status: 0 };
    },
  };
});

let nextId = 0;

function exitProcess(app: FakeApp): void {
  const proc = app.processHandle;
  if (proc.exitCode !== null) return;
  proc.exitCode = 0;
  app.events.push(`exit:${String(app.id)}`);
  proc.emit('exit', 0, null);
}

function createFakeApp(options: { env: Record<string, string>; args: string[] }): FakeApp {
  nextId += 1;
  const id = nextId;
  const proc = new EventEmitter() as FakeProcess;
  proc.pid = 900_000 + id;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killCount = 0;
  const app = new EventEmitter() as FakeApp;
  proc.kill = (): boolean => {
    proc.killCount += 1;
    if (!app.unkillable) exitProcess(app);
    return true;
  };
  const page = Object.assign(new EventEmitter(), {
    keyboard: { down: () => Promise.resolve(), up: () => Promise.resolve() },
    mouse: { down: () => Promise.resolve(), up: () => Promise.resolve(), move: () => Promise.resolve() },
    evaluate: () => Promise.resolve({ localStorage: [], cookie: '' }),
    reload: () => Promise.resolve(),
    waitForSelector: () => Promise.resolve(),
    viewportSize: () => ({ width: 800, height: 600 }),
    isClosed: () => false,
    // 初回ガイドは「出なかった」扱いにする。
    getByTestId: () => ({ waitFor: () => Promise.reject(new Error('出ない')), click: () => Promise.resolve() }),
  });
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    clock: {},
    tracing: {},
  });
  Object.assign(app, {
    id,
    env: options.env,
    args: options.args,
    mainState: { probe: world.nextProbe() },
    processHandle: proc,
    closeBehavior: 'exit',
    unkillable: false,
    closeCalls: 0,
    events: world.events,
    firstWindow: () => Promise.resolve(page),
    evaluate: () => Promise.resolve(app.mainState),
    windows: () => [page],
    context: () => context,
    process: () => proc,
    close: async (): Promise<void> => {
      app.closeCalls += 1;
      app.events.push(`close:${String(id)}`);
      if (app.closeBehavior === 'hang') await new Promise(() => undefined);
      if (app.closeBehavior === 'reject') {
        exitProcess(app);
        throw new Error('注入した終了の失敗');
      }
      if (app.closeBehavior === 'reject-and-stay') throw new Error('注入した終了の失敗');
      if (app.closeBehavior === 'resolve-and-stay') return;
      exitProcess(app);
    },
  });
  world.apps.push(app);
  world.events.push(`start:${String(id)}`);
  return app;
}

type Helpers = typeof import('../../e2e/helpers');
type Shared = typeof import('../../e2e/shared-launch');

let sandbox = '';
let logPath = '';
let launchApp: Helpers['launchApp'];
let shared: Shared;
const savedEnv: Record<string, string | undefined> = {};
const SAVED_KEYS = ['TEMP', 'TMP', 'E2E_LAUNCH_MODE', 'E2E_LAUNCH_LOG', 'E2E_LAUNCH_RUN', 'E2E_SAVE_AS_PATH'];

beforeAll(() => {
  for (const key of SAVED_KEYS) savedEnv[key] = process.env[key];
  sandbox = mkdtempSync(join(tmpdir(), 'e2e-shared-launch-test-'));
  // helpers.ts が読み込み時に作る userData を、この検査の置き場の中へ入れる。
  process.env['TEMP'] = sandbox;
  process.env['TMP'] = sandbox;
});

afterAll(() => {
  for (const key of SAVED_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

let logCounter = 0;

async function loadModules(mode: 'shared' | 'survey' | undefined): Promise<void> {
  vi.resetModules();
  logCounter += 1;
  logPath = join(sandbox, `log-${String(logCounter)}.jsonl`);
  process.env['E2E_LAUNCH_LOG'] = logPath;
  if (mode === undefined) delete process.env['E2E_LAUNCH_MODE'];
  else process.env['E2E_LAUNCH_MODE'] = mode;
  launchApp = (await import('../../e2e/helpers')).launchApp;
  shared = await import('../../e2e/shared-launch');
}

function enterTest(name: string, extra: Record<string, unknown> = {}): void {
  world.info = {
    testId: name,
    retry: 0,
    titlePath: ['spec', name],
    file: 'spec.ts',
    workerIndex: 0,
    annotations: [],
    errors: [],
    status: 'passed',
    duration: 0,
    ...extra,
  };
}

function appAt(index: number): FakeApp {
  return world.apps[index] as FakeApp;
}

function records(): { ev: string; [key: string]: unknown }[] {
  if (!existsSync(logPath)) return [];
  // eslint-disable-next-line no-restricted-syntax -- ソースでなく、検査の対象が書いた記録を読む
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { ev: string });
}

beforeEach(async () => {
  nextId = 0;
  world.apps.length = 0;
  world.events.length = 0;
  world.nextProbe = () => ({ backupSourceCandidate: null, loadCommitCount: 0 });
  world.launch = (options) => Promise.resolve(createFakeApp(options));
  world.forceKill = (pid) => {
    const app = (world.apps as FakeApp[]).find((a) => a.processHandle.pid === pid);
    if (app !== undefined) app.processHandle.kill();
  };
  delete process.env['E2E_SAVE_AS_PATH'];
  await loadModules('shared');
});

afterEach(() => {
  vi.useRealTimers();
  world.info = null;
});

describe('対照: 何も起きなければ使い回す', () => {
  it('同じ条件で、閉じて、変えていなければ、次の検査へ同じ本体を渡す', async () => {
    enterTest('A');
    const a = await launchApp();
    await a.app.close();
    enterTest('B');
    const b = await launchApp();
    expect(b.app).toBe(a.app);
    expect(world.apps).toHaveLength(1);
    expect(appAt(0).closeCalls).toBe(0);
  });

  it('既定（E2E_LAUNCH_MODE 未指定）は検査ごとに起動し、閉じるのは本物の close のまま、記録も書かない', async () => {
    await loadModules(undefined);
    enterTest('A');
    const a = await launchApp();
    await a.app.close();
    expect(appAt(0).closeCalls).toBe(1);
    enterTest('B');
    await launchApp();
    expect(world.apps).toHaveLength(2);
    expect(records()).toEqual([]);
  });
});

describe('指摘 1: 親の環境変数', () => {
  it('親の E2E_SAVE_AS_PATH を変えて起動すると、前の値の本体を渡さず、新しい値で起動し直す', async () => {
    enterTest('A');
    process.env['E2E_SAVE_AS_PATH'] = 'A.gimoza';
    const a = await launchApp();
    await a.app.close();
    enterTest('B');
    process.env['E2E_SAVE_AS_PATH'] = 'B.gimoza';
    const b = await launchApp();
    expect(b.app).not.toBe(a.app);
    expect(appAt(1).env['E2E_SAVE_AS_PATH']).toBe('B.gimoza');
    // 前の本体は止めてから起動する。
    expect(world.events).toEqual(['start:1', 'close:1', 'exit:1', 'start:2']);
  });

  it('親の環境変数を消した場合も起動し直す', async () => {
    enterTest('A');
    process.env['E2E_SAVE_AS_PATH'] = 'A.gimoza';
    const a = await launchApp();
    await a.app.close();
    enterTest('B');
    delete process.env['E2E_SAVE_AS_PATH'];
    const b = await launchApp();
    expect(b.app).not.toBe(a.app);
    expect(appAt(1).env['E2E_SAVE_AS_PATH']).toBeUndefined();
  });

  it('extraEnv が親の値と同じになるなら、子プロセスの環境は同じなので使い回す', async () => {
    enterTest('A');
    process.env['E2E_SAVE_AS_PATH'] = 'A.gimoza';
    const a = await launchApp();
    await a.app.close();
    enterTest('B');
    delete process.env['E2E_SAVE_AS_PATH'];
    const b = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: 'A.gimoza' } });
    expect(b.app).toBe(a.app);
  });

  it('extraArgs と extraEnv の違いは今までどおり起動し直す', async () => {
    enterTest('A');
    const a = await launchApp({ extraArgs: ['--x=1'] });
    await a.app.close();
    enterTest('B');
    const b = await launchApp({ extraArgs: ['--x=2'] });
    expect(b.app).not.toBe(a.app);
    await b.app.close();
    enterTest('C');
    const c = await launchApp({ extraArgs: ['--x=2'], extraEnv: { E2E_SAVE_AS_PATH: 'C.gimoza' } });
    expect(c.app).not.toBe(b.app);
  });
});

describe('指摘 2: 値の表現の衝突', () => {
  it('null だった項目が文字列 "null" になったら差として捕まえ、次の検査へ渡さない', async () => {
    enterTest('A');
    const a = await launchApp();
    appAt(0).mainState.probe['backupSourceCandidate'] = 'null';
    await a.app.close();
    const checkin = records().find((r) => r.ev === 'checkin');
    expect(Object.keys(checkin?.['left'] as object)).toEqual(['main.probe.backupSourceCandidate']);
    expect(appAt(0).closeCalls).toBe(1);
    enterTest('B');
    const b = await launchApp();
    expect(b.app).not.toBe(a.app);
  });

  it('数と文字列、空の配列と文字列 "[]" も区別する', async () => {
    const pairs: readonly [unknown, unknown][] = [
      [1, '1'],
      [true, 'true'],
      [[], '[]'],
      [{}, '{}'],
      ['undefined', undefined],
    ];
    for (const [before, after] of pairs) {
      await loadModules('shared');
      world.apps.length = 0;
      world.nextProbe = () => ({ value: before });
      enterTest(`A-${String(after)}`);
      const a = await launchApp();
      appAt(0).mainState.probe['value'] = after;
      await a.app.close();
      expect(appAt(0).closeCalls, `${JSON.stringify(before)} → ${JSON.stringify(after)}`).toBe(1);
    }
  });
});

describe('指摘 3: 閉じずに終わった本体', () => {
  it('新規に起動した本体を閉じずに終わると、次の検査は止めてから起動し、記録に書き、赤にしない', async () => {
    enterTest('A');
    await launchApp();
    enterTest('B');
    const b = await launchApp();
    expect(b.app).not.toBe(appAt(0));
    expect(world.events).toEqual(['start:1', 'close:1', 'exit:1', 'start:2']);
    const found = records().filter((r) => r.ev === 'not-closed');
    expect(found).toHaveLength(1);
    expect(found[0]?.['test']).toBe('spec › A');
    expect(found[0]?.['nextTest']).toBe('spec › B');
    expect(found[0]?.['ownerFailed']).toBe(false);
  });

  it('使い回しで受け取った本体を閉じずに終わった場合も同じ', async () => {
    enterTest('A');
    const a = await launchApp();
    await a.app.close();
    enterTest('B');
    await launchApp();
    enterTest('C');
    const c = await launchApp();
    expect(c.app).not.toBe(a.app);
    expect(world.events).toEqual(['start:1', 'close:1', 'exit:1', 'start:2']);
    expect(records().filter((r) => r.ev === 'not-closed').map((r) => r['test'])).toEqual(['spec › B']);
  });

  it('同じ検査の 2 回目の起動は、前のものに触らない（閉じ忘れと数えない）', async () => {
    enterTest('A');
    const first = await launchApp();
    await launchApp();
    expect(world.apps).toHaveLength(2);
    expect(appAt(0).closeCalls).toBe(0);
    expect(records().filter((r) => r.ev === 'not-closed')).toEqual([]);
    expect(first.app).toBe(appAt(0));
  });

  it('検査が自分で止めた本体は、閉じ忘れと数えない', async () => {
    enterTest('A');
    await launchApp();
    exitProcess(appAt(0));
    enterTest('B');
    await launchApp();
    expect(appAt(0).closeCalls).toBe(0);
    expect(records().filter((r) => r.ev === 'not-closed' || r.ev === 'close-failed')).toEqual([]);
  });

  it('ワーカーの最後の検査が閉じなかった本体も、終わりに止めて記録する', async () => {
    enterTest('A');
    await launchApp();
    shared.stopAllAtExit();
    expect(appAt(0).processHandle.killCount).toBe(1);
    const found = records().filter((r) => r.ev === 'not-closed');
    expect(found.map((r) => r['test'])).toEqual(['spec › A']);
    expect(found[0]?.['ownerFailed']).toBe(false);
  });

  it('最後の検査の閉じ忘れは、ワーカーの終わりに Playwright が先に止めていても記録する', async () => {
    enterTest('A');
    await launchApp();
    // 検査が終わると duration が入る。そのあとで止まる。
    (world.info as { duration: number }).duration = 1000;
    exitProcess(appAt(0));
    shared.stopAllAtExit();
    expect(records().filter((r) => r.ev === 'not-closed').map((r) => r['test'])).toEqual(['spec › A']);
  });

  it('最後の検査が自分で本体を止めたなら、閉じ忘れと数えない', async () => {
    enterTest('A');
    await launchApp();
    exitProcess(appAt(0));
    (world.info as { duration: number }).duration = 1000;
    shared.stopAllAtExit();
    expect(records().filter((r) => r.ev === 'not-closed')).toEqual([]);
  });

  it('失敗した検査が閉じられなかった本体は、止めるが閉じ忘れと数えない（失敗で途中で抜けただけ）', async () => {
    enterTest('A');
    await launchApp();
    // Playwright は同じ TestInfo の中身を書き換えて失敗を記録する。
    const info = world.info as { errors: unknown[]; status: string };
    info.errors.push(new Error('検査の失敗'));
    info.status = 'failed';
    shared.stopAllAtExit();
    expect(appAt(0).processHandle.killCount).toBe(1);
    expect(records().filter((r) => r.ev === 'not-closed' && r['ownerFailed'] === false)).toEqual([]);
  });

  it('返却済みで抱えている本体は、終わりに止めるが閉じ忘れと数えない', async () => {
    enterTest('A');
    const a = await launchApp();
    await a.app.close();
    shared.stopAllAtExit();
    expect(appAt(0).processHandle.killCount).toBe(1);
    expect(records().filter((r) => r.ev === 'not-closed')).toEqual([]);
  });
});

describe('指摘 4: 終了の失敗', () => {
  async function heldWithChangedCondition(behavior: FakeApp['closeBehavior']): Promise<void> {
    enterTest('A');
    const a = await launchApp({ extraArgs: ['--x=1'] });
    appAt(0).closeBehavior = behavior;
    await a.app.close();
    expect(appAt(0).closeCalls).toBe(0);
    enterTest('B');
  }

  it('起動し直しで本物の close が失敗してプロセスが残ったら、強制的に止めてから起動し、記録に書き、赤にしない', async () => {
    await heldWithChangedCondition('reject-and-stay');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = launchApp({ extraArgs: ['--x=2'] });
    await vi.advanceTimersByTimeAsync(120_000);
    const b = await pending;
    expect(b.app).toBe(appAt(1));
    expect(world.events).toEqual(['start:1', 'close:1', 'exit:1', 'start:2']);
    const found = records().filter((r) => r.ev === 'close-failed');
    expect(found).toHaveLength(1);
    expect(String(found[0]?.['error'])).toContain('注入した終了の失敗');
    expect(found[0]?.['forced']).toBe(true);
    expect(found[0]?.['exited']).toBe(true);
  });

  it('本物の close が失敗した事実は、プロセスが消えていても記録する', async () => {
    await heldWithChangedCondition('reject');
    await launchApp({ extraArgs: ['--x=2'] });
    const found = records().filter((r) => r.ev === 'close-failed');
    expect(found).toHaveLength(1);
    expect(found[0]?.['forced']).toBe(false);
  });

  it('本物の close が返ってこなくても、時間で打ち切って止めてから起動する', async () => {
    await heldWithChangedCondition('hang');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = launchApp({ extraArgs: ['--x=2'] });
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    expect(world.events).toEqual(['start:1', 'close:1', 'exit:1', 'start:2']);
    expect(records().filter((r) => r.ev === 'close-failed')).toHaveLength(1);
  });

  it('close は成功と返したのにプロセスが残っていたら、それも強制的に止めて記録する', async () => {
    await heldWithChangedCondition('resolve-and-stay');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = launchApp({ extraArgs: ['--x=2'] });
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    const found = records().filter((r) => r.ev === 'close-failed');
    expect(found).toHaveLength(1);
    expect(found[0]?.['forced']).toBe(true);
    expect(found[0]?.['error']).toBeNull();
  });

  it('どうしても止められなければ、同じ userData で次を起動せず、その旨で止まる', async () => {
    await heldWithChangedCondition('reject-and-stay');
    appAt(0).unkillable = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = launchApp({ extraArgs: ['--x=2'] });
    const settled = expect(pending).rejects.toThrow(/止められなかった/);
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;
    expect(world.apps).toHaveLength(1);
    const found = records().filter((r) => r.ev === 'close-failed');
    expect(found).toHaveLength(1);
    expect(found[0]?.['exited']).toBe(false);
  });

  it('検査自身の close（起動し直しになる場合）の失敗は、止めたうえでその検査へ返す', async () => {
    enterTest('A');
    const a = await launchApp();
    appAt(0).mainState.probe['loadCommitCount'] = 1;
    appAt(0).closeBehavior = 'reject-and-stay';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const settled = expect(a.app.close()).rejects.toThrow('注入した終了の失敗');
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;
    expect(appAt(0).processHandle.exitCode).not.toBeNull();
    expect(records().filter((r) => r.ev === 'close-failed')).toHaveLength(1);
  });
});
