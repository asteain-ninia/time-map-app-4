// FR-107 終了確認ガードの CLOSE ブリッジ（main 側の判断ロジック）.
//
// これまで `createWindow` には `window.on('close')` が無く、× / Alt+F4 / タスクバー /
// OS シャットダウンは **未保存確認を一切通さずに** ウィンドウを閉じていた（残 HIGH
// リスク）。レンダラ側の 3 択ガード（unsaved-guard.ts / quitGuard）は実装・結線済みで、
// 欠けていたのは「main の close を止めて、そのガードを起動し、許可された時だけ閉じる」
// ブリッジだけだった。この単位はその状態機械を Electron 抜きで持つ（開発ガイド §5.41 —
// main のロジックは Electron-free に置き、合成ルートだけが実物を束縛する）。
//
// 契約（STATE.md 2026-07-02 の教訓「配線時 false=閉じない契約厳守」）:
//   close 到来 → preventDefault → レンダラへ照会 → **true が返った時だけ** 再 close。
//   拒否・無応答・不正応答は **閉じない**（fail-closed）。
//
// ─────────────────────────────────────────────────────────────────────────────
// ADR: 「購読者が生きているか」を片方向ラッチではなく **即時 ACK** で判定する
// ─────────────────────────────────────────────────────────────────────────────
// 旧実装は「did-finish-load でしか true に戻らない片方向 rendererLoaded ラッチ」で
// 購読者の生存を推定していた。これは 3 つの実機バグを生んだ（敵対レビュー・全て probe 実証）:
//   [所見1 HIGH fail-OPEN] ナビゲーションが開始したが commit せず終わると（stop() /
//     ダウンロード化 / did-fail-load / ERR_ABORTED）、元 document（App+未保存編集）は
//     生きているのに rendererLoaded が恒久 false → close が毎回「確認省略」で閉じる。
//   [所見2 逆方向] did-finish-load は出たが購読者が居ない（別 document commit / App root
//     アンマウント / 購読レース）と照会が虚空へ → asking 中の再×は握り潰し → ×が恒久無効。
//   [所見3] タイムアウトで届いた判定を無言破棄 → ユーザーの選択が消える + ラッチ孤児化。
//
// 根治の設計（受領 ACK と判定の分離）:
//   (1) main は close を preventDefault し、レンダラへ CloseRequest(requestId) を送る。
//   (2) preload は CloseRequest 受信時点で **即座に ACK を返す**（判定より前・同期的）。
//       ACK は購読ラッパの中で送るので、ACK が返る = 「生きた購読者が実在する」の証。
//   (3) main は短い **ACK タイムアウト**（既定 2 秒）で「ACK が返らない」状態を検出する:
//         - ACK あり → 購読者実在。以後ラッチには依存せず、判定を待つ。中断ナビゲーション後も
//           元 document の購読者が ACK を返すので **誤って fail-open しない**（所見1 根治）。
//         - ACK なし → 「購読者不在」か「生きているが JS が ackTimeout 超ブロック（フリーズ）」
//           かは **区別できない**。旧実装はこれを購読者不在とみなし確認を省略して閉じたが、
//           巨大 checkConsistency 等でフリーズした（未保存が実在する）レンダラを黙って閉じる
//           のは fail-closed 契約の破れだった（所見1 HIGH・最終レビュー）。根治後は **自動では
//           閉じず**、main の **ネイティブダイアログ**（Electron dialog.showMessageBox、レンダラ
//           不要・既定=[キャンセル]）でユーザーに明示確認する。遅れて本物の ACK が届けば通常
//           フローへ復帰し、ダイアログの後着選択は requestId 世代で失効させて無視する。
//   (4) ACK 後の判定には **恣意的な破棄タイムアウトを置かない**。ユーザーがダイアログの前で
//       何分悩んでも、遅れて届いた応答は必ず有効（所見3 根治）。ハングして永遠に応答しない
//       レンダラは、代わりに「レンダラ死」の購読で settle する:
//         - did-start-loading（document 破棄開始 / 再読み込み）→ 照会を中止して idle へ戻す。
//           **自動では閉じない**（中断ナビゲーションで fail-open しないため）。次の × で再照会。
//         - render-process-gone（クラッシュ）→ 未保存データはプロセスごと失われているので
//           確認を省略して閉じる（ダイアログのまま window が固まるのを防ぐ）。
//
// 非対称の原則（脱出口の設計思想は不変）: 閉じない側の失敗は「閉じられず困る（復旧可能）」、
// 閉じる側の失敗は「編集内容が消える（復旧不能）」。安全側は常に「閉じない」。ただし所見1〜3
// はいずれも「守るものが無い状態で閉じない/ 守るものがあるのに閉じる」の取り違えだったので、
// ACK で「守るものがあるか（購読者が生きているか）」を正しく判定してから倒す。
//
// 既知の残リスク（実装レビュー時に記録・ADR）:
//   - [フリーズ] JS スレッドが ackTimeout 以上ブロックした「生きているが応答不能」なレンダラは
//     ACK を返せない。所見1 根治後はこれを黙って閉じず、ネイティブ確認ダイアログでユーザーに
//     委ねる（既定=[キャンセル]=閉じない）。ダイアログ表示中にレンダラが回復して ACK を返せば
//     通常の 3 択へ復帰し、ダイアログの後着選択は requestId 世代で失効させて無視する。残る穴は
//     「フリーズしたまま回復せず、ユーザーが終了を選ぶ」ケースだが、それは情報を与えた上での
//     明示選択なので黙ってのデータ損失ではない（ネイティブダイアログにアプリ内の未保存状態を
//     詳細表示できないという正直な限界は残る）。ACK は判定の実行より前に同期送出されるので、
//     通常の重い描画では ackTimeout 以内に必ず返る（真にフリーズした時だけダイアログが出る）。
//   - [LOW-1 多重ウィンドウの quit 畳み込み] quitRequested はハブ単位の 1 フラグ。現 app は
//     単一ウィンドウなので実害なし。複数ウィンドウを常用するなら「どの window の close が
//     quit 由来か」をウィンドウ単位に持つ必要がある（既知制限）。
//   - [LOW-3 quit 再発行経路の実機未検証] app.quit() 由来 close の許可 →app.quit() 再発行は
//     単体テストで固定しているが E2E 未実測（Playwright の electronApp.close() は E2E_TEST の
//     forceAllow に倒すため、× 経路のみ E2E 化している）。既知ギャップ。

