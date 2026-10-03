// UI 層（U39 / FR-04）: 背景地図の縦横比を聞く板（増分 8E / G-10。設計書 §C.2 の 22
// 「作業ダイアログ」の 1 枚。§B.5 の台帳 #28）。
//
// 「この画像は 3:2 です。2:1 に補正しますか、このまま使いますか。」を出し、
// ［2:1 に補正する］［このまま使う］［やめる］で答えてもらう。2:1 から離れすぎて補正
// できないときは［補正する］を出さない。Esc は［やめる］（安全側。地図は変わらない）。
//
// **出る場所**: 差し替えは設定の板（z-index 1000）の［差し替え］から始まり、設定の板は
// 開いたままなので、この板はその **上** に出る必要がある。祖先の重ね順に左右されないよう
// `document.body` へ出し（ポータル）、背後を覆う層ごと設定の板より前に置く（教訓 5.14:
// 重なる UI は入力を受ける層も同時に設計する）。
//
// 鍵盤の持ち主へは自分で名乗る（`useModalRegistration`。名乗り漏れは
// `modal-registration.test.tsx` が総当たりで見る）。

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { useModalKeydown, useModalRegistration } from '../a11y/index';

import {
  BASEMAP_ASPECT_CHOICE,
  BASEMAP_ASPECT_STRINGS,
  correctShiftAxis,
  type BasemapAspectPromptStore,
} from './basemap-aspect';

export interface BasemapAspectDialogProps {
  readonly store: BasemapAspectPromptStore;
  /** 板が出ている間「板が出ている」と名乗る口（鍵盤の持ち主。設計書 §D.1）。 */
  readonly onModalChange: ((open: boolean) => void) | undefined;
}

export function BasemapAspectDialog(props: BasemapAspectDialogProps): JSX.Element | null {
  const { store, onModalChange } = props;
  const question = useSyncExternalStore(store.subscribe, store.get, store.get);
  useModalRegistration(onModalChange, question !== null);
  if (question === null) return null;
  return createPortal(<AspectPanel store={store} />, document.body);
}

function AspectPanel(props: { readonly store: BasemapAspectPromptStore }): JSX.Element | null {
  const { store } = props;
  const question = useSyncExternalStore(store.subscribe, store.get, store.get);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cancel = useCallback(() => store.answer(BASEMAP_ASPECT_CHOICE.Cancel), [store]);
  const onKeyDown = useModalKeydown(rootRef, cancel);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  if (question === null) return null;
  return (
    <div className="basemap-aspect-root" data-testid="basemap-aspect-root">
      {/* 背後（設定の板・地図）を押せなくする層。答えるまで先へ進めない。 */}
      <div
        className="basemap-aspect-backdrop"
        data-testid="basemap-aspect-backdrop"
        aria-hidden="true"
      />
      <div
        className="basemap-aspect-dialog"
        data-testid="basemap-aspect-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={BASEMAP_ASPECT_STRINGS.title}
        tabIndex={-1}
        ref={rootRef}
        onKeyDown={onKeyDown}
      >
        <h2 className="basemap-aspect-dialog__title">{BASEMAP_ASPECT_STRINGS.title}</h2>
        <p className="basemap-aspect-dialog__question" data-testid="basemap-aspect-question">
          {question.correctable
            ? BASEMAP_ASPECT_STRINGS.question(question.ratioLabel)
            : BASEMAP_ASPECT_STRINGS.questionUncorrectable(question.ratioLabel)}
        </p>
        <p className="basemap-aspect-dialog__explain">
          {question.correctable
            ? BASEMAP_ASPECT_STRINGS.explainCorrectable
            : BASEMAP_ASPECT_STRINGS.explainUncorrectable}
        </p>
        {/* 補正で地図の上の絵がずれることを言う（増分 8E の手直し。反証 2-4）。 */}
        {question.correctable && (
          <p className="basemap-aspect-dialog__explain" data-testid="basemap-aspect-shift">
            {BASEMAP_ASPECT_STRINGS.explainCorrectShift(correctShiftAxis(question))}
          </p>
        )}
        <div className="basemap-aspect-dialog__actions">
          {question.correctable && (
            <button
              type="button"
              data-testid="basemap-aspect-correct"
              onClick={() => store.answer(BASEMAP_ASPECT_CHOICE.Correct)}
            >
              {BASEMAP_ASPECT_STRINGS.correct}
            </button>
          )}
          <button
            type="button"
            data-testid="basemap-aspect-keep"
            onClick={() => store.answer(BASEMAP_ASPECT_CHOICE.Keep)}
          >
            {BASEMAP_ASPECT_STRINGS.keep}
          </button>
          <button type="button" data-testid="basemap-aspect-cancel" onClick={cancel}>
            {BASEMAP_ASPECT_STRINGS.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
