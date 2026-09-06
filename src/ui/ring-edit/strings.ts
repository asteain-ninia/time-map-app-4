// U25 — ring-edit (穴 / 飛び地 の追加・削除) UI strings (FR-22 / FR-24 / FR-92 /
// FR-115, NFR 5.7).
//
// All user-facing ring-edit text lives here as a single source so the controller /
// hook select by key and the copy is testable (教訓 5.19 / 5.26 同一文言を UI とテスト
// で共有). No component embeds a bare literal inline.

export const RING_EDIT_STRINGS = {
  /** Guide: pick the target face whose rings to edit (no face selected yet). */
  guideSelectTarget: '穴 / 飛び地を編集する面をクリックで選択してください。',
  /** Guide while placing the new ring's vertices (add sub-mode, face chosen). */
  guideDrawRing:
    '穴 / 飛び地の頂点をクリックで追加してください（面の内側なら穴、外側なら飛び地。3 点以上で確定できます）。',
  // 「領土リング」は内部語である。画面の第一表記は §H.1 のとおり「外周／穴／飛び地」で、
  // 消せるのは穴と飛び地だけなので、その 2 つを名指しする（増分 5 の手直し E2）。
  /** Guide: pick the face whose ring to delete (delete sub-mode, no face chosen yet). */
  guideSelectDeleteTarget: '穴・飛び地を消す面をクリックで選択してください。',
  /** Guide in the delete sub-mode: click inside a ring to remove it. */
  guideDeleteRing: '消したい穴・飛び地の内側をクリックしてください。',
  /**
   * The target-selection click missed every face (教訓 5.12: 無反応にしない). The
   * production hit-test is 穴透過, so the 面 must be picked on its SOLID fill — a
   * click in a hole void or off the map surfaces this instead of doing nothing.
   */
  faceNotFound: '面が見つかりませんでした。編集する面の塗りつぶし部分をクリックしてください。',
  /** The clicked feature was not an individual leaf face (aggregate / point / line). */
  selectLeafTarget: '末端地物を選択してください。',
  /** Confirm the drafted ring (穴 / 飛び地)。語は設計書 §C.4 の［輪郭を確定］に揃える。 */
  confirmRing: '輪郭を確定',
  /** 頂点取り消し (FR-78)。語は設計書 §C.4 の［1 つ戻す］に揃える（増分 5 の手直し E2）。 */
  undoVertex: '1 つ戻す',
  /**
   * Grid snap toggle (FR-78)。画面の第一表記は §H.1 のとおり「グリッド」
   * （追加の道具の `ADD_STRINGS.gridSnapLabel` が同じ 2 文字を出している）。
   */
  gridSnap: 'グリッド',
  /**
   * Cancel the whole ring-edit operation。確定欄（176px）の語は **5 道具とも「やめる」**に
   * 揃える（増分 5 の手直し E2。`ui/add/strings.ts` の `ADD_STRINGS.cancel` が先例）。
   */
  cancel: 'やめる',
  /**
   * Toggle between add (穴 / 飛び地追加) and delete (穴 / 飛び地削除) sub-modes.
   * 「リング」「モード」はどちらも §H.1 に無い内部語なので、**何が起きるか**をそのまま言う
   * （増分 5 の手直し E2）。
   */
  switchToDelete: '穴・飛び地を消す',
  switchToAdd: '穴・飛び地を足す',
  /**
   * 対象欄（240px）の頭に出す段階表示（設計書 §C.4 / バグ狩り #9）。**「手順」の 2 文字を
   * 必ず前に付ける** ―― 「1/2」だけだと「2 件中 1 件」と読み違えられる（§O の B-23）。
   *
   * 輪郭の道具の段は {@link RING_EDIT_STEP_COUNT} 個（1 = 面を選ぶ / 2 = 輪郭を描く・
   * 消す輪郭を押す）。設計書 §C.4 の「手順 1/2 対象の面: バアカ」と同じ数である。
   */
  stage: (step: number): string => `手順 ${String(step)}/${String(RING_EDIT_STEP_COUNT)}`,
  /**
   * リングの種類の画面表記（設計書 §H.1: 外周／穴／飛び地）。**「領土リング」は内部語**
   * なので出さない。消す前の確認（増分 7 の中身 7）で使う。
   */
  ringKindHole: '穴',
  ringKindTerritory: '外周・飛び地',
} as const;

/** 輪郭の道具の段数（設計書 §C.4 の「手順 n/m」の m）。1 = 面を選ぶ / 2 = 輪郭を描く。 */
export const RING_EDIT_STEP_COUNT = 2;

export type RingEditStringKey = keyof typeof RING_EDIT_STRINGS;

/**
 * Map a domain {@link RingRejectKind} to a user-facing Japanese message (教訓 5.12 /
 * 5.26). Every reject reason the add / delete commands can return is covered so a
 * refusal always surfaces an honest reason rather than a raw enum (FR-115).
 */
export const RING_REJECT_MESSAGES = {
  'too-few-vertices': 'リングには 3 点以上の頂点が必要です。',
  'no-enclosing-territory': '穴を作成できる領土が見つかりませんでした。領土の内側をクリックしてください。',
  'hierarchy-invalid': 'リングの階層構造が不正になるため、この形状は確定できません。',
  'target-not-found': '対象のリングが見つかりませんでした。',
  // N-51 / 技術方針 §6.8。リング編集は利用者が頂点を打つ道具なので、追加の道具と同じ
  // 「途中に点を打つ」という次の手をそのまま案内できる (文言も追加と同趣旨で揃える)。
  'long-edge':
    'この辺は世界を半周以上します。途中に点を打ってください（1 辺で経度 180 度以上は保存できません）。',
  // 増分 3 の手直し 2 回目: 緯度 ±90 度の外（北極の上・南極の下）には場所が無い。
  // 追加の道具と同じ趣旨の文にする（画面の言い方を道具ごとに割らない）。
  'outside-world':
    'そこは世界の外です（北緯 90 度より上・南緯 90 度より下には置けません）。地図の中を押してください。',
  // 増分 3 の手直し 2 回目: 確定の関門（U24）が断ったときの理由。これまでは黙って
  // 下書きを捨てていたので、利用者から見ると「確定を押しても何も起きない」だった。
  'confirm-long-drag':
    'この形は世界を半周以上する辺を作ります。頂点をもっと近くに置いてください（1 辺で経度 180 度以上は保存できません）。',
  'confirm-outside-world':
    'そこは世界の外です（北緯 90 度より上・南緯 90 度より下には置けません）。地図の中へ動かしてください。',
} as const;
