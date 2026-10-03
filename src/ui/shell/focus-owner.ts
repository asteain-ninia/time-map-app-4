// UI layer (U20 / shell): **鍵盤の持ち主**（`focusOwner`。設計書 §D.1 / §D.4、結合点 #5）。
//
// **これが置き換えるもの**: 大域の打鍵を止めるかどうかは、`App.tsx` で **11 項目を手で
// OR した 1 つの真偽値**（`shortcutsSuspended`）だった。項目が増えるたびに 3 か所
// （止める条件・通す集合・断りを出す条件）を同時に直す必要があり、実際に
// **道具を選んだだけで Ctrl+Z・Delete・Escape・右クリックが全部止まる**という穴が
// 空いていた（所属変更の確定直後の Ctrl+Z が無反応＝報告 04 §3.5）。
//
// 本 module は「いま鍵盤を持っているのは誰か」を **1 つの値**に畳み、その値から
// 「何が通るか」を表で決める。新しいダイアログや板を足すときに直すのは
// {@link deriveFocusOwner} の入力 1 か所だけになる。
//
// **順序が意味を持つ**（設計書 §D.4 の Esc の階段と同じ順）。いちばん前にあるものが
// 鍵盤を持つ:
//
//     modal（確認・作業ダイアログ・右クリックメニュー・メニューバー）
//       ↓ 無ければ
//     popover（「◯◯ ▾」の板と一時的な吹き出し。結線されているのは 深さ／表示／吸着／座標／≫／
//              時刻レールの吹き出し／頂点の候補一覧 の 7 つ。設計書 §B.5 の台帳 #5・#12・
//              #14〜#16 と、設定欄の畳み・時刻レール）
//       ↓ 無ければ
//     text（文字入力欄・一覧のその場編集）
//       ↓ 無ければ
//     tool-drawing（道具が下書きを持っている）
//       ↓ 無ければ
//     map（既定）
//
// `none` は「まだ誰も持っていない」＝地図が載る前の一瞬のためにある。**`map` と
// 区別する**のは、`map` が「地図が鍵盤を持っている（＝打鍵が全部通る）」という
// 積極的な状態だからで、載っていないうちに通すと行き先の無い打鍵になる。

/** 鍵盤の持ち主の語彙（設計書 §D.1 の 6 値）。 */
export const FOCUS_OWNER = {
  /** 確認・作業ダイアログ、右クリックメニュー、メニューバー。 */
  Modal: 'modal',
  /** 「◯◯ ▾」の板（深さ・表示・吸着・座標・設定欄の畳み「≫」）・時刻レールの吹き出し・頂点の候補一覧。 */
  Popover: 'popover',
  /** 文字入力欄・一覧のその場編集。 */
  Text: 'text',
  /** 道具が下書き（打った点・分断線・掴んだ対象）を持っている。 */
  ToolDrawing: 'tool-drawing',
  /** 既定。地図・一覧・時刻レールが鍵盤を持っている。 */
  Map: 'map',
  /** まだ誰も持っていない（地図が載る前）。 */
  None: 'none',
} as const;

export type FocusOwner = (typeof FOCUS_OWNER)[keyof typeof FOCUS_OWNER];

/**
 * 導出の入力。**呼び出し側は「何が開いているか」を素直に並べるだけ**で、順序の意味は
 * ここが持つ（旧版は呼び出し側が OR の順序ごと抱えていたので、足すたびに順序の判断が
 * 散らばった）。
 */
export interface FocusOwnerInput {
  /** 確認・作業ダイアログ・右クリックメニュー・メニューバーのどれかが開いている。 */
  readonly modalOpen: boolean;
  /** 「◯◯ ▾」の板・時刻レールの吹き出し・頂点の候補一覧（台帳 #12。増分 8A）のどれかが開いている。 */
  readonly popoverOpen: boolean;
  /** 文字入力欄・その場編集に焦点がある。 */
  readonly textFocused: boolean;
  /** 道具が下書きを持っている（打った点がある・対象を掴んでいる）。 */
  readonly toolDrawing: boolean;
  /** 地図が載っている（載る前は `none`）。既定は true。 */
  readonly mapReady?: boolean;
}

/** 設計書 §D.1 の導出式そのもの。 */
export function deriveFocusOwner(input: FocusOwnerInput): FocusOwner {
  if (input.modalOpen) return FOCUS_OWNER.Modal;
  if (input.popoverOpen) return FOCUS_OWNER.Popover;
  if (input.textFocused) return FOCUS_OWNER.Text;
  if (input.toolDrawing) return FOCUS_OWNER.ToolDrawing;
  if (input.mapReady === false) return FOCUS_OWNER.None;
  return FOCUS_OWNER.Map;
}

