// U28/U31 共通 — 「まとめ役から離れる地物の記録を自分の系列へ起こす」純関数。
//
// 記録の置き場の原則（司令塔の決定 (1)）:
//   地物の記録は自分の系列（FeatureHistory）に置く。唯一の例外は「自分の系列を
//   持たないまとめ役の子」で、その記録は親の錨のスナップショットの中にある。
//   地物がそのまとめ役の子でなくなる瞬間 —— 別の親へ移す／最上位へ昇格／まとめ役を
//   全部の年から消す／まとめ役を解体する／まとめ役をその年で終わらせる —— に、
//   その地物の記録を親の錨から選り分けて自分の系列を起こし、親の錨からは外す。
//
// これを怠ると、親の錨が消えた瞬間に子の記録ごと消える（実データで 60 州が丸ごと
// 失われる／別の親へ移した州まで巻き添えになる／まとめ役を終わらせると子が道連れに
// なる）。教訓 5.21「削除は参照掃除と連鎖剪定まで行う」の裏返しで、こちらは
// 「所属を動かすときは参照だけでなく記録の置き場まで動かす」。
//
// 純粋: 入力を変更せず新しい histories を返す。呼び手はいずれも「全体差し替え」の
// 命令なので、取り消しは構築時の histories をそのまま戻すことで対称になる
// （系列の起こし・消しも同じ 1 段に含まれる）。

import { createAnchor, createAnchorSnapshot, type Anchor } from '../anchor';
import { applyPastEdit, type AnchorEntry } from '../anchor-series';
import { pruneVertexStore, withParentId, type Feature } from '../feature';
import { createVertexStore } from '../vertex';
import { deriveAnchorId } from '../anchor-id';
import { asAnchorId, idToString, type FeatureId } from '../ids';
import type { FeatureHistory } from '../persistence/serialize';
import type { Calendar } from '../time/calendar';
import type { TimePoint } from '../time/time-point';
import { compare } from '../time/normalized';

/** 結果: 起こした後の histories と、実際に系列を起こした地物の並び。 */
export interface MaterializeOwnSeriesResult {
  readonly histories: readonly FeatureHistory[];
  /** 新しく自分の系列を得た地物（もともと持っていたものは含まない）。 */
  readonly materializedIds: readonly FeatureId[];
}

/**
 * `featureId` が自分の系列（その id を持ち主とする歴史）を持っているか。
 * 持っていれば記録は既に自分の場所にあり、起こす必要はない。
 */
export function hasOwnSeries(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
): boolean {
  return histories.some((h) => h.featureId === featureId);
}

/**
 * `ownerId` の歴史の錨の中に居候している地物の id（`ownerId` 自身は除く）。
 * 自分の系列を持つものは既に独立しているので除く。まとめ役を消す／終わらせる前に、
 * 記録を起こすべき相手を数え上げるのに使う（孫も同じ錨に居るので一緒に拾える）。
 */
export function residentFeatureIds(
  histories: readonly FeatureHistory[],
  ownerId: FeatureId,
): readonly FeatureId[] {
  const owner = histories.find((h) => h.featureId === ownerId);
  if (owner === undefined) return [];
  const seen = new Set<FeatureId>();
  const out: FeatureId[] = [];
  for (const entry of owner.series.entries) {
    for (const f of entry.anchor.snapshot.features) {
      if (f.id === ownerId) continue;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      if (hasOwnSeries(histories, f.id)) continue;
      out.push(f.id);
    }
  }
  return out;
}

interface Occurrence {
  readonly historyIndex: number;
  readonly entryIndex: number;
  readonly feature: Feature;
  readonly start: TimePoint;
  readonly end: TimePoint | null;
}

/**
 * `featureIds` のうち自分の系列を持たないものについて、居候先の錨から全部の年の
 * 記録を選り分けて自分の系列を起こし、居候先の錨からは外す（FR-54〜FR-59 の
 * carry-forward の意味が保たれるよう、年の区切りは写し元をそのまま写す）。
 *
 * - 頂点は写し元の錨から「その地物が参照する分だけ」を持って行く（単一真実源の剪定）。
 *   共有頂点は写し元にも残るので、兄弟の参照は切れない。
 * - 写し元の錨は当該地物を除いた地物集合で作り直し、参照されなくなった頂点を剪定する。
 * - 全部の錨が空になった歴史は落とす（持ち主の居ない空の系列を残さない）。
 */