/** close イベントに対する判断（値で分岐する語彙、教訓 5.19）。 */
export const CLOSE_DECISION = {
  /** 閉じてよい（preventDefault しない）。 */
  Allow: 'allow',
  /** 閉じない（preventDefault する）。 */
  Block: 'block',
} as const;

export type CloseDecision = (typeof CLOSE_DECISION)[keyof typeof CLOSE_DECISION];

/**
 * 「ACK が返らない」ことを検出する ACK 待ちの既定上限（2 秒）。**ユーザーが悩む時間では
 * ない** — preload は判定の実行より前に同期で ACK を送るので、生きて応答できる購読者は
 * この内に必ず返す。これを超えて ACK が無いなら「購読者不在」か「フリーズ」— 区別できない
 * ので自動では閉じず、ネイティブ確認ダイアログで明示確認する（所見1 HIGH 根治）。
 */
export const CLOSE_GUARD_ACK_TIMEOUT_MS = 2_000;

/** ログ文言（診断ログに出る単一の真実源）。 */
export const CLOSE_GUARD_LOG = {
  requested: '[close-guard] 終了要求: レンダラへ未保存確認を照会します',
  acked: '[close-guard] 未保存確認の購読者を確認しました（判定を待ちます）',
  duplicate: '[close-guard] 終了要求が重複したため無視しました（未保存確認の応答待ち）',
  allowed: '[close-guard] 未保存確認が許可されたため閉じます',
  blocked: '[close-guard] 未保存確認が中止を選んだため閉じません',
  // 所見1 HIGH: ACK が来ない = 「購読者不在」か「生きているが応答不能（フリーズ）」かは
  // 区別できない。自動では閉じず、ネイティブ確認ダイアログを提示する。
  unresponsivePrompting:
    '[close-guard] レンダラが応答しない（ACK なし）ため終了確認ダイアログを提示します',
  unresponsiveQuit: '[close-guard] 応答なしの確認でユーザーが終了を選んだため閉じます',
  unresponsiveCancelled:
    '[close-guard] 応答なしの終了確認がキャンセルされたため閉じません（次の操作で再照会します）',
  unresponsiveStale:
    '[close-guard] 応答なし確認ダイアログの後着選択を無視しました（ACK 到着 / 状態変化で失効）',
  rendererReloading:
    '[close-guard] 照会中にレンダラが再読み込みを開始したため確認を中止しました（次の操作で再照会します）',
  staleVerdict: '[close-guard] 失効した終了確認の応答を無視しました',
  invalidVerdict: '[close-guard] 不正な形式の終了確認の応答を無視しました',
  rendererGone: '[close-guard] レンダラが応答不能のため未保存確認を省略して閉じます',
  // 所見3: 要求を発行した webContents 以外からの応答（sender 不一致）。単一ウィンドウの
  // 現 app では防御的措置（別 webContents が要求 ID を詐称するのを弾く）。
  senderMismatch:
    '[close-guard] 要求元と異なる webContents からの応答を無視しました（sender 不一致）',
  forceAllowed: '[close-guard] 終了確認を強制的に省略します: ',
} as const;

