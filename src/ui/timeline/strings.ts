// 年・月・日の書き方と、年月日の入力欄の文字（FR-115 日本語のみ）。
//
// 文言の表（開発ガイド §5.99）。`time-display.ts`（年の書き方の 1 か所）・`ymd-draft.ts`
// （入力の断り）・`YearMonthDayInput.tsx`（素性欄などの年月日の欄）がここを引く。時刻レールの
// 文は `rail-strings.ts`。この表は何も読み込まない。

/** 年月日の書き方（`time-display.ts` / `ymd-draft.ts`）。 */
export const TIME_DISPLAY_TEXT = {
  bceYear: (magnitude: number): string => `紀元前${magnitude}年`,
  ceYear: (magnitude: number): string => `${magnitude}年`,
  yearMonth: (year: string, month: number): string => `${year}${month}月`,
  yearMonthDay: (year: string, month: number, day: number): string => `${year}${month}月${day}日`,
  /** 月日が無い理由の注記（読み取りの欄の `title`）。 */
  granularityYearNote: '月日は未指定です（指定された年のみ表示しています）',
  granularityYearMonthNote: '日は未指定です（指定された年月のみ表示しています）',
} as const;

/** 年月日の入力の断り（`ymd-draft.ts` の `ymdErrorMessage`）。 */
export const YMD_ERROR_TEXT = {
  yearEmpty: '年を入力してください。',
  notInteger: '整数を入力してください。',
  yearOutOfRange: (max: string): string => `年は±${max}の範囲で入力してください。`,
  monthEmpty: '月を入力してください。',
  dayEmpty: '日を入力してください。',
  monthOutOfRange: '月は1〜12の範囲で入力してください。',
  dayOutOfRange: 'その月に存在しない日です。',
} as const;

/** 年月日の欄（`YearMonthDayInput.tsx`）。読み上げ名は「見出し 年」「見出し 月 未指定」の形。 */
export const YMD_INPUT_TEXT = {
  yearCaption: '年',
  monthCaption: '月',
  dayCaption: '日',
  yearLabel: (title: string): string => `${title} 年`,
  monthLabel: (title: string): string => `${title} 月`,
  monthUnsetLabel: (title: string): string => `${title} 月 未指定`,
  dayLabel: (title: string): string => `${title} 日`,
  dayUnsetLabel: (title: string): string => `${title} 日 未指定`,
  specified: '指定',
  unspecified: '未指定',
  /** 呼ぶ側が文言を渡さなかったときの既定。 */
  openStateDefault: '継続中',
  confirmDefault: '反映',
  specifyDefault: '終了を指定',
  clearDefault: '未設定',
} as const;
