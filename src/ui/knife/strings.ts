// U26 — knife-tool UI strings (Japanese; FR-92 / FR-93 / FR-115, NFR 5.7).
//
// All user-facing knife text lives here as a single source so the controller /
// modal select by key and the wording is testable (教訓 5.26 同一文言を UI とテスト
// で共有). The per-phase ガイド文 itself comes from the domain (`knifeGuideText`);
// these are the BUTTON labels / titles / status text the React chrome shows.

import { PIECE_DIRECTION, type PieceDirection } from '../../domain/knife/index';

export const KNIFE_STRINGS = {
  /** 継承先選択モーダル title (FR-93). */
  inheritorTitle: '継承先を選択',
  /** Confirm the chosen継承先 (advance to非継承側プロパティ入力). */
  confirmInheritor: '継承先を確定',
  /**
   * Cancel the whole knife operation.
   * 確定欄（176px）の語は **5 道具とも「やめる」**に揃える（増分 5 の手直し E2。
   * `ui/add/strings.ts` の `ADD_STRINGS.cancel` が先例で、同じ枠の中で語が割れていた）。
   */
  cancel: 'やめる',
  /** 頂点取り消し (FR-78)。語は設計書 §C.4 の［1 つ戻す］に揃える（増分 5 の手直し E2）。 */
  undoVertex: '1 つ戻す',
  /**
   * 分断線の確定（増分 5d でオプションバーの確定欄へ移したときに、直書きだった文言を
   * ここへ引き上げた ―― 画面に出る言葉は 1 か所に集める＝技術方針 5.5 / 教訓 5.19）。
   */
  confirmCut: '分断線を確定',
  /** 確定に時間がかかるあいだ出す文（増分 7 の中身 9）。 */
  committing: '分割しています…',
  /**
   * Grid snap toggle (FR-78)。「スナップ」は要件定義書の条文の語で、画面の第一表記は
   * §H.1 のとおり「吸着」、格子のほうは「グリッド」である（追加の道具の
   * `ADD_STRINGS.gridSnapLabel` が同じ 2 文字を出している）。増分 5 の手直し E2。
   */
  gridSnap: 'グリッド',
  /**
   * 素性入力の局面の「次の一手」（司令塔の決定 (5) / 設計書 §C.4）。
   *
   * **なぜ道具側で言い換えるか**: ドメインの案内文（`KNIFE_GUIDE.EnterProperties` ＝
   * 「新規地物のプロパティを入力してください。」）は **どこで入れるのか**を言っていない。
   * 地図の真ん中に板が出ていたころは目の前にあったので要らなかったが、素性は右パネルの
   * 「新規の姿」で受けるようになったので、**どこを見ればよいか**まで言わないと迷子になる。
   * 追加の道具の `ADD_STRINGS.nextStepPropertyForm`（「名前を入れて［保存］を押してください」）
   * と同じ調子で、行き先の 1 語だけを足した短い形にしてある。
   */
  nextStepEnterProperties: '右のパネルで名前を入れて［保存］を押してください',
  /** Step-back from継承先選択 to分断線入力 (re-draw). */
  backToDrawing: '分断線を引き直す',
  /** ConflictPaused status (FR-62). */
  conflictPaused: '空間競合の解決待ちです。',
  /**
   * 対象欄（240px）の頭に出す段階表示（設計書 §C.4 / バグ狩り #9）。**「手順」の 2 文字を
   * 必ず前に付ける** ―― 「2/4」だけだと「4 件中 2 件」と読み違えられる（§O の B-23）。
   *
   * 分ける道具の段は {@link KNIFE_STEP_COUNT} 個ある。§C.4 の表は「手順 1/3」と例示して
   * いるが、あれは継承先の選択と新しい地物の素性入力を 1 段に数えた見積りで、**実物は
   * 別々の板**である（`KNIFE_PHASE.ChoosingInheritor` と `EnteringProperties`）。画面に
   * 出す数は実物に合わせる ―― 段数が実物と違うと「あと何段あるか」が読めない。
   */
  stage: (step: number): string => `手順 ${String(step)}/${String(KNIFE_STEP_COUNT)}`,
  /**
   * 片の呼び名（V10 / N-09）。「面 1 / 面 2」では、どれが地図のどこの片か分からなかった。
   * **番号札・方角・面積**で呼ぶ ―― 番号は地図の下見と板の下見に描いた札と同じ数字。
   * 面積は素性欄と同じ丸め方（`formatAreaKm2`）で、測れないときは省く。
   */
  pieceLabel: (
    number: number,
    direction: string,
    area: string | null,
  ): string =>
    area === null
      ? `${String(number)}（${direction}）`
      : `${String(number)}（${direction}・${area}）`,
  /**
   * 選んでいる片が何を引き継ぐかを 1 文で言う（V10 ①「どちらが元の素性を引き継ぐか読める」）。
   * 引き継ぐのは地物そのもの（同じ id のまま形だけが変わる）なので、名前・色・年表が残る。
   */
  inheritSentence: (label: string, name: string, others: number): string =>
    `${label} が「${name}」として残り、名前・色・年表を引き継ぎます。ほかの ${String(others)} 片は新しい地物になります。`,
  /** 板の見出しの下に置く、選び方の案内（旧「小さい方を囲って表示しています。」の後継）。 */
  chooseHint:
    '元の地物として残す片を選んでください。小さい方を赤い枠で囲っています。',
  /**
   * 穴・飛び地のある面は n 分割にならず 2 つにまとまる（現状分析 §11-14 / V10 ③④）。
   * **確定の前に**言う ―― 分断線を引いている間の「次の一手」と、継承先の板の両方に出す。
   */
  twoPiecesNote: (reason: string): string =>
    `この面は${reason}を持つので、分断線が境界を何度横切っても 2 つにしか分かれません（同じ側の部分は 1 つの地物にまとまります）。`,
  /**
   * 同じ注記の短い形（「次の一手」用）。帯の欄は 1 行で、長いと末尾が「…」で切れる ――
   * 大事なのは「2 つにしか分かれない」なので、**案内文より前に**置く短い形を別に持つ。
   */
  twoPiecesShort: (reason: string): string =>
    `${reason}があるので 2 つにしか分かれません。`,
  /**
   * 外周が自分に接している 1 多角形の面の呼び名。穴のある面はもう 2 つにまとまらない
   * （増分 8B の手直し / B65）ので、この語が出るのは「くびれで入り江を囲んだ面」だけ。
   * 「穴」と呼ぶのが正確でないことは 8E の文言の総点検で扱う。
   */
  twoPiecesReasonHole: '穴',
  twoPiecesReasonExclave: '飛び地',
  /**
   * 分断線を **延ばした先** でも面が切れたとき（増分 8B の手直し / B65 の残り）。飛び地の
   * ある面などは遠い枠までの延長で切るので、引いていない所の持ち主も変わる。黙って変えない
   * ために、継承先の板と素性欄の両方で **保存の前に** 言う。
   */
  beyondLineNote:
    '分断線を延ばした先でも切れています（引いていない所も別の片になります）。地図の下見で確かめてください。',
  /** 同じことの短い形（素性を入れる段の「次の一手」の先頭に置く）。 */
  beyondLineShort: '分断線を延ばした先でも切れています。',
  /**
   * 素性を入れる段で、この名前が何片に付くか（増分 8B の手直し / 設計適合 2-1）。新しい片が
   * 2 つ以上のときだけ、「次の一手」の先頭に出す ―― 継承先以外の片は 1 つの素性欄を共有して
   * 同じ名前・種別になる。
   */
  sharedNameNote: (newPieces: number): string =>
    `この名前と種別は ${String(newPieces)} 片すべてに付きます。`,
  /** 分断線を閉じたとき（N-10「閉じても画面が何も変わらない」）。 */
  nextStepClosed:
    '分断線を閉じました。［分断線を確定］で囲みの内側と外側に分けます。',
  /**
   * 分断線の点が足りず確定を押せないときの理由（N-10。確定ボタンを無効にした脇＝「次の一手」の
   * **先頭**に出す。帯の欄は 1 行で末尾が切れるので、理由を案内文より前に置く）。
   */
  cutNeedsPoints: (placed: number): string =>
    placed === 0
      ? 'まだ点がありません（確定は 2 点目から）。'
      : 'あと 1 点で確定できます。',
  /**
   * 素性を入れている間に地図を押したとき（N-13「最終段階だけ幕が無い」）。背後の地図は
   * 見えるが、地物を選んだり動かしたりはできない ―― 切りかけの形が変わらないようにする。
   */
  mapLockedWhileNaming:
    '分割を確定するまで地図の地物は触れません。右のパネルで名前を入れて［保存］を押してください',
} as const;

