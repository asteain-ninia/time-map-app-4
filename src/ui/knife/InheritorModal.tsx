// U26 — the継承先選択モーダル (FR-93, HB3-5/19 n-way, 教訓 5.4 / 5.14).
//
// Shown after the split is validated (phase ChoosingInheritor). It is a CENTERED
// modal that:
//   - previews EVERY split piece (HB3-5/19: an open cut crossing the boundary 2k
//     times yields k+1 pieces) with the小さい方 (面積比較) boxed (FR-93 小さい方
//     プレビュー). The smallest piece is computed in the domain (`smallestPieceIndex`)
//     and passed in as `smallestIndex` so the UI and geometry agree (教訓 5.30).
//   - offers a継承先 button per piece with selection HIGHLIGHT (FR-93 ボタン選択時
//     ハイライト) — seeded to the小さい方 by the domain (教訓 5.4 UI 文脈優先). The k-1
//     non-chosen pieces all share the ONE U23 default authored next (the domain
//     assembler does this; the modal just picks WHICH piece inherits).
//   - confirms via the確定 button (the完了トリガー the controller wires; 教訓 5.7).
//
// A 2-piece split renders exactly two buttons (knife-choose-0 / knife-choose-1),
// visually identical to the prior 2-way modal — only driven by index, not 'a'/'b'.
//
// INPUT-LAYER DESIGN (教訓 5.14): a full-surface BACKDROP UNDER the dialog captures
// pointer events so背面 (map / cut-line input) cannot be operated while the modal
// is open; the dialog sits ABOVE it and its buttons receive input directly. Esc
// cancels. This is the same layering the conflict modal uses.

import { useEffect, useRef } from 'react';

import { useModalKeydown } from '../a11y/index';
import type { GeoMultiPolygon } from '../../domain/geometry/types';

import { KNIFE_STRINGS } from './strings';

export interface InheritorModalProps {
  /** Every split piece's geometry, in `SplitResult.pieces` order (HB3-5/19 n-way). */
  readonly pieces: readonly GeoMultiPolygon[];
  /** Which piece is the small方 (domain-computed; FR-93). It is boxed in the preview. */
  readonly smallestIndex: number;
  /** The currently-highlighted piece index (seeded to the小さい方; FR-93). */
  readonly selectedIndex: number;
  /** Highlight a継承先 piece by index (FR-93). */
  readonly onSelect: (index: number) => void;
  /** Confirm the highlighted継承先 (教訓 5.7 完了トリガー). */
  readonly onConfirm: () => void;
  /** Cancel the whole knife operation (教訓 5.2). */
  readonly onCancel: () => void;
}

