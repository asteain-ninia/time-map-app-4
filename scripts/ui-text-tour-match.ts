// 画面の巡回で書き出した文字と、文言の目録を突き合わせる（案/文言総点検-やり方の提案.md §2.3 の 2）。
//
// 出すもの:
//   (a) 目録にあるのに、巡回のどの場面にも出てこなかった見出し語（場面を足すか、本当に使われて
//       いないか）。ただし照合できないもの（1 文字の文・呼べなかった関数）と、巡回では写せない所
//       （OS のダイアログ・地図に描く文字）は別に分けて数える
//   (b) 画面に出ているのに、目録のどの文でも説明できない文字（表の外の取りこぼしの疑い）。
//       利用者のデータ（地物の名前・種別・詳細文書）は先に取り除く
//
// 核は純粋な関数（`matchTour`）。ファイルを読むのは `ui-text-tour-match-cli.ts`。

import type { Catalog, CatalogEntry } from './ui-text-catalog';
import { UI_TEXT_CHAR_CLASS } from './ui-text-rule.mjs';

/** 巡回の 1 場面で書き出したもの（`e2e/__tour__/ui-text-tour.spec.ts` が書く形）。 */
export interface TourScene {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly pageTitle?: string;
  readonly innerText?: string;
  readonly attributes?: readonly {
    readonly attr: string;
    readonly value: string;
    readonly tag: string;
    readonly testid: string | null;
  }[];
}

export type UnseenReason =
  /** 1 文字（「年」「・」など）。どの画面にも紛れて出るので照合しない。 */
  | 'short'
  /** 呼べなかった関数・文字列でない値（札入りの文が無い）。 */
  | 'unevaluable'
  /** 巡回では写せない所（OS のダイアログ・地図に描く文字・診断ログ）。 */
  | 'outside-tour'
  /** 照合できるのに、どの場面にも出てこなかった。 */
  | 'unseen';

export interface MatchResult {
  readonly scenes: { readonly total: number; readonly ok: number; readonly failed: readonly string[] };
  readonly entries: {
    readonly total: number;
    readonly seen: number;
    readonly short: number;
    readonly unevaluable: number;
    readonly outsideTour: number;
    readonly unseen: number;
  };
  /** (a) どの場面にも出てこなかった見出し語（理由つき。`seen` は含めない）。 */
  readonly notSeen: readonly { readonly id: string; readonly text: string | null; readonly reason: UnseenReason }[];
  /** (b) 目録で説明できなかった文字（同じ残りはまとめ、出た場面を並べる）。 */
  readonly uncovered: readonly {
    readonly remainder: string;
    readonly example: string;
    readonly source: string;
    readonly scenes: readonly string[];
  }[];
  /** 見出し語ごとに、出た場面（見本や型で当たったものも含む）。 */
  readonly seenIn: Readonly<Record<string, readonly string[]>>;
}

const JA = new RegExp(`[${UI_TEXT_CHAR_CLASS}]`, 'u');

/** 巡回で写せない所（参照元・置き場で決める）。 */
export function isOutsideTour(entry: CatalogEntry): boolean {
  if (entry.file.startsWith('src/shell/main/')) {
    // 本体側の文のうち、画面へ返して状態行に出るもの（保存の断り）は写せるが、巡回では
    // わざと壊した保存要求を作らない。本体側はまとめて「写せない」に入れる。
    return true;
  }
  if (entry.file.startsWith('src/render/')) return true;
  return false;
}

/** 空白の差を捨てる（innerText は改行・連続空白を含む）。 */
export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** かな・漢字（句読点・括弧・全角記号は含めない）。 */
const LETTER = new RegExp(
  `[${String.fromCharCode(0x3040)}-${String.fromCharCode(0x30ff)}${String.fromCharCode(0x3400)}-${String.fromCharCode(0x9fff)}]`,
  'gu',
);

/** かな・漢字の数（「「〔名前〕」」のように括弧だけの型は、何でも当たってしまうので照合に使わない）。 */
export function letterCount(s: string): number {
  return (s.match(LETTER) ?? []).length;
}

/** 関数の型から正規表現を作る（決まった文字のかな・漢字が 2 文字未満なら null＝照合しない）。 */
export function patternRegex(entry: CatalogEntry): RegExp | null {
  if (entry.pattern === null) return null;
  const fixed = entry.pattern.filter((p): p is string => typeof p === 'string').join('');
  if (letterCount(fixed) < 2) return null;
  const body = entry.pattern
    // 埋め込みは空でもよい（名前の無い地物は「」になる）
    .map((p) => (typeof p === 'string' ? escapeRe(normalize(p)).replace(/ /g, '\\s*') : '[\\s\\S]*?'))
    .join('');
  try {
    return new RegExp(body, 'g');
  } catch {
    return null;
  }
}

/** 見出し語を照合に使う文字列の並び（文・見本）。 */
function literalsOf(entry: CatalogEntry): string[] {
  const out: string[] = [];
  if (entry.kind === 'text' && entry.text !== null) out.push(entry.text);
  for (const s of entry.samples) out.push(s);
  return out.map(normalize).filter((s) => s.length > 0);
}

