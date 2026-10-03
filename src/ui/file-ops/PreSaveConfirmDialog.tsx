// UI layer (U39): 保存の前の確認（増分 7 の手直し 2 回目 / 司令塔の決定 (3) の年を見る直し）。
//
// 保存の直前の検査が **年をまたぐ所属の食い違い**（その年に居ない上位領域を指す、まとめ役の
// 下位領域の一覧がその年の実際の所属と食い違う、など）を見つけたときに出す。どれも中身が
// 失われる形ではない（読み込みの修復で直せる）ので、**保存を止めて行き止まりにしない**:
// 理由を名前と年で見せてから［このまま保存する（次に開くときに修復されます）］［やめる］を
// 選ばせる。持ち主の居ない系列・どの年にも居ない親は、これまでどおり保存を止める（板は出ない）。
//
// 器は上書きの確認と同じ DraggablePanel + useModalKeydown で揃える（教訓 5.6: 同じ種類の
// 判断は同じ形で聞く）。Esc と閉じるボタンは「やめる」＝安全側に倒す。
//
// **出ている間は鍵盤の持ち主を自分で名乗る**（`useModalRegistration`。設計書 §B.5 の台帳 #27。
// 本体の取り込みで台帳に載せ、名乗りを足した。`FileOpsController` の `modalOpen` にも入る）。

import { useCallback, useEffect, useRef } from 'react';

import { DraggablePanel } from '../shell/DraggablePanel';
import { useModalKeydown, useModalRegistration } from '../a11y/index';
import { PRE_SAVE_STRINGS } from './strings';

export interface PreSaveConfirmDialogProps {
  /** 1 行ごとの理由（名前と年で言う）。 */
  readonly lines: readonly string[];
  /** true = このまま保存する、false = やめる。Esc と閉じるは false。 */
  readonly onDecide: (confirmed: boolean) => void;
  readonly zIndex?: number;
  /** 出ている間、鍵盤の持ち主を名乗る口（App は `toolModalChange('pre-save')`）。 */
  readonly onModalChange?: ((open: boolean) => void) | undefined;
}

/** 板に並べる行の上限（それより多ければ「ほか n 件」で畳む）。 */
const MAX_LINES = 6;

const INITIAL_POSITION = { x: 420, y: 260 } as const;

export function PreSaveConfirmDialog(props: PreSaveConfirmDialogProps): JSX.Element {
  const { lines, onDecide, zIndex, onModalChange } = props;
  useModalRegistration(onModalChange, true);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const cancel = useCallback(() => onDecide(false), [onDecide]);
  const onKeyDown = useModalKeydown(rootRef, cancel);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const shown = lines.slice(0, MAX_LINES);
  const rest = lines.length - shown.length;

  return (
    <div
      className="unsaved-modal-root"
      data-testid="pre-save-modal-root"
      role="dialog"
      aria-modal="true"
      aria-label={PRE_SAVE_STRINGS.title}
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <DraggablePanel
        id="pre-save-confirm"
        title={PRE_SAVE_STRINGS.title}
        initialPosition={INITIAL_POSITION}
        zIndex={zIndex ?? 1000}
        onClose={cancel}
      >
        <div className="unsaved-dialog" data-testid="pre-save-dialog">
          <p className="unsaved-dialog__body" data-testid="pre-save-intro">
            {PRE_SAVE_STRINGS.intro}
          </p>
          <ul className="unsaved-dialog__body" data-testid="pre-save-lines">
            {shown.map((line, i) => (
              <li key={i} data-testid="pre-save-line">
                {line}
              </li>
            ))}
            {rest > 0 && <li data-testid="pre-save-more">{PRE_SAVE_STRINGS.more(rest)}</li>}
          </ul>
          <div className="unsaved-dialog__choices">
            <button
              type="button"
              className="unsaved-dialog__save"
              data-testid="pre-save-confirm"
              onClick={() => onDecide(true)}
            >
              {PRE_SAVE_STRINGS.confirm}
            </button>
            <button
              type="button"
              className="unsaved-dialog__cancel"
              data-testid="pre-save-cancel"
              onClick={cancel}
            >
              {PRE_SAVE_STRINGS.cancel}
            </button>
          </div>
        </div>
      </DraggablePanel>
    </div>
  );
}