/** 方角の語（`PIECE_DIRECTION` の値 → 画面の語）。 */
export const KNIFE_DIRECTION_LABEL: Readonly<Record<PieceDirection, string>> = {
  [PIECE_DIRECTION.North]: '北',
  [PIECE_DIRECTION.NorthEast]: '北東',
  [PIECE_DIRECTION.East]: '東',
  [PIECE_DIRECTION.SouthEast]: '南東',
  [PIECE_DIRECTION.South]: '南',
  [PIECE_DIRECTION.SouthWest]: '南西',
  [PIECE_DIRECTION.West]: '西',
  [PIECE_DIRECTION.NorthWest]: '北西',
  [PIECE_DIRECTION.Center]: '中央',
};

/**
 * 分ける道具の段数（設計書 §C.4 の「手順 n/m」の m）。
 *
 * 1 = 切る面を選ぶ / 2 = 分断線を引く / 3 = 継承先を選ぶ / 4 = 新しい地物の素性を入れる。
 */
export const KNIFE_STEP_COUNT = 4;

/**
 * The 判断用メッセージ shown when the acquired target stops being a valid split target
 * mid-session (FR-113 個別非表示 / 種別オフ, or a time move to an instant where it is not
 * effective). The knife returns to 対象選択 with the tool still armed — the user did not
 * cancel, the target simply left the visible世界 (W3-AB fix-forward; 教訓 5.12 なぜ進めない
 * かを日本語で伝える).
 */
export const KNIFE_TARGET_GONE_MESSAGE =
  '対象の末端地物が表示されなくなったため、対象選択に戻りました。';

/** The developer-report hint appended to internal-error messages (FR-117). */
export const KNIFE_REPORT_HINT = 'お手数ですが開発者へ報告してください。';

/**
 * Ensure the「開発者へ報告」hint is present exactly once on an internal-error
 * message (FR-115 / FR-117). Mirrors add/conflict so a guarded internal error on
 * the knife save path is surfaced with the SAME guidance, not a raw message.
 */
export function withReportHint(message: string): string {
  return message.includes('開発者へ報告') ? message : `${message}\n${KNIFE_REPORT_HINT}`;
}