/** タイマーハンドル（Node の Timeout / テストの数値、どちらも受ける）。 */
export type CloseGuardTimer = unknown;

/** 合成ルートが束縛する環境（時計・ID・ログ）。 */
export interface CloseGuardEnv {
  /** 要求 ID の生成（本番は randomUUID）。応答の照合に使う。 */
  readonly newRequestId: () => string;
  readonly setTimer: (fn: () => void, ms: number) => CloseGuardTimer;
  readonly clearTimer: (timer: CloseGuardTimer) => void;
  /** 診断ログ 1 行（本番は console + FR-117 ローカルログ）。 */
  readonly log: (message: string) => void;
  /** 購読者不在を検出する ACK 待ちの上限。既定 {@link CLOSE_GUARD_ACK_TIMEOUT_MS}。 */
  readonly ackTimeoutMs?: number;
}

/** 1 ウィンドウ分の実物（BrowserWindow / webContents / app）への継ぎ目。 */
export interface CloseGuardWindowPorts {
  /** レンダラへ未保存確認を依頼する（webContents.send）。 */
  readonly requestGuard: (requestId: string) => void;
  /** 実際に閉じる（window.close()）。許可された時だけ呼ばれる。 */
  readonly closeWindow: () => void;
  /** アプリごと終了する（app.quit()）。quit 由来の close を許可した時だけ。 */
  readonly quitApp: () => void;
  /**
   * レンダラの **物理的な** 生存（webContents 生存 & 非クラッシュ & window 未破棄）。
   * 「購読者が生きているか」はここでは見ない（それは ACK で判定する — 所見1 の片方向
   * ラッチ根治）。破棄済み / クラッシュ済みなら照会しても無駄なので即 allow する用。
   */
  readonly rendererReachable: () => boolean;
  /**
   * この window の webContents.id（所見3 event.sender 検証）。ハブは要求を送った先の
   * id を控え、ACK / 判定がこの id の webContents から来たものだけ受理する（別 webContents
   * が要求 ID を詐称して他ウィンドウの close を許可 / 阻害するのを防ぐ・単一ウィンドウの現
   * app では防御的措置）。
   */
  readonly senderId: () => number;
  /**
   * ACK タイムアウト時（レンダラがフリーズ or 購読者不在で ACK が返らない）にユーザーへ
   * 出す **ネイティブ確認ダイアログ**（Electron dialog.showMessageBox、レンダラ不要）。
   * 解決値: true = ユーザーが「終了する」を明示選択 / false = キャンセル・棄却・表示失敗。
   * fail-closed のため既定ボタンは「キャンセル」（false）。E2E / SMOKE ではハーネスを
   * 無限ブロックするので合成ルートが即 true（従来の allowWithoutRenderer 相当）に束縛する
   * （src/shell/main/index.ts。理由はそこにコメント）。
   */
  readonly confirmUnresponsiveClose: () => Promise<boolean>;
}

