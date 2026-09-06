// UI layer (U28 / 所属変更): **3 択の作業ダイアログ**（増分 7 の中身 1・2・4・9・11）。
//
// 所属変更は「割譲・帰属・連邦化・独立・直轄化・自治化」を **1 つのフローのパラメータ違い**
// として表す（FR-46 / FR-47）。ドメインは最初からその形（`ParentDecision` の判別共用体）
// なのに、画面からは `existing`（地図で親をクリック）と `none`（最上位へ）の 2 つしか
// 触れず、**`parentCreate` / `parentCreateWithTerminal` に呼び出し側が 1 つも無かった**
// （G-3 の未結線）。この板がその呼び出し側である。
//
// **形は結合の板を写す**（`MergeOptionsDialog`。3 択の並び・背面の覆い・Esc の罠・
// 確定の関門）。違うのは 3 つ:
//   1. 既存から選ぶ枝が **台帳と同じツリー**（`ParentTreePicker`）である（773 件の素の
//      プルダウンをやめる＝増分 7 の中身 2）。
//   2. **分け残し（直轄領）の名前**を確定前に上書きできる（G-4 / FR-37 must）。
//   3. **確定に時間がかかる**（実測 2.8 秒）ので進行表示を出し、その間は押せない
//      （増分 7 の中身 9）。
//
// **用語集の 7 操作名は説明文に出す**（N-31 / 設計書 §H.1 / 増分 7 の中身 11）。
// ボタンのラベルにはしない ―― 画面の第一表記は平たい言葉で、分類名は括弧に添える。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useModalKeydown } from '../a11y/index';
import {
  CREATE_TERMINAL,
  parentCreateWithTerminal,
  parentExisting,
  parentNone,
  previewDirectDomain,
  type AffiliationTargetPlan,
  type ParentDecision,
} from '../../domain/affiliation/index';
import { featureDisplayName, type Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';

import { ParentTreePicker } from './ParentTreePicker';
import { REPARENT_STRINGS } from './strings';

/** 板が出す 3 択（設計書 §C.6 の親欄の 3 ボタンと 1 対 1）。 */
export const REPARENT_CHOICE = {
  Existing: 'existing',
  Create: 'create',
  None: 'none',
} as const;

export type ReparentChoice = (typeof REPARENT_CHOICE)[keyof typeof REPARENT_CHOICE];

export interface ReparentOptionsDialogProps {
  /** その年に効いている地物の全件（候補の母集団と、名前の解決に使う）。 */
  readonly features: readonly Feature[];
  /** 洗い直し済みの対象（予告文と件数はここから作る）。 */
  readonly plan: AffiliationTargetPlan;
  /** どの枝を開いた状態で出すか（親欄の 3 ボタン・確定欄・設定欄が指定する）。 */
  readonly initialChoice: ReparentChoice;
  /** 地図で拾ってあった新しい上位領域（既存の枝の初期値）。 */
  readonly initialParentId: FeatureId | null;
  /**
   * 候補として選べるか（null = 選べる／文字列 = 断りの理由）。ドメインの
   * `isLegalNewParent` を呼び出し側が回した結果を渡す（教訓 5.26）。
   */
  readonly eligibility: (featureId: FeatureId) => string | null;
  /** いま見ている年の表示（予告文「1200年の記録が…」に使う）。 */
  readonly yearLabel: string;
  /** 断りの理由（前の確定が拒否されていれば）。 */
  readonly message: string | null;
  /** 確定中か（進行表示を出し、確定ボタンを止める）。 */
  readonly committing: boolean;
  /** 確定（決定と、分け残しの名前の上書き）。 */
  readonly onConfirm: (
    decision: ParentDecision,
    options: { readonly directDomainNameOverride?: string },
  ) => void;
  /** 板を閉じる（選んだ地物は保つ）。 */
  readonly onCancel: () => void;
}

export function ReparentOptionsDialog(props: ReparentOptionsDialogProps): JSX.Element {
  const {
    features,
    plan,
    initialChoice,
    initialParentId,
    eligibility,
    yearLabel,
    message,
    committing,
    onConfirm,
    onCancel,
  } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const [choice, setChoice] = useState<ReparentChoice>(initialChoice);
  const [existingParentId, setExistingParentId] = useState<FeatureId | null>(initialParentId);
  const [newName, setNewName] = useState('');
  const [newKindLabel, setNewKindLabel] = useState('');
  const [terminalTop, setTerminalTop] = useState(true);
  const [terminalParentId, setTerminalParentId] = useState<FeatureId | null>(null);
  /** 分け残しの名前の上書き（空＝既定名称を使う）。 */
  const [directDomainName, setDirectDomainName] = useState('');

  // Esc で閉じ、Tab は板の中を回る（背面へ抜けない）。ほかの 6 つの板と同じ共有の罠。
  const onKeyDown = useModalKeydown(dialogRef, onCancel);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const nameOf = useCallback(
    (featureId: FeatureId | null): string | null => {
      if (featureId === null) return null;
      const f = features.find((x) => x.id === featureId);
      return f === undefined ? null : featureDisplayName(f);
    },
    [features],
  );

  /** いま選んでいる決定（3 択 → `ParentDecision`）。不足があれば null。 */
  const decision = useMemo<ParentDecision | null>(() => {
    switch (choice) {
      case REPARENT_CHOICE.Existing:
        return existingParentId === null ? null : parentExisting(existingParentId);
      case REPARENT_CHOICE.Create: {
        if (newName.trim() === '') return null;
        const spec =
          newKindLabel.trim() === ''
            ? { name: newName.trim() }
            : { name: newName.trim(), kindLabel: newKindLabel.trim() };
        if (terminalTop) {
          return parentCreateWithTerminal(spec, { kind: CREATE_TERMINAL.NewTop });
        }
        if (terminalParentId === null) return null;
        return parentCreateWithTerminal(spec, {
          kind: CREATE_TERMINAL.ExistingTop,
          topId: terminalParentId,
        });
      }
      case REPARENT_CHOICE.None:
        return parentNone;
    }
  }, [choice, existingParentId, newName, newKindLabel, terminalTop, terminalParentId]);

  /**
   * 分け残しが増える見込み（G-4 / FR-37）。**決定から先読みする**ので、既存の親が
   * 自分の形を持つ面のときと、新しく作る枝の置き場所が面のときの両方で出る。
   */
  const directDomain = useMemo(
    () => (decision === null ? null : previewDirectDomain(features, decision)),
    [features, decision],
  );

  /** 予告文（設計書 §E.1 の V6・V7・V8）。 */
  const previewLines = useMemo<readonly string[]>(() => {
    const lines: string[] = [];
    const count = plan.leafIds.length;
    if (choice === REPARENT_CHOICE.None) {
      lines.push(REPARENT_STRINGS.previewNone(count));
    } else if (choice === REPARENT_CHOICE.Create) {
      lines.push(REPARENT_STRINGS.previewCreate(count, newName.trim() || '（名前未入力）'));
    } else {
      const parentName = nameOf(existingParentId);
      if (parentName !== null) lines.push(REPARENT_STRINGS.previewInto(count, parentName));
    }
    for (const e of plan.expansions) {
      const aggName = nameOf(e.aggregateId);
      if (aggName !== null) {
        lines.push(REPARENT_STRINGS.previewExpanded(aggName, e.leafIds.length));
      }
    }
    const missing = plan.dropped.filter((d) => d.reason === 'missing').length;
    if (missing > 0) lines.push(REPARENT_STRINGS.previewDroppedMissing(missing));
    const empty = plan.dropped.filter((d) => d.reason === 'empty-aggregate').length;
    if (empty > 0) lines.push(REPARENT_STRINGS.previewDroppedEmpty(empty));
    lines.push(REPARENT_STRINGS.previewAnchors(yearLabel));
    return lines;
  }, [choice, plan, newName, existingParentId, nameOf, yearLabel]);

  const canConfirm = decision !== null && plan.leafIds.length > 0 && !committing;

  const confirm = useCallback(() => {
    if (decision === null || plan.leafIds.length === 0 || committing) return;
    onConfirm(
      decision,
      directDomainName.trim() === '' ? {} : { directDomainNameOverride: directDomainName.trim() },
    );
  }, [decision, plan.leafIds.length, committing, onConfirm, directDomainName]);

  return (
    <div className="reparent-options-root" data-testid="reparent-options-modal-root">
      {/* 背面を覆って入力を止める（教訓 5.14）。板が出ているあいだ地図は触れない。 */}
      <div
        className="reparent-options-backdrop"
        data-testid="reparent-options-backdrop"
        aria-hidden="true"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onClickCapture={(e) => e.stopPropagation()}
      />
      <div
        className="reparent-options-dialog"
        data-testid="reparent-options-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={REPARENT_STRINGS.optionsTitle}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="reparent-options-dialog__header">
          <h2 className="reparent-options-dialog__title">{REPARENT_STRINGS.optionsTitle}</h2>
        </header>
        <p className="reparent-options-dialog__hint">{REPARENT_STRINGS.optionsHint}</p>

        <fieldset className="reparent-options-dialog__section" data-testid="reparent-options-parent">
          <legend>{REPARENT_STRINGS.parentHeading}</legend>

          <label className="reparent-options-dialog__choice">
            <input
              type="radio"
              name="reparent-parent"
              data-testid="reparent-parent-existing"
              checked={choice === REPARENT_CHOICE.Existing}
              onChange={() => setChoice(REPARENT_CHOICE.Existing)}
            />
            {REPARENT_STRINGS.parentExisting}
          </label>
          {choice === REPARENT_CHOICE.Existing && (
            <ParentTreePicker
              features={features}
              eligibility={eligibility}
              value={existingParentId}
              onChange={setExistingParentId}
              testIdPrefix="reparent-parent-existing-pick"
              label={REPARENT_STRINGS.parentExistingPickLabel}
            />
          )}

          <label className="reparent-options-dialog__choice">
            <input
              type="radio"
              name="reparent-parent"
              data-testid="reparent-parent-create"
              checked={choice === REPARENT_CHOICE.Create}
              onChange={() => setChoice(REPARENT_CHOICE.Create)}
            />
            {REPARENT_STRINGS.parentCreate}
          </label>
          {choice === REPARENT_CHOICE.Create && (
            <div className="reparent-options-dialog__branch">
              <input
                type="text"
                className="reparent-options-dialog__text"
                data-testid="reparent-parent-create-name"
                aria-label={REPARENT_STRINGS.parentCreateNameLabel}
                placeholder={REPARENT_STRINGS.parentCreateNameLabel}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                type="text"
                className="reparent-options-dialog__text"
                data-testid="reparent-parent-create-kind"
                aria-label={REPARENT_STRINGS.parentCreateKindLabel}
                placeholder={REPARENT_STRINGS.parentCreateKindLabel}
                value={newKindLabel}
                onChange={(e) => setNewKindLabel(e.target.value)}
              />
              <fieldset className="reparent-options-dialog__terminal">
                <legend>{REPARENT_STRINGS.parentCreateTerminalHeading}</legend>
                <label className="reparent-options-dialog__choice">
                  <input
                    type="radio"
                    name="reparent-create-terminal"
                    data-testid="reparent-create-terminal-top"
                    checked={terminalTop}
                    onChange={() => setTerminalTop(true)}
                  />
                  {REPARENT_STRINGS.parentCreateTerminalTop}
                </label>
                <label className="reparent-options-dialog__choice">
                  <input
                    type="radio"
                    name="reparent-create-terminal"
                    data-testid="reparent-create-terminal-under"
                    checked={!terminalTop}
                    onChange={() => setTerminalTop(false)}
                  />
                  {REPARENT_STRINGS.parentCreateTerminalUnder}
                </label>
                {!terminalTop && (
                  <ParentTreePicker
                    features={features}
                    eligibility={eligibility}
                    value={terminalParentId}
                    onChange={setTerminalParentId}
                    testIdPrefix="reparent-create-terminal-pick"
                    label={REPARENT_STRINGS.parentExistingPickLabel}
                  />
                )}
              </fieldset>
            </div>
          )}

          <label className="reparent-options-dialog__choice">
            <input
              type="radio"
              name="reparent-parent"
              data-testid="reparent-parent-none"
              checked={choice === REPARENT_CHOICE.None}
              onChange={() => setChoice(REPARENT_CHOICE.None)}
            />
            {REPARENT_STRINGS.parentNone}
          </label>
          {choice === REPARENT_CHOICE.None && (
            <p className="reparent-options-dialog__warning" data-testid="reparent-detach-confirm">
              {REPARENT_STRINGS.detachConfirmBody}
            </p>
          )}

          {/* 用語集の 7 つ目（解体）の行き先。3 択には入らない操作なので、行き先だけ書く。 */}
          <p className="reparent-options-dialog__note" data-testid="reparent-dismantle-note">
            {REPARENT_STRINGS.parentDismantleNote}
          </p>
        </fieldset>

        {/* 分け残し（直轄領）の名前 — 確定前に上書きできる（G-4 / FR-37 must）。 */}
        {directDomain !== null && (
          <fieldset
            className="reparent-options-dialog__section"
            data-testid="reparent-direct-domain"
          >
            <legend>{REPARENT_STRINGS.directDomainHeading}</legend>
            <p className="reparent-options-dialog__note">
              {REPARENT_STRINGS.directDomainNotice(directDomain.ownerName)}
            </p>
            <input
              type="text"
              className="reparent-options-dialog__text"
              data-testid="reparent-direct-domain-name"
              aria-label={REPARENT_STRINGS.directDomainNameLabel}
              placeholder={directDomain.defaultName}
              value={directDomainName}
              onChange={(e) => setDirectDomainName(e.target.value)}
            />
          </fieldset>
        )}

        <ul className="reparent-options-dialog__preview" data-testid="reparent-preview">
          {previewLines.map((line, i) => (
            <li key={`${String(i)}-${line}`}>{line}</li>
          ))}
        </ul>

        {message !== null && (
          <p className="reparent-options-dialog__message" role="alert" data-testid="reparent-options-message">
            {message}
          </p>
        )}

        {committing && (
          <p
            className="reparent-options-dialog__progress"
            role="status"
            aria-live="polite"
            data-testid="reparent-commit-progress"
          >
            {REPARENT_STRINGS.committing}
          </p>
        )}

        <footer className="reparent-options-dialog__footer">
          <button
            type="button"
            className="reparent-options-dialog__cancel"
            data-testid="reparent-options-cancel"
            onClick={() => onCancel()}
          >
            {REPARENT_STRINGS.optionsCancel}
          </button>
          <button
            type="button"
            className="reparent-options-dialog__confirm"
            data-testid="reparent-options-confirm"
            disabled={!canConfirm}
            aria-busy={committing}
            onClick={() => confirm()}
          >
            {REPARENT_STRINGS.optionsConfirm}
          </button>
        </footer>
      </div>
    </div>
  );
}