/**
 * **大域の打鍵の割り振りを降ろすか**（設計書 §D.4 の表の「Ctrl+Z / Delete」の列）。
 *
 * - `map`: 通す（既定）。
 * - `text`: 通さない ―― ただし降ろすのは `focus-guard` の仕事で、こちらは真を返さない
 *   （二重に止めると「打ちかけの無い欄では通す」という増分 4 の緩和が効かなくなる）。
 * - `tool-drawing`: 降ろす。道具自身の Ctrl+Z（打った点を 1 つ戻す）と二重に走らせない。
 * - `popover`: 降ろす。開いている板の中の操作が背後の地物を書き換えては困る。
 * - `modal`: 降ろす。確認の背後で世界が動かない。
 */
export function suspendsShortcuts(owner: FocusOwner): boolean {
  switch (owner) {
    case FOCUS_OWNER.Modal:
    case FOCUS_OWNER.Popover:
    case FOCUS_OWNER.ToolDrawing:
      return true;
    case FOCUS_OWNER.Text:
    case FOCUS_OWNER.Map:
    case FOCUS_OWNER.None:
      return false;
  }
}

/**
 * **右クリックを止めるか**（設計書 §D.4 の表の「右クリック」の列）。
 *
 * **止めるのはダイアログが持っているときだけ。** 旧版は `shortcutsSuspended` 1 本を
 * 右クリックの口にも使い回していたので、**道具を構えているあいだ右クリックが死んで
 * いた** ―― 設計書 §I.3 の原則①「いつでも開ける（道具を持っている間も。中身が
 * 変わるだけ）」に正面から反する。
 */
export function suspendsContextMenu(owner: FocusOwner): boolean {
  return owner === FOCUS_OWNER.Modal;
}

/**
 * **右クリックが選択を「昇格」させてよいか**（増分 5 の手直し A1 / バグ狩り #1）。
 *
 * 右クリックは、押した先の地物を選択へ引き上げてからメニューを開く ―― メニューの
 * ［削除］が右クリックした地物に効くようにするためである（教訓 5.11）。
 *
 * **ただし道具が下書きを持っているあいだは引き上げない。** 増分 5c で「右クリックは
 * ダイアログのときだけ止める」に直した結果、**作図中の右クリックが選択を書き換え、
 * それを見張っていた追加の道具が下書きを捨てて視点まで飛ばす**という事故が起きた
 * （実データで再現。重症度 4）。3 点以上打っていると、捨てる前の確認板と右クリック
 * メニューが同時に開いて画面が二重になる。
 *
 * 直し方は「メニューを開かない」ではない ―― 設計書 §I.3 の原則①は「いつでも開ける
 * （道具を持っている間も。中身が変わるだけ）」である。**開くが、選択は変えない。**
 * 下書きを持っている間の関心事は下書きであって、背後の地物ではない。
 *
 * **畳んだ 1 つの値（`FocusOwner`）ではなく、生の「下書きを持っているか」を見る。**
 * 畳んだ値では **文字入力が下書きを隠す** ―― 形を確定して名前を打っている局面
 * （素性入力）では持ち主が `text` になるので、`owner !== 'tool-drawing'` で判定すると
 * 昇格が通ってしまい、見張りが下書きごと捨てる（バグ狩り #20 の裏側）。畳む前の
 * 入力を見れば、どの局面でも下書きの有無で決まる。
 */
export function promotesOnContextMenu(input: Pick<FocusOwnerInput, 'toolDrawing'>): boolean {
  return !input.toolDrawing;
}

/**
 * **止めている理由を利用者へ出すか**（増分 3 の「効かなかったことを伝える口」）。
 *
 * ダイアログ **とポップオーバー**が持っているときに出す。道具が持っているときは
 * Escape / Ctrl+Z が道具側で**実際に効いている**ので、断り文を出すと嘘になる。
 *
 * **増分 5 の手直し A4: ポップオーバーを足した。** 「深さ ▾」「吸着 ▾」を開いたまま
 * Delete や Ctrl+S を押すと、止まるだけで **理由が出なかった** ―― 板の中で操作している
 * つもりの利用者から見ると「押しても何も起きない」である。板は Escape 1 つで閉じられる
 * ので、「いま板が開いています」と言えれば次の一手が分かる。
 */
export function explainsRefusal(owner: FocusOwner): boolean {
  return owner === FOCUS_OWNER.Modal || owner === FOCUS_OWNER.Popover;
}
