// 地図の上の操作（拡大・縮小・グリッド・中心経度・深さ・頂点の候補）の利用者向けの文。
//
// 文言の表（開発ガイド §5.99）。`○○_STRINGS` は各部品のファイルに置いていた表を一字一句
// そのまま移したもので、元のファイルから同じ名前で再び公開している（読み込む側は変えない）。
// `○○_TEXT` は 2026-10 に部品の中の直書きを集めたもの。この表は何も読み込まない。

/** 画面に出る言葉（教訓 5.64: 検査に直書きさせない）。 */
export const MAP_VIEW_CONTROL_STRINGS = {
  zoomIn: '地図を拡大',
  zoomOut: '地図を縮小',
  fitAll: '全体表示',
  scaleLabel: '縮尺',
} as const;

/** All user-visible text for the grid toggle (教訓 5.19 表示文言は定数を経由する). */
export const GRID_TOGGLE_STRINGS = {
  /** Button label — short + constant width for the topBar fixed-occupancy invariant. */
  label: 'グリッド',
  /** Accessible name / tooltip (FR-13 グリッド(グラティキュール)表示の ON/OFF). */
  ariaLabel: 'グリッド表示切替',
  /**
   * K-6: 「読むだけ」で無効になっている理由（tooltip）。無効の理由を言わない無効ボタンは
   * 「壊れている」と読まれる（教訓 5.7 の死んだボタンと見分けがつかない）ので必ず出す。
   */
  viewOnlyTitle: 'グリッド表示切替（「読むだけ」の間は変更できません。この設定は保存ファイルに入ります）',
} as const;

/** 画面に出る言葉（教訓 5.64）。 */
export const VERTEX_CANDIDATE_STRINGS = {
  heading: 'この位置の頂点',
  hint: '掴める距離に複数あります。1 つ選んでください。',
  close: '閉じる',
  more: (count: number): string => `ほか ${String(count)} 件。拡大すると絞れます。`,
  /** 残りを出すボタン（増分 8A の手直し・GPT #1。21 件目より先にも選ぶ道を残す）。 */
  showMore: 'もっと見る',
} as const;

/** 画面に出る言葉（教訓 5.64）。文は設計書 §E.1 V9 のとおり。 */
export const HANDLE_CAP_STRINGS = {
  reason: (counted: string, cap: string): string =>
    `頂点が ${counted} あり、上限 ${cap} のため印を出していません。拡大すると出ます`,
  /** 上限が 0（印を出さない設定）のときは拡大しても出ないので、［拡大］を出さない。 */
  reasonCapZero: (counted: string): string =>
    `頂点が ${counted} あり、上限 0 のため印を出していません。`,
  /**
   * ズームの上限まで寄っていて、これ以上は拡大できないとき（増分 8A の手直し・設計適合 2-4）。
   * 「拡大すると出ます」を言うと、押しても何も起きない［拡大］を勧めることになる（無言の失敗）。
   */
  reasonAtMaxZoom: (counted: string, cap: string): string =>
    `頂点が ${counted} あり、上限 ${cap} のため印を出していません。これ以上は拡大できません。`,
  zoom: '拡大',
} as const;

/** 画面に出る言葉（教訓 5.64: 検査に直書きさせない）。 */
export const VERTEX_CANDIDATE_ROW_STRINGS = {
  vertex: (number: string): string => `頂点 #${number}`,
  sharedWith: (names: string): string => `${names}と共有`,
  othersSuffix: (count: number): string => `ほか ${String(count)} 件`,
  unknownFeature: '（名前なし）',
} as const;

/** 地図の右下の拡大・縮小・全体のボタンの文字（`MapViewControls.tsx`）。 */
export const MAP_VIEW_CONTROL_TEXT = {
  zoomInButton: '＋',
  zoomOutButton: '−',
  fitAllButton: '全体',
} as const;

/** 中心経度の操作（`LongitudeShiftControl.tsx`）。 */
export const LONGITUDE_SHIFT_TEXT = {
  /** 数値の前に置く見出し（あとの空白も値に含む）。 */
  readoutPrefix: '中心経度: ',
  presetPrimeMeridian: '0度中心',
  presetPacific: '180度中心',
  presetPrimeMeridianTitle: '中心経度を0°にする',
  presetPacificTitle: '中心経度を180°にする',
  shiftHint:
    'スライダーは相対シフト（離すと中央へ戻ります）。現在の中心経度は上の数値が真値です。',
  absoluteHint:
    '中心経度を度数で直接指定（東経が正・±180°の範囲外は折り返し）。Enter または「移動」で反映します。',
  sliderAriaLabel: '経度シフト',
  shiftLeftAriaLabel: '左へシフト',
  shiftRightAriaLabel: '右へシフト',
  absoluteAriaLabel: '中心経度を指定',
  absolutePlaceholder: '経度',
  absoluteCommitAriaLabel: '指定経度へ移動',
  absoluteCommitButton: '移動',
} as const;

/** 深さの操作（`GlobalDepthControl.tsx`）。 */
export const GLOBAL_DEPTH_TEXT = {
  depthDownButton: '−',
  depthUpButton: '＋',
  focusSwitchTo: (label: string): string => `${label} に切替`,
  focusDrill: (label: string): string => `${label} を深掘り`,
} as const;

/** 頂点の候補の 1 行（`vertex-candidates.ts` の `buildCandidateRow`）。 */
export const VERTEX_CANDIDATE_ROW_TEXT = {
  /** 名前や座標を並べるときの区切り。 */
  separator: '・',
  label: (vertex: string, parts: string): string => `${vertex}（${parts}）`,
} as const;

/** 拡大・縮小の端の知らせ（`zoom-limit-notice.ts`）。倍率の書き方は呼ぶ側で整える。 */
export const ZOOM_LIMIT_NOTICE_TEXT = {
  sideMax: (max: string): string => `拡大の上限（${max}倍）です`,
  sideMin: (min: string): string => `縮小の下限（${min}倍）です`,
  statusMax: (max: string): string =>
    `これ以上は拡大できません。拡大の上限（${max}倍）に達しています。上限は設定の「最大ズーム倍率」で変えられます。`,
  statusMin: (min: string): string =>
    `これ以上は縮小できません。縮小の下限（${min}倍）に達しています。下限は設定の「最小ズーム倍率」で変えられます。`,
} as const;
