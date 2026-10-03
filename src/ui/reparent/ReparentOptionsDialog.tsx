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

import { useModalKeydown, useModalRegistration } from '../a11y/index';
import {
  CREATE_TERMINAL,
  parentCreateWithTerminal,
  parentExisting,
  parentNone,
  gainingParentId,
  previewDirectDomain,
  type AffiliationTargetPlan,
  type ParentDecision,
} from '../../domain/affiliation/index';
import { FEATURE_KIND, featureDisplayName, type Feature } from '../../domain/feature';
import { buildForest, directChildIds } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';

import { ParentTreePicker } from './ParentTreePicker';
import { REPARENT_STRINGS, REPARENT_TEXT } from './strings';

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
  /**
   * 対象のうち **自分の歴史をまだ持っていない**件数（司令塔の決定 (1)）。この操作で
   * 自分の系列が起きるので、予告にそう書く。ホストが根を見て数えて渡す（板は根を
   * 持たないので、ここで数え直さない＝教訓 5.29）。
   */
  readonly materializingCount?: number;
  /** 「板が出ている」と名乗る口（司令塔の決定 (13)）。 */
  readonly onModalChange?: (open: boolean) => void;
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
    onModalChange,
  } = props;
  const materializingCount = props.materializingCount ?? 0;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 出ている間は自分で名乗る（決定 (13)）。
  useModalRegistration(onModalChange, true);

  const [choice, setChoice] = useState<ReparentChoice>(initialChoice);
  const [existingParentId, setExistingParentId] = useState<FeatureId | null>(initialParentId);
  const [newName, setNewName] = useState('');
  const [newKindLabel, setNewKindLabel] = useState('');
  const [terminalTop, setTerminalTop] = useState(true);
  const [terminalParentId, setTerminalParentId] = useState<FeatureId | null>(null);
  /** 分け残しの名前の上書き（空＝既定名称を使う）。 */
  const [directDomainName, setDirectDomainName] = useState('');

  // **外から来た枝の要求に追従する**（反証 1-6）。旧版は `initialChoice` を
  // `useState` の初期値にしか使っていなかったので、板が開いたまま素性欄の別のボタンを
  // 押しても枝が変わらず、「新しく作る」を押したのに「既存から選ぶ」のままだった。
  useEffect(() => {
    setChoice(initialChoice);
  }, [initialChoice]);

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

  /**
   * この操作で **子を全部失って自動で消えるまとめ役**（FR-35 の連鎖消滅。反証 2-4）。
   * 解体（3 択の「最上位へ」）はこれが主経路なので、予告に出ないと「まとめ役が黙って
   * 消えた」に見える。`features` と対象集合だけで決まるので板の中で数える。
   */
  const autoRemovedNames = useMemo<readonly string[]>(() => {
    const forest = buildForest(features);
    const targets = new Set(plan.leafIds);
    const gaining = decision === null ? undefined : gainingParentId(decision);
    const names: string[] = [];
    for (const f of features) {
      if (f.kind !== FEATURE_KIND.Aggregate) continue;
      if (f.id === gaining) continue;
      const children = directChildIds(forest, f.id);
      if (children.length === 0) continue;
      if (children.every((c) => targets.has(c))) names.push(featureDisplayName(f));
    }
    return names;
  }, [features, plan.leafIds, decision]);

  /** 選んでいる行き先が候補として使えない理由（Fable #6: 板の本文に出す）。 */
  const ineligibleLine = useMemo<string | null>(() => {
    const pick = choice === REPARENT_CHOICE.Existing ? existingParentId : terminalParentId;
    if (pick === null) return null;
    const reason = eligibility(pick);
    if (reason === null) return null;
    return REPARENT_STRINGS.previewIneligible(nameOf(pick) ?? '', reason);
  }, [choice, existingParentId, terminalParentId, eligibility, nameOf]);

  /** 予告文（設計書 §E.1 の V6・V7・V8。反証 2-3〜2-5 / Fable #2 で実際の増え方へ合わせた）。 */
  const previewLines = useMemo<readonly string[]>(() => {
    const lines: string[] = [];
    const count = plan.leafIds.length;
    if (choice === REPARENT_CHOICE.None) {
      lines.push(REPARENT_STRINGS.previewNone(count));
    } else if (choice === REPARENT_CHOICE.Create) {
      lines.push(REPARENT_STRINGS.previewCreate(count, newName.trim() || REPARENT_TEXT.newNameMissing));
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
    // 決定 (1): まとめ役の錨に居候している対象は、この操作で自分の系列を持つ。
    if (materializingCount > 0) {
      lines.push(REPARENT_STRINGS.previewMaterialize(materializingCount));
    }
    // 子を全部失って自動で消えるまとめ役（解体の主経路。反証 2-4）。
    if (autoRemovedNames.length > 0) {
      lines.push(REPARENT_STRINGS.previewAutoRemoved(autoRemovedNames.join(REPARENT_TEXT.nameSeparator)));
    }
    // 分け残し（直轄領）が生まれる枝（反証 2-5）。
    if (directDomain !== null) {
      lines.push(
        REPARENT_STRINGS.previewDirectDomain(
          directDomain.ownerName,
          directDomainName.trim() === '' ? directDomain.defaultName : directDomainName.trim(),
        ),
      );
    }
    // 元の上位領域を持つ対象が 1 件も無ければ「元の上位領域」を言わない（バグ狩り 2-5）。
    const withOrigin = plan.leafIds.some(
      (id) => features.find((f) => f.id === id)?.parentId !== undefined,
    );
    lines.push(
      choice === REPARENT_CHOICE.None
        ? REPARENT_STRINGS.previewAnchorsNone(yearLabel, withOrigin)
        : choice === REPARENT_CHOICE.Create
          ? REPARENT_STRINGS.previewAnchorsCreate(yearLabel, withOrigin)
          : REPARENT_STRINGS.previewAnchorsInto(yearLabel, withOrigin),
    );
    lines.push(REPARENT_STRINGS.previewUndo);
    return lines;
  }, [
    choice,
    plan,
    features,
    newName,
    existingParentId,
    nameOf,
    yearLabel,
    materializingCount,
    autoRemovedNames,
    directDomain,
    directDomainName,
  ]);

  // **選んでいる行き先が候補として使えないなら確定させない**（増分 7 の手直し・探索
  // `explore-t2-r1` の循環の探り）。ツリーの行は理由つきで灰色だが、地図で拾った
  // 上位領域は「既存から選ぶ」枝の **初期値**として板へ入ってくるので、ツリーを通らずに
  // 使えない相手が選ばれた状態で開きうる。そのとき理由の行（`ineligibleLine`）は出て
  // いるのに［確定］が押せて、押すと断られて板が閉じない ―― 押せるのに断られるボタンを
  // 出さない（教訓 5.26: 確定前にも同じ判定で検証する）。
  const canConfirm =
    decision !== null && plan.leafIds.length > 0 && !committing && ineligibleLine === null;

  const confirm = useCallback(() => {
    if (decision === null || plan.leafIds.length === 0 || committing) return;
    if (ineligibleLine !== null) return;
    onConfirm(
      decision,
      directDomainName.trim() === '' ? {} : { directDomainNameOverride: directDomainName.trim() },
    );
  }, [decision, plan.leafIds.length, committing, onConfirm, directDomainName, ineligibleLine]);

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
        aria-label={REPARENT_STRINGS.optionsTitleWithCount(plan.leafIds.length)}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="reparent-options-dialog__header">
          {/* 件数は **どの枝でも**題に出す（Fable #16）。「既存から選ぶ」で開いたとき
              だけ件数が読めない、という不揃いを無くす。 */}
          <h2 className="reparent-options-dialog__title" data-testid="reparent-options-title">
            {REPARENT_STRINGS.optionsTitleWithCount(plan.leafIds.length)}
          </h2>
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

        {/* 行き先が使えない理由を **板の本文に**出す（Fable #6）。ツリーの行の
            `title` だけだと、マウスを載せないと読めない。 */}
        {ineligibleLine !== null && (
          <p
            className="reparent-options-dialog__message"
            role="alert"
            data-testid="reparent-options-ineligible"
          >
            {ineligibleLine}
          </p>
        )}

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