/** 場面の文字を、照合する単位（行・属性の値）に分ける。 */
function segmentsOf(scene: TourScene): { source: string; text: string }[] {
  const out: { source: string; text: string }[] = [];
  for (const line of (scene.innerText ?? '').split('\n')) {
    const t = normalize(line);
    if (t.length > 0) out.push({ source: 'text', text: t });
  }
  for (const a of scene.attributes ?? []) {
    const t = normalize(a.value);
    if (t.length > 0) out.push({ source: `${a.attr}${a.testid === null ? '' : `@${a.testid}`}`, text: t });
  }
  if (scene.pageTitle !== undefined && scene.pageTitle !== '') {
    out.push({ source: 'window-title', text: normalize(scene.pageTitle) });
  }
  return out;
}

export function matchTour(
  catalog: Catalog,
  scenes: readonly TourScene[],
  userWords: readonly string[],
): MatchResult {
  const okScenes = scenes.filter((s) => s.ok);
  const sceneTexts = okScenes.map((s) => ({
    id: s.id,
    all: normalize(
      [s.innerText ?? '', ...(s.attributes ?? []).map((a) => a.value), s.pageTitle ?? ''].join('\n'),
    ),
  }));

  // (a) 見出し語ごとに、出た場面
  const seenIn: Record<string, string[]> = {};
  const notSeen: { id: string; text: string | null; reason: UnseenReason }[] = [];
  let seen = 0;
  let short = 0;
  let unevaluable = 0;
  let outsideTour = 0;
  let unseen = 0;
  for (const entry of catalog.entries) {
    const literals = literalsOf(entry);
    const re = entry.kind === 'function' ? patternRegex(entry) : null;
    const where: string[] = [];
    for (const st of sceneTexts) {
      const hit =
        literals.some((l) => l.length >= 2 && st.all.includes(l)) ||
        (re !== null && new RegExp(re.source).test(st.all));
      if (hit) where.push(st.id);
    }
    if (where.length > 0) {
      seen += 1;
      seenIn[entry.id] = where;
      continue;
    }
    let reason: UnseenReason;
    if (isOutsideTour(entry)) reason = 'outside-tour';
    else if (entry.text === null && literals.length === 0) reason = 'unevaluable';
    else if (
      (entry.kind === 'text' && normalize(entry.text ?? '').length <= 1) ||
      (entry.kind === 'function' && re === null && literals.every((l) => l.length <= 1))
    ) {
      reason = 'short';
    } else reason = 'unseen';
    if (reason === 'outside-tour') outsideTour += 1;
    else if (reason === 'unevaluable') unevaluable += 1;
    else if (reason === 'short') short += 1;
    else unseen += 1;
    notSeen.push({ id: entry.id, text: entry.text, reason });
  }

  // (b) 目録で説明できない文字
  const words = [...new Set(userWords.map(normalize).filter((w) => w.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  // 1 行まるごとが 1 つの文・関数の型・利用者のデータの語に一致するなら、それで説明がつく
  // （「10年次へ進む」は、部分の「10年次へ」という別の文で削るより、関数の型 1 つで当てるのが正しい）。
  const literalSet = new Set(catalog.entries.flatMap((e) => literalsOf(e)));
  const wordSet = new Set(words);
  const fullRegexes: RegExp[] = [];
  // 目録の文と関数の型を、**決まった文字の多い順**に 1 つの並びで当てる。短い文（「保存」「次へ」）を
  // 先に取り除くと、それを含む長い文（「1200年の錨を上書き保存」）が崩れて当たらなくなる。
  type Remover = { readonly weight: number; readonly apply: (s: string) => string };
  const removers: Remover[] = [];
  for (const l of literalSet) {
    if (l.length < 2) continue;
    removers.push({ weight: l.length, apply: (s) => (s.includes(l) ? s.split(l).join(' ') : s) });
  }
  const addRegex = (r: RegExp, fixed: number): void => {
    fullRegexes.push(new RegExp(`^(?:${r.source})$`));
    removers.push({ weight: fixed, apply: (s) => s.replace(r, ' ') });
  };
  for (const e of catalog.entries) {
    if (e.kind === 'function') {
      const r = patternRegex(e);
      if (r !== null) {
        addRegex(r, normalize((e.pattern ?? []).filter((p): p is string => typeof p === 'string').join('')).length);
      }
    }
    // 呼べなかった関数・見本の作れない関数（数から文を組み立てる `railSpanNote` など）は、本体の中の
    // 文の型（〔…〕が埋め込み）から当てる
    for (const f of e.fragments) {
      if (!f.includes('〔')) continue;
      const parts = f.split(/〔[^〕]*〕/);
      const fixed = normalize(parts.join('')).length;
      if (letterCount(parts.join('')) < 2) continue;
      const body = parts.map((p) => escapeRe(normalize(p)).replace(/ /g, '\\s*')).join('[\\s\\S]*?');
      addRegex(new RegExp(body, 'g'), fixed);
    }
  }
  removers.sort((a, b) => b.weight - a.weight);
  // 利用者のデータの語は、3 文字以上を目録より先に、残りを目録のあとで取り除く（長い地名は
  // 目録の短い文「不明」「地物」に削られる前に、1〜2 文字の地名は目録の文を削らないように）。
  const longWords = words.filter((w) => [...w].length >= 3);
  const shortWords = words.filter((w) => [...w].length < 3);
  // 1 文字の文（「年」「月」「・」）は文の途中から取り除かない（「まだ目録に無い文」の「に」を
  // 消してしまう）。残りを空白で区切った 1 語ずつについて、英数字を除いた残りが 1 文字の文の
  // 文字だけでできていれば落とす（「1200年3月15日」→「年月日」→ 落とす）。
  const shortChars = new Set(
    catalog.entries.flatMap((e) => literalsOf(e)).filter((l) => [...l].length === 1),
  );
  const uncoveredMap = new Map<string, { remainder: string; example: string; source: string; scenes: Set<string> }>();
  for (const scene of okScenes) {
    for (const seg of segmentsOf(scene)) {
      if (!JA.test(seg.text)) continue;
      if (literalSet.has(seg.text) || wordSet.has(seg.text) || fullRegexes.some((r) => r.test(seg.text))) {
        continue;
      }
      let rest = seg.text;
      for (const w of longWords) if (rest.includes(w)) rest = rest.split(w).join(' ');
      for (const rm of removers) rest = rm.apply(rest);
      for (const w of shortWords) if (rest.includes(w)) rest = rest.split(w).join(' ');
      rest = normalize(
        normalize(rest)
          .split(' ')
          .filter((token) => {
            const core = token.replace(/[\x20-\x7e]/g, '');
            // かな・漢字を 1 つも含まない語（括弧・記号だけ）も落とす
            return letterCount(core) > 0 && ![...core].every((ch) => shortChars.has(ch));
          })
          .join(' '),
      );
      if (letterCount(rest) === 0) continue;
      const cur = uncoveredMap.get(rest) ?? { remainder: rest, example: seg.text, source: seg.source, scenes: new Set<string>() };
      cur.scenes.add(scene.id);
      uncoveredMap.set(rest, cur);
    }
  }
  const uncovered = [...uncoveredMap.values()]
    .map((u) => ({ remainder: u.remainder, example: u.example, source: u.source, scenes: [...u.scenes] }))
    .sort((a, b) => b.scenes.length - a.scenes.length || a.remainder.localeCompare(b.remainder, 'ja'));

  return {
    scenes: {
      total: scenes.length,
      ok: okScenes.length,
      failed: scenes.filter((s) => !s.ok).map((s) => `${s.id}: ${s.error ?? ''}`),
    },
    entries: { total: catalog.entries.length, seen, short, unevaluable, outsideTour, unseen },
    notSeen,
    uncovered,
    seenIn,
  };
}

/** 突き合わせの結果を、人が読む形にする。 */
export function renderMatchMarkdown(result: MatchResult, scenes: readonly TourScene[]): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '⏎');
  const lines: string[] = [];
  const e = result.entries;
  lines.push('# 巡回と目録の突き合わせ');
  lines.push('');
  lines.push(
    `場面 ${result.scenes.ok} / ${result.scenes.total}（作れなかった場面 ${result.scenes.failed.length}）。` +
      `見出し語 ${e.total} 件のうち、巡回で出た ${e.seen}・出なかった ${e.unseen}・` +
      `1 文字で照合しない ${e.short}・呼べず照合できない ${e.unevaluable}・巡回では写せない所 ${e.outsideTour}。` +
      `目録で説明できない文字 ${result.uncovered.length} 種類。`,
  );
  lines.push('');
  lines.push('## 場面');
  lines.push('');
  for (const s of scenes) lines.push(`- ${s.id} ${s.title}${s.ok ? '' : `（作れなかった: ${s.error ?? ''}）`}`);
  lines.push('');
  lines.push('## (b) 画面に出ているのに目録で説明できない文字（表の外の取りこぼしの疑い）');
  lines.push('');
  lines.push('| 残った文字 | 元の文 | どこ | 場面 |');
  lines.push('| --- | --- | --- | --- |');
  for (const u of result.uncovered) {
    lines.push(`| ${cell(u.remainder)} | ${cell(u.example)} | ${cell(u.source)} | ${u.scenes.join(' ')} |`);
  }
  lines.push('');
  lines.push('## (a) 目録にあるのに巡回のどの場面にも出なかった見出し語');
  lines.push('');
  for (const reason of ['unseen', 'short', 'unevaluable', 'outside-tour'] as const) {
    const list = result.notSeen.filter((n) => n.reason === reason);
    const title = {
      unseen: '照合できるのに出なかった（場面を足すか、使われていないかを確かめる）',
      short: '1 文字なので照合しない',
      unevaluable: '呼べなかった関数・文字列でない値',
      'outside-tour': '巡回では写せない所（OS のダイアログ・本体側の断り・地図に描く文字）',
    }[reason];
    lines.push(`### ${title}（${list.length} 件）`);
    lines.push('');
    for (const n of list) lines.push(`- \`${n.id}\` ${cell(n.text ?? '')}`);
    lines.push('');
  }
  return lines.join('\n');
}