/** Bounding box across all pieces (for a shared preview viewBox). */
function boundsOf(...mps: readonly GeoMultiPolygon[]): {
  minX: number;
  minY: number;
  w: number;
  h: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const mp of mps) {
    for (const poly of mp) {
      for (const ring of poly) {
        for (const c of ring) {
          if (c.lon < minX) minX = c.lon;
          if (c.lon > maxX) maxX = c.lon;
          if (c.lat < minY) minY = c.lat;
          if (c.lat > maxY) maxY = c.lat;
        }
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 1, h: 1 };
  return { minX, minY, w: Math.max(maxX - minX, 1e-6), h: Math.max(maxY - minY, 1e-6) };
}

/**
 * Outer-ring path data (preview only; holes omitted for the thumbnail).
 *
 * HB4-1: emitted in the **-lat space** — the SAME space as `viewBox` and the
 * `knife-smaller-box` rect. Writing `+lat` here while the viewBox窓 is `-lat`
 * put every non-equator-straddling piece OUTSIDE the viewBox, so only the red
 * dashed box was drawn (「四角だけ出る」). -lat also makes SVG's y-down render
 * north-up directly, so NO CSS flip is applied on the <svg> (a flip on top of
 * -lat would be a double inversion = upside down).
 */
function pathFor(mp: GeoMultiPolygon): string {
  const parts: string[] = [];
  for (const poly of mp) {
    const outer = poly[0];
    if (outer === undefined || outer.length === 0) continue;
    const d = outer
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.lon} ${-c.lat}`)
      .join(' ');
    parts.push(`${d} Z`);
  }
  return parts.join(' ');
}

const PREVIEW_PX = 200;

/** The piece label (面 1 / 面 2 / …). Index-based so it scales to any k+1. */
function pieceLabel(index: number): string {
  return `${KNIFE_STRINGS.chooseAsInheritor}（面 ${index + 1}）`;
}

export function InheritorModal(props: InheritorModalProps): JSX.Element {
  const { pieces, smallestIndex, selectedIndex, onSelect, onConfirm, onCancel } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Esc cancels and Tab / Shift+Tab cycle inside the dialog (背面へ抜けない) — the
  // shared trap (教訓 5.13 / 5.14).
  const onKeyDown = useModalKeydown(dialogRef, onCancel);

  // Focus the dialog on mount so Esc / Tab are captured (教訓 5.14).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const b = boundsOf(...pieces);
  // SVG y grows downward; negate lat so north is up in the preview. EVERY child
  // of the <svg> (paths + rect) must be emitted in this same -lat space (HB4-1).
  const viewBox = `${b.minX} ${-(b.minY + b.h)} ${b.w} ${b.h}`;
  const smallerMp = pieces[smallestIndex] ?? pieces[0] ?? [];
  const sb = boundsOf(smallerMp);
  const strokeWidth = b.w / PREVIEW_PX;

  return (
    <div className="knife-modal-root" data-testid="knife-inheritor-modal-root">
      {/* Backdrop captures input so背面 cannot be operated (教訓 5.14). */}
      <div
        className="knife-backdrop"
        data-testid="knife-backdrop"
        aria-hidden="true"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onClickCapture={(e) => e.stopPropagation()}
      />
      <div
        className="knife-dialog"
        data-testid="knife-inheritor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={KNIFE_STRINGS.inheritorTitle}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="knife-dialog__header">
          <h2 className="knife-dialog__title">{KNIFE_STRINGS.inheritorTitle}</h2>
        </header>

        <p className="knife-dialog__hint" data-testid="knife-smaller-hint">
          {KNIFE_STRINGS.smallerHint}
        </p>

        {/* The shared preview: ALL pieces drawn; the小さい方 boxed (FR-93). */}
        <svg
          className="knife-preview"
          data-testid="knife-preview"
          width={PREVIEW_PX}
          height={PREVIEW_PX}
          viewBox={viewBox}
          // NO CSS scaleY(-1) here (HB4-1): the geometry is already emitted in
          // -lat space, which makes SVG's y-down render north-up. A CSS flip on
          // top of that would invert the preview upside down.
        >
          {pieces.map((mp, i) => (
            <path
              key={i}
              data-testid={`knife-preview-${i}`}
              d={pathFor(mp)}
              className={
                'knife-preview__side' +
                (selectedIndex === i ? ' knife-preview__side--selected' : '')
              }
              fill={selectedIndex === i ? 'rgba(255,193,7,0.5)' : 'rgba(120,144,156,0.4)'}
              stroke="#37474f"
              strokeWidth={strokeWidth}
            />
          ))}
          {/* 小さい方を囲うプレビューボックス (FR-93). */}
          <rect
            data-testid="knife-smaller-box"
            x={sb.minX}
            y={-(sb.minY + sb.h)}
            width={sb.w}
            height={sb.h}
            fill="none"
            stroke="#d50000"
            strokeWidth={strokeWidth * 2}
            strokeDasharray={`${b.w / 30} ${b.w / 60}`}
          />
        </svg>

        <div className="knife-dialog__choices" role="group" aria-label={KNIFE_STRINGS.inheritorTitle}>
          {pieces.map((_, i) => (
            <button
              key={i}
              type="button"
              data-testid={`knife-choose-${i}`}
              aria-pressed={selectedIndex === i}
              className={'knife-choice' + (selectedIndex === i ? ' knife-choice--selected' : '')}
              onClick={() => onSelect(i)}
            >
              {pieceLabel(i)}
            </button>
          ))}
        </div>

        <footer className="knife-dialog__footer">
          <button
            type="button"
            className="knife-dialog__cancel"
            data-testid="knife-modal-cancel"
            onClick={() => onCancel()}
          >
            {KNIFE_STRINGS.cancel}
          </button>
          <button
            type="button"
            className="knife-dialog__confirm"
            data-testid="knife-confirm-inheritor"
            onClick={() => onConfirm()}
          >
            {KNIFE_STRINGS.confirmInheritor}
          </button>
        </footer>
      </div>
    </div>
  );
}
