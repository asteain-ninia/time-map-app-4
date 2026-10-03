// Survey-mode Japanese UI text (U37, FR-115 / FR-117, 技術方針 5.5).
//
// All user-visible survey text lives here as plain constants (no i18n
// abstraction, per the shell's policy). The shell (U20) references these by key;
// no component hardcodes a literal inline (教訓 5.19).

/** Survey mode + control labels. */
export const SURVEY_STRINGS = {
  /**
   * 左レールに並ぶ「測る」ボタンの文字（設計書 §C.3。増分 5 の手直し C3 / E1）。
   *
   * **「測量モード」ではない。** 画面からモードの語は無くなった（鍵と道具の 1 段に
   * なった）ので、モードを名乗るのはもう嘘である。ほかの 11 個の道具と同じ「絵文字 ＋
   * 動詞」の形に揃える。
   */
  modeLabel: '📏 測る',
  /**
   * オプションバーの道具名の区画（112px）に出す名前。レールと同じ語にする ――
   * 押したボタンと帯の名前が違うと、いま何を持っているのかが分からない（§C.4）。
   */
  toolName: '📏 測る',
  /** 確定欄（176px）の［測量を終える］（設計書 §C.4 の「確定」の列）。 */
  finishLabel: '測量を終える',
  /** 対象欄に出す「まだ 1 点も押していない」。 */
  targetNone: '（まだ測っていません）',
  /** 対象欄に出す「始点だけ押した」。 */
  targetStartOnly: '始点だけ指定',
  /** 対象欄に出す確定した線の本数。 */
  targetLines: (n: number): string => `測った線 ${String(n)} 本`,
  /**
   * 次の一手（測量を始めた直後）。
   *
   * **後半の「測っている間は地物を選べません」**（増分 8C / N-54 / 設計書 §C.4 の測るの行）。
   * 測っているあいだ地図の左クリックは測量が受け取るので、地物を押しても選べない ――
   * それが画面のどこにも書かれていなかった（現状分析 N-54）。
   */
  nextStepIdle: '地図で 2 点を押すと距離が出ます。測っている間は地物を選べません。',
  /**
   * 右クリックで当たった測量の線が **1 本だけ**のときの項目（増分 8C / 設計書 §E.1 V15）。
   * 消えるのは正距円筒の線と大円の線の 2 本セット。
   */
  removeThisLine: 'この線を消す',
  /**
   * 当たった線が **2 本以上**（交差・重なり）のときの項目。測量ごとに 1 項目ずつ並べ、
   * どの線かを大円の距離で言い分ける（「1,234km の線を消す」。設計書 §E.1 V15 の 3）。
   */
  removeLineOfKm: (km: string): string => `${km} の線を消す`,
  /**
   * 距離の文が **ほかの候補と同じになったとき** だけ添える端点（増分 8C の手直し / GPT #1）。
   * 「1,234km の線を消す（北緯 10.0° 東経 20.0° → 北緯 10.0° 東経 40.0°）」。
   */
  removeLineOfKmWithEnds: (km: string, ends: string): string => `${km} の線を消す（${ends}）`,
  /** 端点まで同じ線（同じ 2 点を 2 回測った）に添える、測った順。 */
  endsWithOrder: (ends: string, order: number): string => `${ends}・測った順で ${String(order)} 本目`,
  /** 右クリックで線を消したあとの状態行（増分 8C の手直し / 反証 #2）。［戻す］を添える。 */
  lineRemoved: '測量の線を消しました',
  /** 状態行の［戻す］ボタンの文字。 */
  restoreLineAction: '戻す',
  /** ［戻す］・消した直後の Ctrl+Z で線を戻したあとの状態行。 */
  lineRestored: '測量の線を戻しました',
  /**
   * 読み取りの色見本に添える説明（増分 8C / N-52）。見本は地図の線と同じ色・同じ線種で、
   * 正距円筒は実線、大円は破線。画面に出すのは見本の `title`（指を載せると読める）。
   */
  legendEquirectangular: '地図の上のまっすぐな線（実線）',
  legendGreatCircle: '地球の上の最短の道すじ（破線）',
  /** The clear-all button label (FR-15). */
  clearLabel: '測量結果をクリア',
  /** Panel heading for the measurement readout. */
  panelTitle: '測量',
  /** Equirectangular distance row label (FR-14). */
  equirectangularLabel: '正距円筒距離',
  /** Great-circle distance row label (FR-14). */
  greatCircleLabel: '大円距離',
  /**
   * オプションバーの 40px の帯に出す **短い**距離のラベル（増分 5a / 設計書 §C.4 の例
   * 「正距円筒 1,234km ／ 大円 1,201km」）。長いほうは、帯ではなく文書・報告の中で
   * 「どちらの距離か」を言うときのために残してある。
   */
  equirectangularShort: '正距円筒',
  greatCircleShort: '大円',
  /** 「座標 ▾」ポップオーバーのアンカーの文字（▾ は器が付ける）。 */
  coordsMenuLabel: '座標',
  /** Distance unit suffix. */
  unitKm: 'km',
  /** Start-point lat/lon section label (FR-16). */
  startPointLabel: '始点',
  /** End-point lat/lon section label (FR-16). */
  endPointLabel: '終点',
  /** Guidance shown when idle (no start point yet). */
  guideIdle: '地図上をクリックして測量の始点を指定してください。',
  /**
   * 始点だけ押したあとの「次の一手」。
   *
   * **「キャンセル」とは言わない**（増分 5 の手直し 2 回目 / Grok N6）。確定欄と 5 道具の
   * 案内は全部「やめる」に揃えたのに、ここだけ「（Escでキャンセル）」が残っていた ――
   * 同じ働きに 2 つの名前があると、どちらが何なのかを利用者が覚え直すことになる
   * （§H.1 の用語集に「キャンセル」は無い）。打鍵の案内も設計書 §C.4 の測るの行に
   * 揃えた言い方にする。
   */
  guideAwaitingEnd: 'もう一度クリックして終点を指定してください（Esc で測るのをやめます）。',
  /** Shown for an internal inconsistency (FR-117). */
  internalError: '内部エラーが発生しました。開発者へ報告してください。',
  /** Coordinate display-format group label (FR-16 切替, U37). */
  formatLabel: '座標表示',
  /** Format switch: show BOTH 度分秒 and 十進 (the FR-16 default). */
  formatBoth: '両方',
  /** Format switch: 度分秒 only. */
  formatDms: '度分秒',
  /** Format switch: 十進 only. */
  formatDecimal: '十進',
  /**
   * Placeholder for a not-yet-measured value (第6工程 B2 fixed occupancy): the
   * readout mounts WITH survey mode (never mid-gesture), showing dashes until a
   * subject pair exists — an honest「未計測」display, not a fabricated 0 (教訓 5.26).
   */
  noValue: '—',
} as const;

/** Format a distance (km) for display, e.g. `1,234.56 km`. */
export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km)) {
    return SURVEY_STRINGS.internalError;
  }
  const rounded = km.toLocaleString('ja-JP', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${rounded} ${SURVEY_STRINGS.unitKm}`;
}