/** ウィンドウ 1 枚に貼り付くガード。 */
export interface WindowCloseGuard {
  /** `window.on('close')` から呼ぶ。Block なら呼び出し側が preventDefault する。 */
  readonly onCloseAttempt: () => CloseDecision;
  /**
   * `webContents.on('did-start-loading')` から呼ぶ。照会中（ACK 待ち / 判定待ち / 応答なし
   * ダイアログ提示中）に document 破棄が始まったら、その照会は虚空へ行くので **中止して
   * idle に戻す**（自動では閉じない = 中断ナビゲーションで fail-open しない）。次の × で再照会。
   */
  readonly noteRendererReloading: () => void;
  /**
   * `webContents.on('render-process-gone')` から呼ぶ。照会中（ACK 待ち / 判定待ち / 応答なし
   * ダイアログ提示中）にレンダラが落ちたら、未保存データはプロセスごと失われているので確認を
   * 省略して閉じる（ダイアログのまま window が固まらない）。照会中でなければ無視（通常操作中の
   * クラッシュで勝手に閉じない）。
   */
  readonly noteRendererGone: () => void;
  /** ウィンドウ破棄時（'closed'）に呼ぶ。保留中の要求とタイマーを畳む。 */
  readonly dispose: () => void;
}

/**
 * 全ウィンドウ分の close ガードを束ねるハブ。IPC 受け口（`ipcMain.handle`）は
 * **アプリで 1 回** しか登録できないので、応答の振り分けはここが持つ（ウィンドウ再作成
 * や dev リロードでハンドラが多重登録されない — 要求 ID で正しいガードへ配る）。
 */
export interface CloseGuardHub {
  /** ウィンドウ 1 枚にガードを貼る（createWindow から）。 */
  readonly attach: (ports: CloseGuardWindowPorts) => WindowCloseGuard;
  /**
   * レンダラからの **受領 ACK**（未検証の生 payload）。CloseRequest を受けた購読者が
   * 判定より前に返すので、これが届く = 生きた購読者が実在する（所見1/2 の判定核心）。
   * `senderId` は応答を送った webContents.id（所見3 検証用）。合成ルートは必ず
   * event.sender.id を渡す。省略時（純ロジックテスト）は sender 検証を行わない。
   */
  readonly acceptAck: (payload: unknown, senderId?: number) => void;
  /**
   * レンダラからの判定（未検証の生 payload）。不正・失効・sender 不一致は無視する。
   * `senderId` は所見3 検証用（{@link acceptAck} と同じ規約）。
   */
  readonly acceptVerdict: (payload: unknown, senderId?: number) => void;
  /** `app.on('before-quit')`: この close は「アプリ終了」由来だと記録する。 */
  readonly noteQuitRequested: () => void;
  /**
   * 以後の close を無条件に素通しする（**閉じはしない**、素通しにするだけ）。
   * 本番経路の呼び出し元は無い。E2E ハーネス（Playwright の app.close() は
   * `app.quit()` を評価する）の後始末専用の脱出口で、合成ルートが E2E_TEST の時だけ
   * 束縛する。これが無いと、未保存状態で終わる既存 spec の teardown がガードに
   * 阻まれて固まる（テスト基盤の都合であって、製品挙動は変えない）。
   */
  readonly forceAllow: (reason: string) => void;
}

/** レンダラ→main の判定 payload（信用しないので実行時に検証する）。 */
interface ParsedVerdict {
  readonly requestId: string;
  readonly allow: boolean;
}

function parseVerdict(payload: unknown): ParsedVerdict | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { requestId, allow } = payload as { requestId?: unknown; allow?: unknown };
  if (typeof requestId !== 'string' || requestId === '') return null;
  if (typeof allow !== 'boolean') return null;
  return { requestId, allow };
}