export function materializeOwnSeries(
  histories: readonly FeatureHistory[],
  featureIds: Iterable<FeatureId>,
  calendar: Calendar,
): MaterializeOwnSeriesResult {
  const wanted: FeatureId[] = [];
  const seen = new Set<FeatureId>();
  for (const id of featureIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (hasOwnSeries(histories, id)) continue;
    wanted.push(id);
  }
  if (wanted.length === 0) return { histories, materializedIds: [] };

  // 1 度の走査で全対象の居候先を集める（歴史 × 錨 × 地物の三重走査を 1 回で済ませる）。
  const occurrences = new Map<FeatureId, Occurrence[]>();
  for (const id of wanted) occurrences.set(id, []);
  histories.forEach((history, historyIndex) => {
    history.series.entries.forEach((entry, entryIndex) => {
      for (const f of entry.anchor.snapshot.features) {
        const slot = occurrences.get(f.id);
        if (slot === undefined) continue;
        if (f.id === history.featureId) continue; // 持ち主自身は居候ではない
        slot.push({
          historyIndex,
          entryIndex,
          feature: f,
          start: entry.start,
          end: entry.end,
        });
      }
    });
  });

  // 写し元から外す予定の (歴史, 錨) → 外す id の集合。
  const removals = new Map<string, Set<FeatureId>>();
  const materializedIds: FeatureId[] = [];
  const created: FeatureHistory[] = [];
  /** 起こした系列を置く位置: 写し元のうち最も前にある歴史の番号（直後に置く）。 */
  const placeAfter: number[] = [];

  for (const id of wanted) {
    const hits = occurrences.get(id) ?? [];
    if (hits.length === 0) continue; // どこにも記録が無い（既に消えている）
    const ordered = [...hits].sort((a, b) => compare(a.start, b.start, calendar));
    const entries: AnchorEntry[] = [];
    const usedAnchorIds = new Set<string>();
    for (const hit of ordered) {
      const source = histories[hit.historyIndex]?.series.entries[hit.entryIndex];
      if (source === undefined) continue;
      const store = pruneVertexStore(source.anchor.snapshot.vertices, [hit.feature]);
      let anchorKey = idToString(deriveAnchorId(id, hit.start));
      // 同じ年に写し元が複数あるのは異常だが、id の重複だけは避ける（INV-6）。
      let dedupe = 1;
      while (usedAnchorIds.has(anchorKey)) {
        dedupe += 1;
        anchorKey = `${idToString(deriveAnchorId(id, hit.start))}#${dedupe}`;
      }
      usedAnchorIds.add(anchorKey);
      entries.push({
        anchor: createAnchor(
          asAnchorId(anchorKey),
          createAnchorSnapshot([hit.feature], store),
        ),
        start: hit.start,
        end: hit.end,
      });
      const key = `${hit.historyIndex}/${hit.entryIndex}`;
      const set = removals.get(key);
      if (set === undefined) removals.set(key, new Set([id]));
      else set.add(id);
    }
    if (entries.length === 0) continue;
    created.push({ featureId: id, series: { entries } });
    placeAfter.push(Math.min(...hits.map((h) => h.historyIndex)));
    materializedIds.push(id);
  }

  if (created.length === 0) return { histories, materializedIds: [] };

  // **起こした系列は写し元の歴史のすぐ後ろに置く**（末尾へ足さない）。歴史の並び順は
  // 意味を持つ: 時刻ごとに全系列の頂点を束ねるとき同じ id の頂点は後に来た方が勝ち、
  // 読み込みの修復で食い違う頂点を揃えるときは先に見えた方を正とする。末尾へ足すと
  // この勝ち負けが入れ替わり、起こしただけで「見える形」が変わる（重なりが隠れ、次の
  // 修復でまた現れて「新しい不整合」と読まれる ―― 性質検査 seed 36002 / 36004 が
  // 修復の不動点へ収束しなかった実際の仕組み）。写し元の位置に置けば、起こす前と後で
  // 束の見え方は変わらない。正常なデータでは頂点は食い違わないので、この並びは結果を
  // 変えない。
  const createdAfter = new Map<number, FeatureHistory[]>();
  created.forEach((history, i) => {
    const at = placeAfter[i] ?? histories.length - 1;
    const slot = createdAfter.get(at);
    if (slot === undefined) createdAfter.set(at, [history]);
    else slot.push(history);
  });

  const rebuilt: FeatureHistory[] = [];
  const pushCreatedAfter = (historyIndex: number): void => {
    for (const h of createdAfter.get(historyIndex) ?? []) rebuilt.push(h);
  };
  histories.forEach((history, historyIndex) => {
    let changed = false;
    const entries = history.series.entries.map((entry, entryIndex) => {
      const drop = removals.get(`${historyIndex}/${entryIndex}`);
      if (drop === undefined) return entry;
      const features = entry.anchor.snapshot.features.filter((f) => !drop.has(f.id));
      if (features.length === entry.anchor.snapshot.features.length) return entry;
      changed = true;
      const store = pruneVertexStore(entry.anchor.snapshot.vertices, features);
      return {
        anchor: createAnchor(entry.anchor.id, createAnchorSnapshot(features, store)),
        start: entry.start,
        end: entry.end,
      };
    });
    if (!changed) {
      rebuilt.push(history);
    } else if (entries.some((e) => e.anchor.snapshot.features.length > 0)) {
      rebuilt.push({ featureId: history.featureId, series: { entries } });
    }
    // （全部の錨が空になった歴史は落とす ―― 持ち主の居ない空の系列を残さない。
    // 落としても、そこから起こした系列はその位置に入る。）
    pushCreatedAfter(historyIndex);
  });

  return { histories: rebuilt, materializedIds };
}

