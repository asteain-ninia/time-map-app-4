// UI layer (U39): 上書き保存の確認ダイアログ（設計書 §H.6 / 実装計画 増分 1 の中身 3）。
//
// **これまで Ctrl+S は確認なく読み込み元を上書きしていた**（V12）。調査中に実データの正準
// ファイルが上書きされた実績があり（開発ガイド §5.48）、フル版と間引き版のように名前が
// 似たファイルを扱う運用では取り違えが起きる。**行き先の名前とフルパスを見せてから書く。**
//
// 「初回の上書きだけ」聞く理由: 毎回聞くと確認が儀式になり、読まずに押すようになる
// （そうなると確認が無いのと同じである）。セッション中に保存先が変わったら、その新しい
// 行き先について改めて 1 回聞く。
//
// 器は既存の未保存警告と同じ DraggablePanel + useModalKeydown で揃える（教訓 5.6:
// 同じ種類の判断は同じ形で聞く）。Esc と閉じるボタンは「やめる」＝安全側に倒す。

import { useCallback, useEffect, useRef } from 'react';

import { DraggablePanel } from '../shell/DraggablePanel';
import { useModalKeydown } from '../a11y/index';
import { OVERWRITE_STRINGS } from './strings';

export interface OverwriteConfirmDialogProps {
  /** 上書きする先の絶対パス。 */
  readonly savePath: string;
  /** 画面に出すファイル名（拡張子込み）。 */
  readonly fileName: string;
  /** true = 上書きする、false = やめる。Esc と閉じるは false。 */
  readonly onDecide: (confirmed: boolean) => void;
  readonly zIndex?: number;
}

// 未保存警告 (x:360, y:220) と **重ならない位置**に置く。未保存警告の「保存して続行」は
// 上書き確認を呼ぶので 2 枚が同時に出る（A3）。同じ位置に重ねると、どちらのボタンを
// 押しているのか分からなくなる（教訓 5.14: 重なる UI は入力を受ける層まで設計する）。
const INITIAL_POSITION = { x: 460, y: 320 } as const;

export function OverwriteConfirmDialog(props: OverwriteConfirmDialogProps): JSX.Element {
  const { savePath, fileName, onDecide, zIndex } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);

  const cancel = useCallback(() => onDecide(false), [onDecide]);
  const onKeyDown = useModalKeydown(rootRef, cancel);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  return (
    <div
      className="unsaved-modal-root"
      data-testid="overwrite-modal-root"
      role="dialog"
      aria-modal="true"
      aria-label={OVERWRITE_STRINGS.title}
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <DraggablePanel
        id="overwrite-confirm"
        title={OVERWRITE_STRINGS.title}
        initialPosition={INITIAL_POSITION}
        zIndex={zIndex ?? 1000}
        onClose={cancel}
      >
        <div className="unsaved-dialog" data-testid="overwrite-dialog">
          <p className="unsaved-dialog__body" data-testid="overwrite-body">
            {OVERWRITE_STRINGS.body(fileName)}
          </p>
          {/* 同名ファイルの取り違えはフルパスでしか見分けられないので必ず出す。 */}
          <p className="unsaved-dialog__path" data-testid="overwrite-path">
            {OVERWRITE_STRINGS.pathLabel}: {savePath}
          </p>
          <div className="unsaved-dialog__choices">
            <button
              type="button"
              className="unsaved-dialog__save"
              data-testid="overwrite-confirm"
              onClick={() => onDecide(true)}
            >
              {OVERWRITE_STRINGS.confirm}
            </button>
            <button
              type="button"
              className="unsaved-dialog__cancel"
              data-testid="overwrite-cancel"
              onClick={cancel}
            >
              {OVERWRITE_STRINGS.cancel}
            </button>
          </div>
        </div>
      </DraggablePanel>
    </div>
  );
}