/** ACK payload（{ requestId }）の検証。判定と違い allow は持たない。 */
function parseRequestId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { requestId } = payload as { requestId?: unknown };
  return typeof requestId === 'string' && requestId !== '' ? requestId : null;
}

/**
 * ガード 1 個の状態:
 *   idle        — 平常。× 待ち。
 *   awaitingAck — CloseRequest を送って **受領 ACK** を待っている（ACK タイムアウト armed）。
 *   asking      — ACK を受けた（購読者実在）。**判定** を待っている（破棄タイムアウトは無い）。
 *   unresponsive— ACK タイムアウトした（購読者不在 or フリーズ）。**ネイティブ確認ダイアログ**
 *                 提示中。pending は保持し、遅れて本物の ACK が届けば asking へ復帰する
 *                 （ダイアログの後着選択は requestId 世代で失効・無視 — 所見1）。
 *   allowed     — 許可済み。one-shot で再 close 中（再入した close は素通し）。
 */
type GuardPhase = 'idle' | 'awaitingAck' | 'asking' | 'unresponsive' | 'allowed';

/** 応答待ちの 1 要求分の決着口（ハブが requestId で引く）。 */
interface PendingEntry {
  /** 受領 ACK を受けた（awaitingAck / unresponsive → asking、ACK タイマー解除）。 */
  readonly ack: () => void;
  /** 判定を受けた（許可なら閉じ、拒否なら idle へ）。 */
  readonly settle: (allow: boolean) => void;
  /** この要求を送った webContents.id（所見3: 応答の sender 検証）。 */
  readonly senderId: number;
}