/**
 * `at` の年から先で `featureIds` を最上位にする（parentId を外す）。まとめ役を
 * その年で終わらせたとき、子は道連れにならず最上位として続く（司令塔の決定 (2)）。
 * 呼ぶ前に {@link materializeOwnSeries} で自分の系列を起こしておくこと（居候のままだと
 * 書き込む先が親の錨になり、親が終わると一緒に消える）。
 *
 * - `at` に錨が無ければ `at` に錨を 1 本挿す（その時点の状態を引き継ぐ＝過去編集の作法）。
 * - `at` より後の錨からも parentId を外す（carry-forward が親を連れ戻さないように）。
 * - `at` より前の錨は触らない（終わる前は子のままだったという記録を残す）。
 */
export function promoteToTopLevelFrom(
  histories: readonly FeatureHistory[],
  featureIds: readonly FeatureId[],
  at: TimePoint,
  calendar: Calendar,
): readonly FeatureHistory[] {
  let next = histories;
  for (const id of featureIds) {
    const index = next.findIndex((h) => h.featureId === id);
    if (index < 0) continue;
    const history = next[index];
    if (history === undefined) continue;
    const edited = applyPastEdit(
      history.series,
      at,
      (effective): Anchor => {
        const base =
          effective.kind === 'present'
            ? effective.entry.anchor.snapshot
            : createAnchorSnapshot([], createVertexStore([]));
        const features = base.features.map((f) =>
          f.id === id ? withParentId(f, undefined) : f,
        );
        return createAnchor(
          deriveAnchorId(id, at),
          createAnchorSnapshot(features, base.vertices),
        );
      },
      calendar,
    );
    const entries = edited.entries.map((entry) => {
      if (compare(entry.start, at, calendar) <= 0) return entry;
      let touched = false;
      const features = entry.anchor.snapshot.features.map((f) => {
        if (f.id !== id) return f;
        if (f.parentId === undefined) return f;
        touched = true;
        return withParentId(f, undefined);
      });
      if (!touched) return entry;
      return {
        anchor: createAnchor(
          entry.anchor.id,
          createAnchorSnapshot(features, entry.anchor.snapshot.vertices),
        ),
        start: entry.start,
        end: entry.end,
      };
    });
    next = next.map((h, i) => (i === index ? { featureId: id, series: { entries } } : h));
  }
  return next;
}
