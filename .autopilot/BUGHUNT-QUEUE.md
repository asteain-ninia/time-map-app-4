# 非ナイフ・バグ狩り 確定キュー (2026-06-24, 31エージェント workflow / 敵対的検証済)

## ✅ 全18件 決着済 (2026-06-24) — 17修正 + 1偽陽性

| 領域 | 解決 | コミット/根拠 |
| --- | --- | --- |
| merge vertexRemap データ欠損 | 修正(test-first) | 750a673 |
| file-ops auto-save未購読 + baseMapImage 0バイト | 修正 | 11130c5 |
| HB3-12 存続期間: changeStart/setEnd/deleteAnchor 未配線 + startYear/endYear cosmetic | 修正(機能実装+E2E) | 278dba6 |
| reparent: parentNone確定UI欠落 / vertexStore形状チェックskip / 拒否後pick stale-closure | 修正×3 | 5283f4f |
| anchor-timeline: AnchorTimeBar軸スパン崩壊 / AnchorSectionキー再マウント | 修正×2 | 3a99071 |
| conflict: 拒否フェーズ行き止まり | 修正 | 9b84f2d |
| conflict: ミニマップ再ラウンド陳腐化 | 修正 | c0fe41a |
| FR-52 マージ親/属性継承ダイアログ欠落 | 実装(+E2E) | 20395e3 |
| undo後dirty残存 / withLimit(FR-74)未配線 | 修正×2 | 70cdd58 |
| **#4 reparent競合の nextVertexId/nextRingId 未配線** | **偽陽性** | reparentはleaf形状不変→terminal-overlap検出が不変→mintを要するoverlap-trim解決に到達しない。修正案の`ids.nextVertexId`も該当スコープにidsなしで誤り(c0fe41a 調査報告) |

チェックポイント: フル vitest **2992 passed** / e2e **74 passed** / typecheck=0 / lint=0（デグレなし）。各修正は敵対的検証(別subagent)で REAL を確認してから着手。

## ✅ 第2次バグハント — 5件確定・全修正 (2026-06-24, 29エージェント・到達性証明検証)

新領域×正確性/エッジ角度。候補21件中5件を確定（reachable を必須化＝#4型偽陽性を防ぐため、16件 refute）。

| 領域 | バグ | 解決 |
| --- | --- | --- |
| persistence | `geoParamsSchema` が退化測地(equatorKm≤0/flattening≥1)を素通り→全面積/距離が無言で0 [HIGH] | superRefine で reject (cdb7f7f) |
| vtransform/pan | zoomAtCursor/panCameraTo が centerLat を±90クランプせず→極でズーム/パンすると画面が永久に真っ白 | `clampLat` 追加 (cdb7f7f) |
| time/anchor | `setEnd` が次アンカーへ食い込む終了を ok:true で黙って改変 [data-loss] | ガード厳格化＝次の開始へ到達したら reject (aff36d7) |
| history/store | undo-dirty の clean/dirty 基準が設定変更を無視 ×2(applyUndoRedoResult + savedベースライン) | saved ベースラインに設定を含める (f6d00ae) |

後3件は今セッション新コード(HB3-12 setEnd / P1 undo-dirty)のエッジを自己検出。チェックポイント: フル vitest 緑 + build + knife-nway スモーク緑。

---

（以下は当初の確定リスト原文。各行の解決状況は上表を参照。）

候補23件中 **18件を確定**(各候補を別エージェントが refute 試行→残存のみ)。重大度順。

> 出典 workflow: wou5lpqkk。