export function createCloseGuardHub(env: CloseGuardEnv): CloseGuardHub {
  const ackTimeoutMs = env.ackTimeoutMs ?? CLOSE_GUARD_ACK_TIMEOUT_MS;
  /** 応答待ちの要求 ID → その決着口。ウィンドウをまたいで一意。 */
  const pending = new Map<string, PendingEntry>();
  /** 貼り付け済みガードの解放口（forceAllow 用）。 */
  const released = new Set<() => void>();
  /** 直近の close が `app.quit()` 由来か（before-quit で立つ）。 */
  let quitRequested = false;

  const attach = (ports: CloseGuardWindowPorts): WindowCloseGuard => {
    let phase: GuardPhase = 'idle';
    let requestId: string | null = null;
    /** ACK 待ちのタイムアウト（asking へ移ったら解除する）。 */
    let ackTimer: CloseGuardTimer = null;

    /** 保留中の要求（マップ登録と ACK タイマー）を畳む。状態遷移は呼び出し側が決める。 */
    const clearPending = (): void => {
      if (requestId !== null) {
        pending.delete(requestId);
        requestId = null;
      }
      if (ackTimer !== null) {
        env.clearTimer(ackTimer);
        ackTimer = null;
      }
    };

    /** 許可された close を実際に発行する（quit 由来なら app.quit を再発行）。 */
    const completeClose = (): void => {
      if (quitRequested) {
        quitRequested = false;
        ports.quitApp();
        return;
      }
      ports.closeWindow();
    };

    /** 受領 ACK: 生きた購読者を確認した。判定待ちへ移り、ACK タイマーを解除する。 */
    const onAck = (): void => {
      // awaitingAck からの通常経路、または unresponsive（ACK タイムアウトで確認ダイアログを
      // 提示している最中）に遅れて本物の ACK が届いた経路。どちらも「生きた購読者が居る」証
      // なので判定待ち（asking）へ移る。unresponsive の場合、後で解決するネイティブダイアログの
      // 選択は世代不一致で無視される（onUnresponsiveDecision の requestId チェック）。
      if (phase !== 'awaitingAck' && phase !== 'unresponsive') return;
      if (ackTimer !== null) {
        env.clearTimer(ackTimer);
        ackTimer = null;
      }
      phase = 'asking';
      env.log(CLOSE_GUARD_LOG.acked);
    };

    const settle = (allow: boolean): void => {
      clearPending();
      if (!allow) {
        // 拒否: 閉じない。quit 由来フラグも畳む（この終了要求は中止された。残すと
        // 後続の × が「アプリ終了」として扱われてしまう）。
        phase = 'idle';
        quitRequested = false;
        env.log(CLOSE_GUARD_LOG.blocked);
        return;
      }
      // 許可: one-shot ラッチを立ててから再 close する。再入した close は Allow で
      // 素通しするので、ここでループしない。
      phase = 'allowed';
      env.log(CLOSE_GUARD_LOG.allowed);
      completeClose();
    };

    /**
     * 応答なしダイアログの決着（true=終了する / false=キャンセル・棄却）。二重決定の競合を
     * requestId 世代で一貫させる（所見1 の規律）: ダイアログ表示中に本物の ACK が届いて asking
     * へ移った / 再読み込みで idle に戻った / 既に別要求へ進んだ場合、このダイアログの後着選択は
     * 失効として無視する（ACK 到着後の verdict を優先）。
     */
    const onUnresponsiveDecision = (dialogRequestId: string | null, quit: boolean): void => {
      if (phase !== 'unresponsive' || requestId !== dialogRequestId) {
        env.log(CLOSE_GUARD_LOG.unresponsiveStale);
        return;
      }
      if (!quit) {
        // キャンセル / 棄却 / 表示失敗 → 閉じない・idle へ。次の × で再照会（遅れて復帰した
        // レンダラなら普通の 3 択が出る）。quit 由来フラグも畳む（中止された終了要求を残さない）。
        clearPending();
        phase = 'idle';
        quitRequested = false;
        env.log(CLOSE_GUARD_LOG.unresponsiveCancelled);
        return;
      }
      // 「終了する」明示選択 → 閉じる（quit 由来なら app.quit を再発行）。
      clearPending();
      phase = 'allowed';
      env.log(CLOSE_GUARD_LOG.unresponsiveQuit);
      completeClose();
    };

    /**
     * ACK が来ない = 「購読者不在」か「フリーズ（生きているが応答不能）」か区別できない
     * （所見1 HIGH）。旧実装はここで確認を省略して閉じたが、それはフリーズした未保存レンダラを
     * 黙って閉じる fail-closed 契約の破れだった。根治後は **自動では閉じず**、レンダラ不要の
     * ネイティブ確認ダイアログでユーザーへ委ねる。pending は畳まない: 遅れて本物の ACK が届けば
     * onAck が asking へ復帰させ、ダイアログの後着選択は世代で失効する。
     */
    const onAckTimeout = (): void => {
      ackTimer = null;
      phase = 'unresponsive';
      env.log(CLOSE_GUARD_LOG.unresponsivePrompting);
      const dialogRequestId = requestId;
      void (async (): Promise<void> => {
        let quit = false;
        try {
          quit = (await ports.confirmUnresponsiveClose()) === true;
        } catch {
          // ダイアログ表示自体が失敗/棄却 = 閉じない（安全側）。真に破棄されていれば
          // render-process-gone / did-start-loading 側の購読が settle する。
          quit = false;
        }
        onUnresponsiveDecision(dialogRequestId, quit);
      })();
    };

    /** レンダラが答えられない時の「閉じる」分岐（データ損失方向ではない）。 */
    const allowWithoutRenderer = (): CloseDecision => {
      clearPending();
      phase = 'allowed';
      env.log(CLOSE_GUARD_LOG.rendererGone);
      return CLOSE_DECISION.Allow;
    };

    /** 強制許可（E2E teardown）: 保留を畳んで以後の close を素通しにする。 */
    const release = (): void => {
      clearPending();
      phase = 'allowed';
    };
    released.add(release);

    const guard: WindowCloseGuard = {
      onCloseAttempt: () => {
        // 許可済み（自分で再発行した close、または強制許可）。
        if (phase === 'allowed') return CLOSE_DECISION.Allow;
        // 照会中（ACK 待ち / 判定待ち / 応答なしダイアログ提示中）の再 × は握りつぶす:
        // 2 通目の IPC を送らない（レンダラ側で未保存ダイアログが二重に開き、最初の
        // resolver が孤児化するのを防ぐ。応答なしダイアログの二重提示も防ぐ）。
        if (phase === 'awaitingAck' || phase === 'asking' || phase === 'unresponsive') {
          env.log(CLOSE_GUARD_LOG.duplicate);
          return CLOSE_DECISION.Block;
        }
        // 物理的に到達不能（破棄済み / クラッシュ済み）なら照会しても無駄 = 即 allow。
        if (!ports.rendererReachable()) return allowWithoutRenderer();

        phase = 'awaitingAck';
        const id = env.newRequestId();
        requestId = id;
        pending.set(id, { ack: onAck, settle, senderId: ports.senderId() });
        ackTimer = env.setTimer(onAckTimeout, ackTimeoutMs);
        try {
          ports.requestGuard(id);
        } catch {
          // 送信自体が失敗した（webContents が照会の直前に消えた等）= 到達不能と同じ。
          return allowWithoutRenderer();
        }
        env.log(CLOSE_GUARD_LOG.requested);
        return CLOSE_DECISION.Block;
      },
      noteRendererReloading: () => {
        // 照会中に document 破棄が始まった: 相手が消えるので照会を中止して idle へ。
        // **自動では閉じない**（中断ナビゲーションでも fail-open しない — 所見1 の核心）。
        // 応答なしダイアログ提示中(unresponsive)でも同様に中止（後着選択は世代で失効）。
        if (phase !== 'awaitingAck' && phase !== 'asking' && phase !== 'unresponsive') return;
        clearPending();
        phase = 'idle';
        quitRequested = false;
        env.log(CLOSE_GUARD_LOG.rendererReloading);
      },
      noteRendererGone: () => {
        // 照会中にクラッシュ: 未保存データはプロセスごと失われた = 確認を省略して閉じる。
        // 応答なしダイアログ提示中(unresponsive)でも同様（後着選択は世代で失効）。
        if (phase !== 'awaitingAck' && phase !== 'asking' && phase !== 'unresponsive') return;
        clearPending();
        phase = 'allowed';
        env.log(CLOSE_GUARD_LOG.rendererGone);
        completeClose();
      },
      dispose: () => {
        clearPending();
        phase = 'idle';
        released.delete(release);
      },
    };

    return guard;
  };

  /** 応答（ACK / 判定）が要求を発行した webContents から来たか検証する（所見3）。 */
  const senderMatches = (entry: PendingEntry, senderId: number | undefined): boolean => {
    // senderId 省略時（純ロジックテスト）は検証しない。合成ルートは必ず event.sender.id を渡す。
    if (senderId === undefined) return true;
    if (entry.senderId === senderId) return true;
    env.log(CLOSE_GUARD_LOG.senderMismatch);
    return false;
  };

  return {
    attach,
    acceptAck: (payload, senderId) => {
      const id = parseRequestId(payload);
      if (id === null) {
        env.log(CLOSE_GUARD_LOG.invalidVerdict);
        return;
      }
      const entry = pending.get(id);
      if (entry === undefined) {
        // ACK タイムアウト後に遅れて届いた（ただし unresponsive 中は pending を保持するので
        // 通常は届く）/ 既に畳まれた / 偽造 ID。
        env.log(CLOSE_GUARD_LOG.staleVerdict);
        return;
      }
      if (!senderMatches(entry, senderId)) return;
      entry.ack();
    },
    acceptVerdict: (payload, senderId) => {
      const verdict = parseVerdict(payload);
      if (verdict === null) {
        env.log(CLOSE_GUARD_LOG.invalidVerdict);
        return;
      }
      const entry = pending.get(verdict.requestId);
      if (entry === undefined) {
        // 既に畳まれたウィンドウ宛 / 偽造 ID（破棄タイムアウトは無いので通常は起きない）。
        env.log(CLOSE_GUARD_LOG.staleVerdict);
        return;
      }
      if (!senderMatches(entry, senderId)) return;
      entry.settle(verdict.allow);
    },
    noteQuitRequested: () => {
      quitRequested = true;
    },
    forceAllow: (reason) => {
      env.log(`${CLOSE_GUARD_LOG.forceAllowed}${reason}`);
      for (const release of released) release();
    },
  };
}