## 1. [HIGH/data-loss] applyMergeProposal discards vertexRemap — shared boundary vertices become dangling after leaf-only merge
- 領域: merge-weld
- 箇所: `src/domain/editing/apply-proposal.ts:839`
- 内容: applySplitProposal calls applyVertexRemapToHistories (step 3, line 365) to repoint neighbour features whose boundary vertices were re-minted during the split. applyMergeProposal (line 839) performs no equivalent step: it writes mergeVertices to every touched history but never walks the rest of the histories to repoint the old vertex IDs in neighbouring features. A leaf-only merge produces a non-em
- 再現: 1. Add two adjacent leaf features A and B sharing a boundary edge (both reference the same VertexId on the shared edge). 2. Add a third leaf C that also shares the same boundary vertex on that edge. 3. Select A and B and confirm merge. 4. Inspect C's ring: the shared VertexId that was on A/B's bound
- 検証: The bug is real. Evidence:  1. `MergeSnapshot.vertexRemap` is a non-empty `VertexRemap` for every leaf-only merge (`src/domain/merge/proposal.ts:628` — `buildRemap` is called and the result assigned; property test at `src/domain/__bughunt__/split-merge-knife-geometry.property.test.ts:4786` asserts `
- 修正案: In `applyMergeProposal` (`src/domain/editing/apply-proposal.ts`), add a step 4 after creating the result feature (after line 889, before `return withHistories`): `histories = applyVertexRemapToHistories(histories, snapshot.vertexRemap, mergeVertices, anchorTime, calendar);` — exactly mirroring the split path at line 365.

## 2. [HIGH/wiring-gap] changeStart / setEnd / deleteAnchor have no UI caller (教訓5.7 wiring gap)
- 領域: existence-period (HB3-12): anchor-series lifespan / appear-disappear
- 箇所: `src/domain/anchor-series.ts:494`
- 内容: The three domain operations that edit an anchor's existence interval — changeStart (line 494), setEnd (line 540), and deleteAnchor (line 616) — are fully implemented, tested, and re-exported from the barrel (domain/index.ts:155-157). However, a search across every file in src/ui/ and src/domain/command/ finds zero callers. There is no Command subclass, no dispatch path, no property-panel button, a
- 再現: Open any project with a feature that has a bounded existence (entry.end !== null). Switch the property panel to the time-bar view. No drag handle, input field, or button exists to extend, shorten, or delete the bar. Calling changeStart / setEnd programmatically in a test confirms the domain logic wo
- 検証: Exhaustive search across every .ts/.tsx file in src/ confirms zero callers of changeStart, setEnd, or deleteAnchor outside of test files. The domain functions are fully implemented at anchor-series.ts:494/540/616 and re-exported via domain/index.ts:155-157, but no Command subclass, no COMMAND_ID ent
- 修正案: Add a changeStart/setEnd/deleteAnchor sub-panel to AnchorSection (or expose edit inputs in AnchorList rows), extend PropertyEditIntent or create a new AnchorIntervalEditIntent, add the corresponding COMMAND_ID entries and Command subclasses, and wire dispatch through EditDispatch so saves reach the domain functions.

## 3. [HIGH/wiring-gap] BasicAttributes.startYear / endYear are cosmetic-only; editing them via the property panel does NOT change feature visibility on the time axis
- 領域: existence-period (HB3-12): anchor-series lifespan / appear-disappear
- 箇所: `src/ui/property/contracts.ts:83`
- 内容: PropertyEditIntent.attributes carries startYear and endYear (from BasicAttributes, src/domain/attributes.ts:14). These are plain display scalars with no connection to the anchor series interval (AnchorEntry.start / AnchorEntry.end). When the user types a new start/end year in the BasicInfoForm and saves, the intent flows through editDispatch.dispatchEdit → applyPastEdit, which updates the anchor's
- 再現: Select a feature. In the property panel, change startYear from 0 to 500 and save. Drag the timeline slider to year 200. The feature is still visible (its AnchorEntry.start is still year 0). The DetailPanel shows 500年 as the start year but the time-bar still draws the bar from year 0. The two represe
- 検証: The wiring gap is real and confirmed at c:/!WORKSPACE/time-map-app/time-map-app-4/src/ui/App.tsx lines 1644-1683. The `propertyEditDispatch.dispatchEdit` handler builds a new feature with `createBasicAttributes(v.name, v.startYear, v.endYear)` and packages it as a `FeatureSnapshot`, which flows thro
- 修正案: In `propertyEditDispatch.dispatchEdit` (App.tsx ~line 1668), after building the proposal, also call `changeStart(series, anchorId, { granularity: 'year', year: v.startYear }, calendar)` and `setEnd(series, anchorId, v.endYear === some_sentinel ? null : { granularity: 'year', year: v.endYear }, calendar)` on the target anchor's series — or, simpler, make startYear/endYear in `BasicAttributes` and `

## 4. [HIGH/wiring-gap] Reparent (affiliation) conflicts are permanently unresolvable: nextVertexId / nextRingId not wired
- 領域: conflict-resolution
- 箇所: `src/ui/App.tsx:2561`
- 内容: createReparentBootstrap calls createLiveAffiliationBinding({ getRoot }) — passing only the mandatory getRoot, leaving nextVertexId and nextRingId as undefined (DomainRootAccess declares them optional). In applyResolutionAt (consistency-binding.ts:418-458), the very first guard is `if (nextVertexId === undefined || nextRingId === undefined) return undefined;` (line 425). This means the U06 write-ba
- 再現: 1. Have two overlapping leaf features A and B. 2. Use the reparent (所属変更) tool to reparent A or B into a new parent aggregate. 3. If the reparent produces spatial overlap (it can, since reparent runs detectSpatialAt which fires the real U10 detector via bindPortsToProposal), the conflict modal opens
- 検証: The wiring gap is real and confirmed at multiple levels. App.tsx:2561 calls `createLiveAffiliationBinding({ getRoot })` omitting `nextVertexId` and `nextRingId`. In `bindPortsToProposal` (consistency-binding.ts:537-541), both `startProcess` and `applyResolutionsFor` override `applyResolution` with `
- 修正案: In App.tsx:2561, change `createLiveAffiliationBinding({ getRoot })` to `createLiveAffiliationBinding({ getRoot, nextVertexId: ids.nextVertexId, nextRingId: ids.nextRingId })`, using the same shared `ids` object supplied to the merge/knife bootstraps.

## 5. [HIGH/wiring-gap] Auto-save tick never subscribed — auto-save silently never fires
- 領域: file-ops (.tmap save/load pipeline)
- 箇所: `src/ui/file-ops/FileOpsController.tsx:141`
- 内容: The IPC contract declares `onAutoSaveTick` (subscribe) and `configureAutoSave` (push interval/cap) on `TimeMapApi`. The main process fires `IPC_CHANNEL.AutoSaveTick` on a timer (shell/main/index.ts:170). The preload correctly exposes both methods. But `FileOpsController.tsx` — the only UI component that holds a live `api` reference — never calls `api.onAutoSaveTick(...)` or `api.configureAutoSave(
- 再現: 1. Open the app, create any feature, do NOT manually save. 2. Wait for the configured auto-save interval (default fires from main/index.ts scheduler). 3. Kill the app without saving. 4. Observe: no auto-saved .tmap file is written because the renderer never called api.save() in response to the tick.
- 検証: The wiring gap is real and unambiguous. The main process scheduler fires `target.webContents.send(IPC_CHANNEL.AutoSaveTick)` on a timer (src/shell/main/index.ts:165-172). The preload exposes `onAutoSaveTick` correctly (src/shell/preload/index.ts:45-53). But a grep of the entire `src/ui` directory fo
- 修正案: In `FileOpsController.tsx`, add a `useEffect` that subscribes to the tick: `useEffect(() => { if (api === null || ports === null) return; return api.onAutoSaveTick(() => { void saveCommand(ports, needsSaveAs(contextRef.current)); }); }, [api, ports]);`

## 6. [HIGH/data-loss] baseMapImage always written as zero bytes — map image permanently lost on first save
- 領域: file-ops (.tmap save/load pipeline)
- 箇所: `src/ui/file-ops/FileOpsController.tsx:240`
- 内容: `buildSaveRequest()` always constructs `{ ..., baseMapImage: new Uint8Array(), attachments: [] }`. The comment acknowledges this ('until those are live-bound the request ships none'), but the live-binding never happens — there is no code path that populates these fields from the rendered/loaded image. As a result every .tmap ZIP written by the app contains a zero-byte `assets/basemap.img` entry. `
- 再現: 1. Open the app, load a .tmap file that contains a real base-map image. 2. Ctrl+S (save). 3. Inspect the saved .tmap with any ZIP tool: `assets/basemap.img` has 0 bytes. 4. Re-open the saved file: the map background is blank.
- 検証: The bug is real and complete. Three independent gaps combine to make it irreversible:  1. `FileOpsController.tsx:240` hardcodes `baseMapImage: new Uint8Array()` in every `buildSaveRequest()` call. The surrounding comment acknowledges this as intentional ("until those are live-bound") but the live-bi
- 修正案: Add a `loadedAssetsRef = useRef<{ baseMapImage: Uint8Array; attachments: NamedAsset[] } | null>(null)` in `FileOpsController`. In `reflectProject` (or after a successful load in `bridge.ts`), capture `response.baseMapImage` and `response.attachments` into that ref. In `buildSaveRequest`, read from the ref instead of using `new Uint8Array()`. This requires threading the raw `LoadResponse` assets th

## 7. [HIGH/wiring-gap] deleteAnchor / changeStart / setEnd have zero UI callers — per-anchor temporal mutations are permanently unreachable
- 領域: anchor-timeline
- 箇所: `src/domain/anchor-series.ts:616`
- 内容: The domain exports three per-anchor mutation functions: deleteAnchor (line 616), changeStart (line 494), and setEnd (line 540). A search of the entire src/ui tree returns zero hits for these names — no component, hook, or command factory ever calls them. AnchorList and AnchorTimeBar render anchor rows with click-to-select only; the AnchorSection has no 'Delete this anchor', 'Move start time', or '
- 再現: Open any feature. Create a second anchor by using the save button at a time when no anchor starts (applyPastEdit inserts a new anchor). Open the property panel → Anchor section → List view. Observe there is no 'Delete anchor' button or start/end time editor on any anchor row — only click-to-select i
- 検証: All three domain functions (deleteAnchor at src/domain/anchor-series.ts:616, changeStart at :494, setEnd at :540) are exported from src/domain/index.ts but produce zero hits when grepped across the entire src/ui tree. AnchorList.tsx and AnchorTimeBar.tsx both wire only an onClick→onSelectAnchor per 
- 修正案: Add an onDeleteAnchor / onChangeAnchorStart / onSetAnchorEnd prop to AnchorSection (and through to AnchorList/AnchorTimeBar), wire per-row delete and time-edit controls, and add corresponding PropertyEditIntent variants (or a separate AnchorMutationIntent port) that App.tsx dispatches through a new recordAnchorMutation path calling deleteAnchor / changeStart / setEnd and committing the result as a

## 8. [MEDIUM/wiring-gap] allowedMergeParentCandidates and propertyInheritCandidates have no UI caller — FR-52 parent/property dialog missing (教訓5.7)
- 領域: merge-weld
- 箇所: `src/ui/merge/useMergeTool.ts:215`
- 内容: The domain barrel (src/domain/merge/index.ts lines 38-39) exports allowedMergeParentCandidates and propertyInheritCandidates, fully unit-tested in candidates.ts / merge.test.ts. FR-52 requires the user to be able to choose the parent region and property inheritance source before confirming a merge. The UI confirm() path (useMergeTool.ts line 215-216) unconditionally hardcodes parentDecision: paren
- 再現: Invoke allowedMergeParentCandidates or propertyInheritCandidates anywhere in src/ui — grep returns zero matches. The confirm() function in useMergeTool.ts contains no branch for user-selected parent or property; the result feature is always placed at the top level and always inherits the first selec
- 検証: All evidence confirms the wiring gap is real. Zero UI callers of allowedMergeParentCandidates or propertyInheritCandidates exist anywhere in src/ui/ (grep returns no matches). The src/ui/merge/ directory contains no dialog, picker, or modal component. useMergeTool.ts:215-216 unconditionally hardcode
- 修正案: Add a MergeOptionsDialog component in src/ui/merge/ that calls allowedMergeParentCandidates and propertyInheritCandidates, presents the 3-way parent picker and 2-way property picker, then passes the resolved ParentDecision and PropertyDecision into useMergeTool's confirm() (which must be refactored to accept or stage these decisions instead of hardcoding parentNone / propertyInherit(first)).

## 9. [MEDIUM/ux] AnchorTimeBar initialView computes open-ended max as last.start.year + 1, collapsing the axis when the last entry's start has a late month/day
- 領域: existence-period (HB3-12): anchor-series lifespan / appear-disappear
- 箇所: `src/ui/property/AnchorTimeBar.tsx:63`
- 内容: When the last anchor entry is open-ended (end === null), initialView falls back to { granularity: 'year', year: last.start.year + 1 } as the view maximum (line 63). This only increments the YEAR component of the start TimePoint. For a start with granularity 'yearMonthDay' and month/day near year-end (e.g. year 200, month 12, day 31), the resulting max is year 201 — normalize maps it to Jan 1 of ye
- 再現: Create a feature with a single open-ended anchor whose start is timePointYearMonthDay(200, 12, 31). Open the property panel's time-bar view. The axis labels read '200年12月31日' … '201年1月1日' and the single bar fills the full axis width — 480 px for a one-day span — making the time-bar useless as a navi
- 検証: The defect is real. Line 63 of `src/ui/property/AnchorTimeBar.tsx` computes the open-ended fallback max as `{ granularity: 'year', year: last.start.year + 1 }`. In `normalize()` (normalized.ts:105), the `complete()` function resolves a `granularity: 'year'` TimePoint to month=1, day=1 (DEFAULT_MONTH
- 修正案: Replace the fallback with one that normalizes `last.start` and adds ~365 days of headroom regardless of granularity: e.g. `const max = last.end ?? (() => { const n = normalize(last.start, calendar) as number; return denormalize((n + 366) as Normalized, calendar); // yields a full year past start })()` converted back to a TimePoint — or simply use `{ granularity: 'year', year: last.start.year + 2 }

## 10. [MEDIUM/wiring-gap] parentNone (make-top-level / detach) decision is fully wired in the domain but has no UI entry point in the reparent tool
- 領域: reparent (HB3-15 所属変更 / U28 / FR-46〜FR-49)
- 箇所: `src/ui/reparent/useReparentTool.ts:211`
- 内容: The domain supports three `ParentDecision` variants: `existing`, `none` (detach/make-top-level, FR-46), and `create`. `buildAffiliationProposal` with `parentNone` is exercised in tests and property tests (affiliation.test.ts:136, hierarchy-parent-aggregate-affiliation.property.test.ts:431). The reparent hook's `confirm()` hardcodes `parentExisting(newParentId)` and requires `newParentId !== null` 
- 再現: 1. Load a project where a leaf feature has a parent aggregate. 2. Select the 所属変更 tool. 3. Click the nested leaf to pick it as the target. 4. Observe: there is no way to confirm without picking a second feature as the new parent. The 確定 button remains disabled and there is no '親なし（最上位化）' option anyw
- 検証: The wiring gap is real and manifests for any user trying to detach a child feature to top-level via the 所属変更 tool. Evidence: (1) `canConfirm` at useReparentTool.ts:190-197 returns false when `newParentId === null` — no alternate branch exists. (2) `confirm()` at useReparentTool.ts:199-200 has an ear
- 修正案: In useReparentTool.ts: add `canConfirmNone: targetId !== null` to state and a `confirmNone` callback that calls `buildAffiliationProposal(features, targetId, parentNone, { idState, now })` (mirrors `confirm` but skips the `newParentId` guard and passes `parentNone`). In ReparentToolController.tsx: add a "親なし（最上位化）" button enabled by `canConfirmNone` that calls `reparent.confirmNone()`. In strings.

## 11. [MEDIUM/correctness] buildAffiliationProposal called without vertexStore, so the post-reparent shape-gap check (checkAggregateShapes) is always silently skipped
- 領域: reparent (HB3-15 所属変更 / U28 / FR-46〜FR-49)
- 箇所: `src/ui/reparent/useReparentTool.ts:211`
- 内容: `buildAffiliationProposal` accepts an optional `vertexStore` in its `BuildProposalOptions`; when provided, `validateHierarchy` (called at the end of `buildProposalForLeaves`) runs `checkAggregateShapes`, which detects inter-child gaps violating FR-35 '隙間なし'. Without it, only topological checks (cycles, dangling parents, childParentMismatch) run. The live confirm call in `useReparentTool.confirm` p
- 再現: 1. Build a hierarchy where aggregate A has two touching leaves L1 and L2 that together tile A's territory. 2. Use the reparent tool to move L1 to a different parent B. 3. The confirm succeeds even though A now has only L2, which no longer covers A's full extent — a gap exists between L2 and the old 
- 検証: The wiring gap is real and unambiguous across four files:  1. `src/ui/reparent/useReparentTool.ts:211` — `buildAffiliationProposal` is called with `{ idState: createIdGeneratorState(), now: () => Date.now() }` only. No `vertexStore` is passed.  2. `src/ui/reparent/useReparentTool.ts:61-72` — `UseRep
- 修正案: Add `resolveStore: ResolveVertexStore` to `UseReparentToolOptions` and `ReparentBootstrap`, supply it from `createReparentBootstrap` via `verticesAt(getRoot(), getTime())` (mirroring the knife bootstrap), then pass `vertexStore: resolveStore()` in the `confirm` callback's `buildAffiliationProposal` options at `useReparentTool.ts:214`.

## 12. [MEDIUM/ux] Rejected phase is a dead-end: user cannot retry with new choices
- 領域: conflict-resolution
- 箇所: `src/ui/conflict/useConflictResolution.ts:141`
- 内容: When U13 returns Rejected (e.g. U06 difference produces an empty geometry because the adjust feature is fully covered, or a ConstraintViolation), the hook transitions to MODAL_PHASE.Rejected and clears all drafts. The `apply()` function is hard-gated at line 141 with `if (phase !== MODAL_PHASE.Resolving) return;` and `canApply` requires `phase === MODAL_PHASE.Resolving` (line 188-191). `choosePrio
- 再現: 1. Create two overlapping terminal features where one completely covers the other. 2. Attempt to add or edit a feature that produces this overlap. 3. In the conflict modal, pick the smaller feature as 'priority' (the larger is the adjust target). 4. Click Apply — U06 difference produces an empty Mul
- 検証: The dead-end is real and fully confirmed. In useConflictResolution.ts lines 166-177, PROCESS_STATUS.Rejected sets phase to MODAL_PHASE.Rejected and clears drafts. The apply() gate at line 141 (`if (phase !== MODAL_PHASE.Resolving) return`) and canApply at lines 188-191 (`phase === MODAL_PHASE.Resolv
- 修正案: In useConflictResolution.ts, either: (a) add a `resetToResolving()` action that calls setPhase(MODAL_PHASE.Resolving) without invoking onCancel, and expose a "選択し直す" button in the Rejected banner in ConflictResolutionModal.tsx; or (b) simpler — guard choosePriority so that when called while phase === MODAL_PHASE.Rejected it also calls setPhase(MODAL_PHASE.Resolving), so the first radio click after

## 13. [MEDIUM/ux] Minimap preview geometry is stale on re-conflict rounds: shows pre-resolution shapes
- 領域: conflict-resolution
- 箇所: `src/ui/App.tsx:1496`
- 内容: The shapesFor callback (App.tsx:1496-1504) reads store.getState().domain — the COMMITTED domain root — to build the conflict preview shapes. The committed root never changes during conflict resolution (U13 is pure; nothing is committed until the final Apply succeeds). On a re-conflict round (ConflictsPending returned from Apply), the new conflict list may contain conflicts involving a feature whos
- 再現: 1. Create three features A, B, C where A overlaps B and B overlaps C (A and C do not overlap). 2. Trigger an edit that surfaces the A-B and B-C conflicts simultaneously (or sequentially through re-conflict). 3. In round 1, resolve A-B (priority A, trim B). 4. Apply returns ConflictsPending with the 
- 検証: The bug is real. `shapesFor` (App.tsx:1496-1504) calls `shapeForConflictParticipant(store.getState().domain, ...)` which reads `leafShapeAt` from the committed store root. The committed root is never updated during conflict resolution: `createAccumulatingApply` (consistency-binding.ts:599-603) calls
- 修正案: Pass the trial-state root returned alongside each `ConflictsPending` result (extend `ConflictsPendingResult` to carry the intermediate trial state as an optional field), then thread it into `shapesFor` so it reads from the trial state when available — or alternatively, have `shapesFor` accept and prefer the trial-state root when one is stored in `conflictState`.

## 14. [MEDIUM/ux] AnchorTimeBar initialView: open-ended last entry with a yearMonthDay start produces a near-zero or 1-day axis span, pinning view at the minimum zoom floor
- 領域: anchor-timeline
- 箇所: `src/ui/property/AnchorTimeBar.tsx:63`
- 内容: In AnchorTimeBar.initialView (line 63), when the last entry's end is null the fallback max is constructed as { granularity: 'year', year: last.start.year + 1 }. This always produces at most one calendar year of axis span, ignoring the month/day of last.start. For a series whose last anchor starts at a yearMonthDay time such as 1600-12-31, the max becomes the year-granularity point { year: 1601 } w
- 再現: Create a feature. Its anchor series begins with a single open-ended anchor whose start TimePoint has yearMonthDay granularity and a late-year date, e.g. year=1600 month=12 day=31 (achievable by creating a feature and doing a save at that date). Open the property panel, switch to TimeBar view. The ed
- 検証: The defect is real. In `AnchorTimeBar.tsx:63`, when `last.end` is null the fallback max is `{ granularity: 'year', year: last.start.year + 1 }`. `normalize` calls `complete()` on a `'year'`-granularity point which fills month=1, day=1 (DEFAULT_MONTH/DEFAULT_DAY in `time-point.ts:38-39`). So for `las
- 修正案: In `initialView` (AnchorTimeBar.tsx:63), after computing `max`, enforce a minimum span: e.g. `const seriesSpan = Math.max(365, normalize(max, calendar) - normalize(first.start, calendar)); const paddedMax = denormalize((normalize(first.start, calendar) + seriesSpan) as Normalized, calendar)` — or more simply, cap `max` to be at least one full calendar year from `first.start` rather than just `last

## 15. [MEDIUM/correctness] undo/redo sets projectDirty=true unconditionally, making a fully-undone project look dirty
- 領域: undo-redo
- 箇所: `src/ui/state/store.ts:631`
- 内容: applyCommandResult always writes `projectDirty: true` in its set() call (store.ts:631). Both runUndo (App.tsx:1238) and runRedo (App.tsx:1246) call applyCommandResult to reflect the new state, so every undo and redo step unconditionally marks the project dirty. A user who makes N edits then hits Ctrl+Z N times has returned to the exact saved baseline, but the unsaved-changes guard (FR-107) will st
- 再現: 1. Open a project (projectDirty becomes false). 2. Add one feature (projectDirty becomes true). 3. Undo (Ctrl+Z) — the domain is restored to the post-load root, but projectDirty stays true. 4. Attempt to open a new project: the unsaved-changes dialog appears even though no unsaved change exists.
- 検証: The bug is real. `applyCommandResult` at store.ts:631 unconditionally writes `projectDirty: true` on every call. Both `runUndo` (App.tsx:1238) and `runRedo` (App.tsx:1246) call it with no override. The only mechanisms that clear `projectDirty` are: `markProjectSaved` (called only from `markClean` in
- 修正案: In `runUndo` (App.tsx:1238), after calling `applyCommandResult`, compare `step.history.state` to the domain reference in `savedSnapshotRef.current` (needs to be exposed or passed down). If they match (and both settings slices also match), call `store.getState().markProjectSaved()`. Alternatively, expose a `savedDomainRef` from FileOpsController to App via a callback, or add a `canClearDirty` optio

## 16. [LOW/ux] pick() callback captures targetId via stale closure when flow is in Rejected or ConflictPaused state, causing the first click after a rejection to be treated as a new-parent pick rather than a new-target pick
- 領域: reparent (HB3-15 所属変更 / U28 / FR-46〜FR-49)
- 箇所: `src/ui/reparent/useReparentTool.ts:166`
- 内容: After `setFlow(REPARENT_FLOW.Rejected)` the hook holds `targetId` (non-null) and `flow === 'rejected'`. A subsequent map click enters `pick()`. The `setFlow` updater function checks `f === REPARENT_FLOW.Idle` (false), then checks `targetId === null` (false — the stale captured value), so it falls through to `setNewParentId(featureId)` — treating the click as a new-parent pick even though the user 
- 再現: 1. Arm the reparent tool. 2. Click feature A (target picked, flow = PickParent). 3. Click feature A again (same-id toggle, clears target, flow = PickTarget). 4. Click feature B (target = B, flow = PickParent). 5. Click feature B again as new parent — this is the same ID as target, so the same-id bra
- 検証: The bug is real. In useReparentTool.ts lines 166-184, pick() uses a stale-closure read of `targetId` inside the `setFlow` functional updater. After confirm() rejects (lines 215-218 or 233-235), `setFlow(REPARENT_FLOW.Rejected)` is called but `targetId` and `newParentId` are never cleared — they rema
- 修正案: In pick()'s setFlow updater, after the Idle guard, add: `if (f === REPARENT_FLOW.Rejected || f === REPARENT_FLOW.ConflictPaused) { setTargetId(null); setNewParentId(null); setTargetId(featureId); return REPARENT_FLOW.PickParent; }` — OR, simpler, have confirm()'s rejection branches call `reset(REPARENT_FLOW.Rejected)` instead of only `setFlow(REPARENT_FLOW.Rejected)`, so that targetId/newParentId 

## 17. [LOW/wiring-gap] AnchorSection view-mode state is documented as 'reset via keyed remount upstream' but PropertyPanel mounts it without a key prop — stale List/TimeBar mode persists across feature switches
- 領域: anchor-timeline
- 箇所: `src/ui/property/AnchorSection.tsx:39`
- 内容: AnchorSection.tsx line 39 initialises local useState<AnchorViewMode> and the component's own comment says 'The switch state is local UI state (transient, reset on selection change via the keyed remount upstream)'. However, PropertyPanel.tsx line 206 mounts <AnchorSection> with no key prop. React reconciles by position in the tree so when the user selects a different feature the same AnchorSection 
- 再現: Select any feature in the property panel. Click the 'TimeBar' button in the anchor section header to switch from the default List view. Now select a different feature on the map or in the feature list. Observe that the anchor section for the new feature immediately opens in TimeBar mode instead of r
- 検証: The wiring gap is real. AnchorSection.tsx:39 initialises `useState<AnchorViewMode>` with no mechanism to reset it when the parent's target feature changes. PropertyPanel.tsx:205-212 mounts `<AnchorSection>` with no `key` prop, so React reuses the same component instance across feature switches, keep
- 修正案: Add `key={targetFeatureId ?? 'none'}` to the `&lt;AnchorSection&gt;` element at PropertyPanel.tsx:206, i.e. `&lt;AnchorSection key={targetFeatureId ?? 'none'} series={series} ...&gt;`. This forces React to unmount and remount AnchorSection on every feature change, discarding the stale mode state — exactly what the comment in AnchorSection.tsx anticipates.

## 18. [LOW/wiring-gap] withLimit (FR-74 configurable undo depth) has no UI caller — history limit is permanently fixed at 100
- 領域: undo-redo
- 箇所: `src/domain/command/history.ts:162`
- 内容: FR-74 explicitly states the undo-stack depth limit is '設定で変更可能' (user-configurable). The domain exposes withLimit() (history.ts:162) which re-roots the history with a new depth and trims excess entries. However: (a) there is no 'undoStackSize' (or equivalent) key in ProjectSettings or AppSettings (settings.ts:98-113); (b) the UI never imports or calls withLimit anywhere; (c) the history is always 
- 再現: Domain function that has no UI caller: domain/command/history.ts withLimit(). Check that no file in src/ui imports or invokes it (confirmed by grep).
- 検証: The wiring gap is real and confirmed by three independent checks. (1) `withLimit` is defined at src/domain/command/history.ts:166 with FR-74 noted in its JSDoc, exported via src/domain/command/index.ts:35 and src/domain/index.ts:218, but a grep of src/ui for `withLimit` returns zero matches — no UI 
- 修正案: Add `undoStackSize: number` to `AppSettings` in src/ui/state/settings.ts, give it a default of 100, include it in `APP_SETTING_KEYS`, then in the settings-change handler in App.tsx call `historyRef.current = withLimit(historyRef.current, newSettings.undoStackSize)` and expose a number-input control in the settings panel.


---
## Synthesis

Both confirmed. The reparent bootstrap omits `nextVertexId`/`nextRingId` (line 2561), and FileOpsController never subscribes to the auto-save tick. I have enough verification. Here is the prioritized fix queue.

---

# Fix Queue — Next Work Wave

Ordering rule: severity desc, then fix-effort asc (quick wins first within a tier). 教訓5.7 wiring-gaps are grouped separately at the end as a high-value / low-risk batch.

## CRITICAL

| # | Bug | One-line fix | file:line |
|---|-----|-------------|-----------|
| C1 | Reparent conflicts permanently unresolvable — id minters not wired | `createLiveAffiliationBinding({ getRoot, nextVertexId: ids.nextVertexId, nextRingId: ids.nextRingId })` (use the same `ids` object the merge/knife bootstraps use) | `src/ui/App.tsx:2561` |
| C2 | Auto-save tick never subscribed (FR-108 dead) | Add `useEffect(() => { if (!api || !ports) return; return api.onAutoSaveTick(() => void saveCommand(ports, needsSaveAs(contextRef.current))); }, [api, ports]);` | `src/ui/file-ops/FileOpsController.tsx:141` |

## HIGH

| # | Bug | One-line fix | file:line |
|---|-----|-------------|-----------|
| H1 | applyMergeProposal discards vertexRemap — neighbour seams tear | Add step 4 before `return`: `histories = applyVertexRemapToHistories(histories, snapshot.vertexRemap, mergeVertices, anchorTime, calendar);` (mirror split path at :365) | `src/domain/editing/apply-proposal.ts:889` |
| H2 | baseMapImage always written as 0 bytes — map image lost on save | Add `loadedAssetsRef`, capture `response.baseMapImage`/`attachments` on load, read it in `buildSaveRequest` instead of `new Uint8Array()` | `src/ui/file-ops/FileOpsController.tsx:240` |
| H3 | BasicAttributes start/end year cosmetic-only — doesn't move timeline visibility | In `dispatchEdit`, also call `changeStart`/`setEnd` on the anchor series (or make startYear/endYear authoritative aliases of `AnchorEntry.start/end`) | `src/ui/App.tsx:~1668` (intent shape `src/ui/property/contracts.ts:83`) |

## MEDIUM

| # | Bug | One-line fix | file:line |
|---|-----|-------------|-----------|
| M1 | AnchorSection stale view-mode across feature switches | Add `key={targetFeatureId ?? 'none'}` to `<AnchorSection>` | `src/ui/property/PropertyPanel.tsx:206` |
| M2 | undo/redo always sets projectDirty=true — undone project looks dirty | In `runUndo`/`runRedo`, compare restored state to saved snapshot; if equal call `markProjectSaved()` (or add `canClearDirty` flag to `applyCommandResult`) | `src/ui/state/store.ts:631` (callers App.tsx:1238/1246) |
| M3 | AnchorTimeBar open-ended axis collapses to ~1-day span | Replace `year+1` fallback with a full-year-of-headroom max from `last.start` (normalize + ~366 days) | `src/ui/property/AnchorTimeBar.tsx:63` |
| M4 | Reparent shape-gap check (checkAggregateShapes) always skipped | Thread `resolveStore` into `UseReparentToolOptions`/bootstrap and pass `vertexStore: resolveStore()` in confirm's `buildAffiliationProposal` | `src/ui/reparent/useReparentTool.ts:211` |
| M5 | Conflict Rejected phase is a dead-end — can't retry | Make `choosePriority` flip phase back to `Resolving` when in `Rejected` (or add a "選択し直す" action) | `src/ui/conflict/useConflictResolution.ts:141` |
| M6 | Minimap preview stale on re-conflict rounds | Extend `ConflictsPendingResult` to carry the trial-state root; have `shapesFor` prefer it | `src/ui/App.tsx:1496` |

## LOW

| # | Bug | One-line fix | file:line |
|---|-----|-------------|-----------|
| L1 | Reparent stale-closure: first click after rejection mis-picked as parent | In confirm's rejection branches call `reset(REPARENT_FLOW.Rejected)` instead of bare `setFlow(...)`, so targetId/newParentId clear | `src/ui/reparent/useReparentTool.ts:166` |
| L2 | AnchorTimeBar 1-day-floor zoom lock (same root cause as M3) | Fix once with M3 (enforce min one-year span in `viewFromTimePoints`/`initialView`) — **duplicate of M3** | `src/ui/property/AnchorTimeBar.tsx:63` |

> Note: **M3 and L2 are the same defect** (open-ended fallback `last.start.year + 1`). Fix once and both close.

---

## 教訓5.7 Wiring-Gaps (separate batch — high-value, low-risk; domain logic exists + tested, only UI plumbing missing)

These share a pattern: a fully-tested domain function with zero UI callers. Each is a contained, low-blast-radius change. Ordered by severity then effort.

| # | Bug | Sev | One-line fix | file:line |
|---|-----|-----|-------------|-----------|
| W1 | C1 above (reparent id minters) | crit | *(see C1 — also a wiring-gap; keep in critical tier, fix first)* | App.tsx:2561 |
| W2 | C2 above (auto-save tick) | crit | *(see C2)* | FileOpsController.tsx:141 |
| W3 | changeStart/setEnd/deleteAnchor have zero UI callers (FR-56/58) | high | Add per-anchor delete + start/end editors to AnchorSection→AnchorList rows; new AnchorMutationIntent dispatched via a `recordAnchorMutation` path | `src/domain/anchor-series.ts:494/540/616` → UI `AnchorSection.tsx` |
| W4 | parentNone (detach/最上位化) no UI entry in reparent | high | Add `confirmNone` callback (calls `buildAffiliationProposal(..., parentNone, ...)`) + "親なし（最上位化）" button + string | `src/ui/reparent/useReparentTool.ts:211` |
| W5 | FR-52 merge parent/property dialog missing | med | Add `MergeOptionsDialog` calling `allowedMergeParentCandidates`/`propertyInheritCandidates`; thread resolved decisions into `confirm()` | `src/ui/merge/useMergeTool.ts:215` |
| W6 | withLimit (FR-74 configurable undo depth) no UI caller | low | Add `undoStackSize` to `AppSettings` (default 100) + settings input; on change `historyRef.current = withLimit(historyRef.current, n)` | `src/domain/command/history.ts:162` |

(W3, M2-style anchor-edit and the H3 year-binding overlap conceptually — all three touch the anchor/snapshot seam. Consider sequencing H3 and W3 together since both add anchor-mutation dispatch wiring.)

---

## RECOMMENDED FIRST: **C1 — wire `nextVertexId`/`nextRingId` into `createLiveAffiliationBinding` (App.tsx:2561)**

Why this one, decisively:

1. **Highest severity + smallest diff.** It is a one-line change (add two fields to an object literal), and the exact `ids` object is already constructed and passed to the add/knife/merge bootstraps in the same file — copy-paste from a proven sibling. Lowest possible risk for a critical fix.
2. **It unblocks an entire feature path that fails 100% deterministically.** Every reparent that surfaces a conflict currently rejects on *every* Apply with no possible success route — the user can only Cancel. This is worse than a dead feature; it's a guaranteed dead-end loop.
3. **Verified against source.** Line 2561 reads `createLiveAffiliationBinding({ getRoot })` — confirmed missing the minters that all three peer bootstraps supply. The domain `applyResolutionAt` is correct and reachable the instant the minters are present.
4. **No new tests/UI surface required to land it**, unlike C2 (needs a subscription effect + test) or the dialog-building wiring-gaps. It is the cleanest critical win and immediately restores a core editing operation.

Fix C2 (auto-save) immediately after — it is the other critical, slightly larger because it needs the subscription effect plus a regression test asserting the tick actually invokes save.
