# シーム/対蹠経線(±180°)コーナーケース統合監査レポート

読み取り専用監査(ソース・テスト未編集、commit なし)。各観点(render seam / vtransform、ui/map hit-test、domain/geometry・geo、distance/area・survey、view-clip・U10 RBush、persistence・hierarchy・drill)の findings を統合し、重複排除のうえ確度別に整理する。

対象コーナーケース記号:
- **(a)** 東西に極端に長い地物
- **(b)** シームを複数回跨ぐ地物
- **(c)** 経度幅 > 360°(地球を1周以上巻く)
- **(d)** シーム直上/近傍(±180°)の頂点・線
- **(e)** シーム跨ぎの穴(hole)/飛び地(enclave)

---

## 1. 総括

シーム処理の正しさは、ほぼ全面的に「連続スカラー経度(unwrap 済み座標)を上流が渡す」という**暗黙契約**に依存している。persistence 層は連続スカラーを忠実に保持し(破壊なし=確認済み)、render の単一リング area・line 経路や、点/頂点の ±360° レプリカ投影も健全。しかし契約が破れる/per-ring 独立 unwrap が整列されない箇所に欠陥が集中する。最も重大なのは **(I) リング単位の独立 unwrap が外環・穴・飛び地・集約子を共通 world-turn に揃えない**問題群(drill / resolve-shape の集約 union / unwrapShape)で、`ring-hierarchy.ts` が `alignRingTo` で明示的に塞いだ「latent R3 bug」と同型のものが drill・集約経路では未対策のまま残っている。

第二に **(II) unwrap の根本前提「隣接頂点間は実体上 180° 未満」が破れる経路**で、`unwrapRing`/`unwrapLonSequence` がリング閉合辺(末尾→先頭)を連続化しない・180° 超の単一辺を最短側へ不可逆縮約するため、シーム跨ぎ判定・面積(ringAreaKm2 の過小化を数値実証)・巻き数が壊れる。第三に **(III) クリップ経路と描画経路の非対称**で、`worldRectIntersectsViewWrapped`(clip)には MAX_WRAP_REPLICAS 上限が無いのに `wrapTurnsForLonSpan`(draw)は [0] へ退避し、さらに grid-layer のメリディアン列挙には magnitude/safe-integer ガードが全く無く、巨大 centerLon でフレームハングする。

---

## 2. 確度別 所見一覧

### HIGH(高確度・要対応)

#### H1. grid-layer メリディアン列挙に magnitude/safe-integer ガードが無く、巨大有限 centerLon でフレームハング
- **コーナーケース**: (a)(d) — 巨大有限 centerLon(例 1e15)でのシーム近傍。centerLon は clamp されない(camera.ts は zoom のみ clamp)。
- **場所**: `src/render/grid-layer.ts:147-162`(viewportLonSpan), `:215`(buildGridPrimitives メリディアンループ) → `src/domain/basemap/grid.ts:148-152`(graticuleLongitudes の `lon += spacing` ループ)
- **詳細**: `graticuleLongitudes` は `for (let lon = ceil(lonWest/spacing)*spacing; lon <= lonEast+EPS; lon += spacing)`。|lon| > 2^53 で ULP が spacing(10)を超え `lon += spacing` が no-op になり**ループが終了しない=描画フレームがハング**。`vtransform.wrapTurnsForViewport/wrapTurnsForLonSpan` は同病理に対し `Number.isSafeInteger` ガード(`vtransform.ts:273-279, 351-357`)を持つが、viewportLonSpan/grid.ts には等価ガードが無い。tiny-zoom × wide-span でメリディアン配列が無制限確保される問題も同根。**本監査で最も具体的な潜在欠陥**(コードベースが他ループのハングモードを文書化済みなのに、並行する grid ループだけ無防備)。
- **推奨修正**: graticuleLongitudes に入る前に west/east を `Number.isSafeInteger` 相当でガード、もしくはメリディアン本数に上限を設け、超過時は描画を [0]turn 近傍へ縮退。viewportLonSpan で centerLon の magnitude を clamp。

#### H2. drill: unwrap 済み region と raw 代表値 target を共通フレームに揃えず包含/差/積演算 → シーム跨ぎ末端で誤判定・形状破壊
- **コーナーケース**: (d)(a)(e)
- **場所**: `src/domain/drill/drill-geometry.ts:193,199,205,212-214`(regionContainedInTarget / difference / intersection)
- **詳細**: `regionPts = unwrapRing([...region])` は region 第1頂点基準で連続化される一方、`targetMp = resolveLeafShape(...)`(`hierarchy/resolve-shape.ts:73-81`)は**シーム処理ゼロの生代表値**を返す。両者を `alignRingTo` 相当で共通 world-turn に揃えずに boolean ops に渡すため、ターゲット末端がシーム跨ぎ保存(179 と -179 が隣接=raw で ~358° スパン)だと ~360° ずれて pointInPolygon が NotContained を誤検出、または穴を別位置に作る/結果が壊れる。`ring-hierarchy.ts:281-287` が `alignRingTo` で塞いだ R3 bug と同型だが drill では未対策。split-geometry.ts は `anchorMultiPolygon` 対策済みで**非対称**。
- **推奨修正**: drill でも boolean ops 前に region と target を共通アンカー(外環基準)へ `alignRingTo`/`anchorMultiPolygon` で整列。

#### H3. resolveFeatureArea: 集約地物の子領域 union が生代表値で実行され、シーム跨ぎ隣接子が ~360° 離れて結合されない
- **コーナーケース**: (a)(d)(e)(b)
- **場所**: `src/domain/hierarchy/resolve-shape.ts:95-123`(resolveLeafShape 生座標), `:178-248`(union 前に unwrap せず, union は :192)
- **詳細**: `resolveLeafShape` は seam unwrap せず生代表値を返す(`resolve-display-shapes.ts:104` のコメント「resolves rings from RAW vertex coordinates with zero seam handling」が裏付け)。集約 union ループ(:192)はそのまま U06 union に渡す。boolean-ops は unwrap しない(「unwrap は上流前提」)。シームを挟んで実際は隣接する2子(+179 付近 と -179 付近)が ~358° 離れて結合されず、union 出力が地図全幅に散らばる/重なり判定が崩れる。後段 `unwrapShape` は union 出力の per-ring unwrap にすぎず、union 段で壊れた topology は修復不能。leaf/line 経路は最終 unwrap で救えるが**集約だけ救えない非対称**。
- **推奨修正**: 集約 union の前に各子 leaf 形状を共通フレームへ unwrap/align してから boolean-ops へ。

#### H4. unwrapShape が各リングを独立 unwrap し、シーム跨ぎの穴/外環が別 world-turn に着地(穴透過が壊れる)
- **コーナーケース**: (e)(d)(b)
- **場所**: `src/domain/display/resolve-display-shapes.ts:119-160`(unwrapShape — `alignRingTo` 欠落); 影響先 `src/ui/map/live-hit-test.ts:301-321`(drawnAreaAtPoint/pointInPolygon), `:324-338`(multiPolygonLonSpan); 設計根拠 `src/domain/ring-hierarchy.ts:281-300`
- **詳細**: `unwrapShape` は `shape.map(poly => poly.map(ring => unwrapRing(ring)))` と各リングを独立 unwrap。`unwrapRing` は各リング先頭頂点をアンカーにする(`seam.ts:89`, `longitude.ts:95`)ため、外環と穴の頂点列開始がシーム反対側だと連続経度空間で ~360° 離れて着地。`ring-hierarchy.ts:281-300` は同危険を明記し「比較前に必ず `alignRingTo` で同一 world-turn に揃えよ(latent R3 bug)」と書くが unwrapShape は呼ばない。結果: 実際の穴位置で穴透過が効かず誤ヒット/穴が1周ずれた偽位置に出現。renderer と hit-test は同じ誤形状を共有するので相互一致するが、ユーザ意図とはズレる。`multiPolygonLonSpan` も穴の分だけ span が ~360° 超に膨れ wrap-turn 列挙へ波及。
- **推奨修正**: unwrapShape でポリゴン単位に外環基準の `alignRingTo` を適用し、全リングを共通 world-turn に揃える。

#### H5. unwrapRing が暗黙の閉合辺(末尾→先頭)を連続化せず、先頭が東西端でないシーム跨ぎリングが閉合辺で ~360° ジャンプ
- **コーナーケース**: (b)(c)(d)
- **場所**: `src/domain/geo/longitude.ts:95-117`(unwrapLonSequence); `src/domain/geo/seam.ts:89-94, 118-134`
- **詳細**: `unwrapRing`→`unwrapLonSequence` は「開いた」頂点列の隣接辺のみ連続化し、リング閉合辺(last→first)を一切考慮しない(`maxAdjacentLonGap`(seam.ts:118)も明示的に閉合を除外)。例: `[0,120,-120]` は `[0,120,240]` になり閉合辺 240→0 が 240° ジャンプ。これを `multiPolygonFromRing(unwrapRing(ring))` で polygon-clipping に渡すと、その辺がシーム跨ぎの巨大水平辺と解釈され形状が誤る/自己交差。`seam-integration.test.ts` のテスト矩形は先頭頂点(170)が西端なので偶然マスクされている(資産の罠)。
- **推奨修正**: unwrapRing で閉合辺のギャップも検証・連続化、または閉合辺を含めた最適巻きを選ぶ(リング全体の正味巻き数を最小化するアンカー選択)。

#### H6. ringAreaKm2: 経度幅 > 180° の辺を持つ地物の面積が無言で過小化(短経路折り返しでリング形状が崩れる)
- **コーナーケース**: (a)(c)
- **場所**: `src/domain/geo/geodesy.ts:137-171`(ringAreaKm2), `src/domain/geo/longitude.ts:95-117`(unwrapLonSequence)
- **詳細**: `ringAreaKm2` は `unwrapLonSequence(vertices.map(v=>v.lon))` で連続化するが各ステップは `shortestLonDeltaDeg` で必ず |Δ|≤180° に折り返される(`geodesy.ts:137`, `longitude.ts:108`)。「隣接2頂点が 180° 超」の辺は表現不能で逆向き短経路に置換。**数値検証**: 矩形 `[0,200,200,0]×lat[0,10]`(意図200°幅)を渡すと unwrap が `[0,-160,-160,0]` となり面積 19,753,086 km²(正解 24,691,358 km²、160/200 倍に縮小)。シーム跨ぎ判定の根本前提が東西長地物・粗サンプリング辺・多重巻きで成り立たず shoelace が誤った多角形を閉じる。FR-07/FR-12 のワールドスクロールやワイド領地で実害化。
- **推奨修正**: H5 と同根。中間頂点でのリサンプリング、または辺ごとの巻き方向を補助情報で保持。最低限、180° 超辺の入力を検出して警告/拒否。

---

### MEDIUM(中確度)

#### M1. クリップに MAX_WRAP_REPLICAS 上限が無いが描画は [0] へ退避 → 地物が clip で保持されるのに描かれない(clip⊋draw)
- **コーナーケース**: (c) — 経度幅 > 360°(地球1周以上巻く)/極端ズームアウト
- **場所**: `src/render/vtransform.ts:322-361`(wrapTurnsForLonSpan の MAX_WRAP_REPLICAS=100000 ガード, :351-357 で [0] 退避)vs `src/render/feature-layer.ts:228-237`(worldRectIntersectsViewWrapped, 上限なし); 連動 `src/ui/map/live-hit-test.ts:258-264`(drawnLonOffsets)
- **詳細**: `wrapTurnsForLonSpan` は `maxTurn-minTurn >= MAX_WRAP_REPLICAS` または非安全整数で [0] にフォールバック。`worldRectIntersectsViewWrapped` は同等の上限を持たず純 O(1) 閉形式で intersect 報告し続ける(selectVisibleFeatures が保持)。結果「kept by clip ⇒ painted by renderer」不変条件(HB-14 根本修正の根拠)が上限境界で破れ、turn=[0] が画面外なら地物が丸ごと消える。trigger 規模は病的(1地物 36M 度 span、または zoom≈widthCss/36e6)なので medium。renderer と hit-test は双方 [0] を使うので hit 不一致(見えるのに掴めない)は起きない=その面では安全。
- **推奨修正**: clip 側にも同じ上限・縮退ロジックを共有させ両経路を単一ソース化。退避先を [0] でなく nearest-visible turn(下記 L-cap)に。

#### M2. 対蹠ステップ固定 -180→+180 タイブレークがリング全体の最適巻きを保証せず、閉合辺を ~360° に拡大
- **コーナーケース**: (d) — シーム直上/対蹠頂点
- **場所**: `src/domain/geo/longitude.ts:46-52`(shortestLonDeltaDeg), `:95-117`; `geodesy.ts:159-171`
- **詳細**: `shortestLonDeltaDeg` は厳密対蹠(差±180)を常に +180 に写す(検証: sdelta(0,180)=+180, sdelta(0,-180)=+180)。決定的だが局所的選択で、閉合を含むリング全体のトポロジ的整合(正味巻き数0)を保証しない。例: `[0,-180,-10]` → `[0,180,350]` で閉合辺 350°、もし -180 を選べば 10°。対蹠辺を含む/複数跨ぐリングで巻きが単調に +側へ積み上がり lune を誤って増減。area は `Math.abs` で符号反転は隠れるが巻き数が変われば |twiceSigned| が別多角形のものに。H5 と同根。
- **推奨修正**: リング全体の正味巻きが0に近づくアンカー/タイブレークを選択(対蹠辺の符号をリング文脈で決定)。

#### M3. 量子化がシーム周期を無視し、+180 近傍と -180 の頂点が 360° 離れた別グリッドノードに落ちる
- **コーナーケース**: (d)
- **場所**: `src/domain/geometry/quantize.ts:49-115`; `src/domain/geometry/predicates.ts:327-339`
- **詳細**: `quantizeScalar`(quantize.ts:50-54)は経度を単なるスカラーとして `Math.round` し周期畳み込み(`wrapLonDeg`)を持たない。例: 連続頂点 (179.99999996,0) と (-180,0) は物理的に1セル未満だが量子化で (180,0) と (-180,0) になり 360° 離れる。`quantizeRing` の重複除去は厳密スカラー比較なので両者を別頂点として残し、`ringHasZeroLengthEdge`(predicates.ts:327)もゼロ長と見なさず polygon-clipping が同一シーム節点を別物扱い。設計上は unwrap 済み連続座標が入力前提(quantize.ts:57-60 コメント)であり +180/-180 混在は呼び出し側バグでもあるため medium。連続座標でも丸めで 179.99999995→180 と 180.00000001→180 の節点同一視ずれは実在。
- **推奨修正**: quantize の入力前段で連続化を強制する規約検証、または量子化後にシーム周期の節点同一視を行う。

#### M4. rewrapRing の頂点ごと畳み込みが連続リングのトポロジを壊し、シーム上で重複/誤順序頂点・自己交差を生む
- **コーナーケース**: (b)(c)(d)
- **場所**: `src/domain/geo/seam.ts:108-110, 185-188`
- **詳細**: `rewrapRing` は各頂点を独立に `normalizeCoordinate` で [-180,180) へ畳み込む。連続リング `[179,181,181,179]` は `[179,-179,-179,179]` になり、181→179 の隣接辺が -179→179(=358°)の巨大辺に復活。+180 ちょうどの頂点が -180 に折られ隣接重複(ゼロ長辺)や非隣接重複(ピンチ点→自己交差)。op 後結果をこの素朴 rewrap で永続化すると再度 boolean-op で invariants(SelfIntersection/ZeroLengthEdge)reject、または横断辺が描画される。現状 boolean-ops は rewrapRing を呼ばず連続座標のまま返す(rewrap は呼び出し側責務)ため「rewrap を素朴に使った消費側で壊れ得る」潜在バグ。
- **推奨修正**: rewrapRing をリング単位の連続性保存版に置換(全頂点を共通 turn 内に保ちつつ代表 turn だけシフト)、消費側で素朴 per-vertex rewrap を禁止。

#### M5. worldWrapReplicas / ringsShareVertexAcrossSeam の既定 turns={-1,0,1} が1周分しかカバーせず、>360° 地物で交差/共有頂点を取りこぼす
- **コーナーケース**: (c)
- **場所**: `src/domain/geo/seam.ts:172-178, 213-233`
- **詳細**: 既定 turns `[-1,0,1]`。周期的に同一だが2周離れた頂点(540 と -180、差=2*360)は ±1 では一致せず +2 が必要。2周以上のワールドラップや >360° 幅地物の整列でシーム跨ぎ重なり判定が偽陰性となり合体/差分すべき片を取りこぼす(教訓5.1 の片落とし相当)。既定値依存の呼び出し側で顕在化。
- **推奨修正**: replica 範囲を地物 span から動的算出(`ceil(span/360)` 分のレプリカ)。

#### M6. U10 排他検証/索引が raw(非unwrap)bbox を使い、単一リング内 179→-179 が「逆回り358°」bbox になり ±360° 複製で救えない
- **コーナーケース**: (d)(e)
- **場所**: `src/domain/spatial/overlap.ts:84-94,111-176`; `src/domain/spatial/bbox.ts:37-78`
- **詳細**: `detectTerminalOverlaps` と `multiPolygonBBox` はリング座標を verbatim で min/max(`foldCoordinate`)。representative 格納された1枚のシーム跨ぎ面(+179 と -179)は bbox が [-179,+179]=~358° の逆回りになる。`replicateShape`(→`worldWrapReplicas`)はリング全体を ±360 平行移動するだけで、1リング内部の 179→-179 エッジ(本来 ~2°)を連続化できない(unwrapRing 不呼出)。結果(1)候補 bbox 巨大化で narrowing が全件化(NFR5.1/5.2 退行)、(2)2つのシーム跨ぎ terminal の実重なりを逆回り bbox 同士で取りこぼし/誤検出。render 経路は unwrap 済みだが U10 排他/近接スナップ経路だけ非適用という非対称。テスト(overlap.test.ts criterion4)は別 terminal の隣接のみで「1枚の面が 179/-179 で格納」は未カバー。
- **推奨修正**: bbox/overlap 計算前にリングを unwrapRing で連続化(または bbox にシーム周期版を導入)。

#### M7. shapeRect/EvaluatedArea がリング毎独立 unwrap で全体 bbox が ~358° に膨れる(クリップは安全だが描画でピース消失余地)
- **コーナーケース**: (e)(b)
- **場所**: `src/domain/display/resolve-display-shapes.ts:119-160`; `src/render/feature-layer.ts:262-280`; `src/render/canvas2d-renderer.ts:386-394`
- **詳細**: H4 の派生。`unwrapShape` の per-ring 独立 unwrap で territory が +179 付近・飛び地/穴が -179 付近に格納されると各リングが別 turn に展開。`shapeRect` は全リング跨ぎ min/max で ~358° の全体 bbox に。クリップ(worldRectIntersectsViewWrapped)では superset 維持で安全だが、`drawShape` は `primitiveLonSpan`(全リング併合 span)から1つの turn 集合を計算しシェイプ全体を同一 turn で描く(canvas2d-renderer.ts:186-212,386-394)。ピースが別 turn 前提だと飛び地/穴が画面外 turn に描かれ消える/穴がズレて穴透過破綻。
- **推奨修正**: H4 を修正すれば連動して解消。

#### M8〜M11(distance/area・survey 系、中確度)
- **M8. unwrapLonSequence: 多重巻き(>360°)リングの巻き戻しで area/length が崩れ得る** — (c) — `src/domain/geo/longitude.ts:95-117`, `geodesy.property.test.ts:119-124`。隣接辺が一つでも 180° 超で逆符号に折られ累積巻き数が壊れ shoelace 面積が lune 単位でずれる。property test も near-antipodal を invariant から除外=開発側も未対応を認識。**推奨**: H5/H6 と同根、リサンプリング。
- **M9. 対蹠(正確 180°)辺の unwrap が常に +180 固定で、面積符号/巻きが入力順序依存** — (d)(b) — `longitude.ts:46-52`, `geodesy.ts:159-171`。M2 と同根。area は abs で符号は隠れるが巻き数が変わると別多角形に。**推奨**: M2 と統合修正。
- **M10. 測量線(equirect/great-circle/距離)が経度差>180° の意図を常に最短側へ強制し、長経路測量を表現不能** — (a)(d) — `survey/great-circle-path.ts:114,211`, `geodesy.ts:46,65`。始点-170°・終点+170°(340° 東回り意図)が -20° 西回りに強制。AC-2 ±360k 不変は満たすが半周超クリック差が縮約され FR-14 距離表示と UI 期待が乖離し得る。**推奨**: 連続スカラー端点差を保持する測量モード、または UI で長経路選択を明示。
- **M11. シーム跨ぎ穴/飛び地: 穴リングが>180° 辺を持つと過小化され領地控除が不足** — (e) — `geodesy.ts:185-208, 129-171`。`polygonAreaKm2` は territory(+)/hole(-) を取るが穴が H6 機構で過小評価され控除不足→総面積過大。穴と外環で巻き方向が独立決定されるため片方だけ折り返されると整合崩れ。**推奨**: H4/H6 修正に連動。

---

### LOW(低確度・防御設計/回帰網の穴/二次影響)

- **L1. MAX_WRAP_REPLICAS 退避先が [0](identity turn)で、退避時に画面上の replica でなく地球の反対側を描き得る** — (c) — `vtransform.ts:273-279, 351-357`。退避先を `round((centerLon-lonMid)/360)` の nearest-visible turn にすれば「何も見えない」でなく「劣化サブセット描画」になる。M1 と統合。
- **L2. クリップは inflate 済み view rect、描画は bare screen edges で turn 列挙 — 現状 clip⊇draw は成立するが2矩形が非同一(将来 drift リスク)** — (d) — `feature-layer.ts:316-338,696-698` vs `vtransform.ts:342-345`。inflate は広げるだけなので現状安全だが「kept⇒drawn」を不等式(inflate⊇bare)で維持しており単一ソースが無い(教訓5.29 の single-truth 主張と乖離)。
- **L3. drawShape が全ピースの span を1つの [min,max] に併合 → 別 turn のピースを持つ多片面で off-turn ピースを二重描画/evenodd で誤キャンセル余地** — (b)(e) — `canvas2d-renderer.ts:385-392, 294-315, 186-198`。要 contrived 再現(同一ピクセルで2 replica 重なり→偶数ネスト→穴)。未確認。
- **L4. LOD 簡略化により renderer の描画形状と hit-test の unsimplified 形状が不一致** — (a)(d) — `feature-layer.ts:645-648` vs `live-hit-test.ts:28-30,301-338`。シーム近傍の極小 sliver/経度 extrema 頂点が簡略化で落ちると wrap-turn 集合が食い違い掴めない/掴めるズレ。意図的に per-pixel 一致は担保しない設計。
- **L5. 極端 pan で worldPoint.lon 巨大化、screenToWorld が fold/clamp せず包含 probe の数値精度劣化** — (a)(d) — `vtransform.ts:101-111`, `host-ports.ts:378-382`, `live-hit-test.ts:301-321`。~1e15 で経度分解能 ~0.125° まで低下、小 AREA 内外判定が不安定。設計通り fold しない(FR-12)が理論的病的入力。
- **L6. 単一辺の経度幅>180° が表現不能(最短側折返し)— 極端長地物の暗黙制約** — (a)(b)(c) — `longitude.ts:95-117`, `seam.ts:89-94`。入力時に拒否・明示されず誤展開形状をそのまま描画/hit-test。H5/H6 と同根の制約面。
- **L7. clampGapToStep の ULP 補正ループ上限(4)を超える残差が無言許容 → >180° ギャップ残存の理論余地** — (d) — `longitude.ts:124-161`。多重巻きで prevUnwrapped が巨大連続スカラに育つと1 ULP が maxGap 比で無視できず4回で収束しない可能性。`seam.property.test.ts:81` は厳密境界テストなので red にならず実データ稀ケースで連続性破れ。
- **L8. greatCirclePath: ほぼ対蹠(omega≈π)で slerp の f0/f1 が巨大化し中間点が数値的に暴れる** — (d) — `great-circle-path.ts:116-152`。厳密 π は2点退避するがニアミスは分岐に入らず線形状が大円から逸脱。距離(haversine)は別経路で安定。描画のみ影響。
- **L9. quantizeScalar: 多周回(>数十万周)連続経度の量子化で ULP 損失により ±180 直上頂点がシームを跨いで隣セルへ移動** — (c)(d) — `quantize.ts:50-54`, `coordinate.ts:67-68`(MAX_COORDINATE_MAGNITUDE≈9.0e8)。Codex 実証: 179.99999994 を 360*1e6 ずらして量子化往復で 180 になる。通常編集では非到達。
- **L10. spatial/bbox: シーム跨ぎリングを生代表値で渡すと min/max が ~358° の偽 bbox** — (d)(a)(e) — `bbox.ts:37-61`。M6 の bbox 面。呼び出し側 unwrap 規約遵守に依存。
- **L11. ringCentroid/projectedRingAreaPx: H4 成立時の二次影響でラベルが地球の反対側/占有率破綻** — (d)(e) — `feature-layer.ts:489-541,669-685`。単一リング正常系では問題なし。
- **L12. boolean-ops 自体は unwrap 非実施で生折り畳み座標を渡すとシーム跨ぎ形状が誤結果(設計上は呼び出し側責務だが防御層で検出不能)** — (b)(d) — `boolean-ops.ts:140-185`, `invariants.ts:253-306`。Codex 実証: 折り畳み座標 `[(179,-10),(-179,-10),(-179,10),(179,10)]` と グリニッジ矩形の intersection が誤って矩形全体を返す。再量子化・invariants も平面的に妥当な単純多角形なので violation を出さず黙って通す。「契約違反を防御層が捕捉できない」脆弱性。

---

### 反証/確認済み(壊れていないことの記録)

- **persistence は連続スカラー経度を忠実保持(正の確認)** — `schema.ts:60-97`(coordinateScalar は finite+|v|≤MAX のみ、[-180,180) クランプなし), `serialize.ts:152,356`(verbatim コピー), `repair.ts`(経度に触れない)。save→load で多重跨ぎ/連続スカラーが折り返される直接バグは persistence 層に無い。リスクは幾何 consumer 側に集約。
- **単純シーム跨ぎ leaf 面の包含、点/頂点の ±360° レプリカ(Codex #4)、line body は OK** — `resolve-display-shapes.ts:119-160`, `live-hit-test.ts:207-220,349-493`。単純シーム leaf は renderer と hit-test が同じ解決形状を共有し正常。点/頂点 wrap レプリカは `nearestDrawnDistSq` が `wrapTurnsForLonSpan(coord.lon, coord.lon, ...)` で全描画 turn を投影し有限 camera/zoom で解消済み。line は `lineFullyResolved`(:435)が1頂点欠落で line 丸ごと除外し単一 run しか生成されず取りこぼし到達不能。
- **±180° floor/ceil 算術自体に off-by-one なし** — `wrapTurnsForLonSpan` は `ceil((leftLon-lonMax)/P)..floor((rightLon-lonMin)/P)` の正確な inclusive overlap、`worldRectIntersectsViewWrapped` の単一 k チェックは >360 span でも十分。両者は一致。
- **worldRectIntersectsViewWrapped の単一 k 閉形式は span≥360 で常時 true=正しい** — `feature-layer.ts:228-237`。a または view のいずれかが全周をカバーすると自動 true=取りこぼしなし(safe)。ただし inflate/clip が a の span を絞る方向に変わると前提が崩れる脆さ(L2 と関連)。

---

## 3. 要ランタイム確認の項目(プロパティ/E2E で実証すべきもの)

既存テストのジェネレータ(`woundLonArb` ±1500, `multiWindRingArb` step[30,170], `areaArb` 連続quad, `featureHasOnScreenVertex` 真値のみ)は病的入力に到達しない。以下の生成器/シナリオを追加して実証する:

1. **巨大有限 centerLon でのフレーム停止(H1)**: centerLon ∈ {1e9, 1e13, 1e15, 2^53+1} で buildGridPrimitives/graticuleLongitudes/viewportLonSpan がタイムアウト上限内に終了することをプロパティ化(現状ハングするはず=red を期待)。
2. **東西に極端長/>180° 単一辺の面積(H6/M8)**: 矩形 `[0,200,200,0]` 等、隣接辺 >180° のリングで ringAreaKm2/polygonAreaKm2 が解析値(球面)と一致するかを数値プロパティ化。near-antipodal を除外している既存 property の除外条件自体をテスト対象にする。
3. **閉合辺がシームを跨ぐリング(H5/M2)**: 先頭頂点が東西端でない(例 `[0,120,-120]`, 対蹠 `[0,-180,-10]`)を unwrapRing→boolean-ops に通し、自己交差/巨大水平辺/面積誤りが出ないことを検証。
4. **シーム跨ぎ穴/飛び地/集約子(H2/H3/H4/M7/M11)**: 外環 +179 付近・穴 -179 付近(頂点列開始が反対側)の多リング/多片面、および集約子が +179/-179 に分かれるケースで、(a) 穴透過の包含判定、(b) 集約 union の連結、(c) ラベル重心、(d) drill の包含/差/積 が幾何的に正しいことを E2E/プロパティ化。`areaArb` に「逆回り representative 面」「per-ring 開始がシーム反対側の面」を生成する arbitrary を追加。
5. **clip⊇draw を turn=[0] 退避域まで張る(M1/L1)**: span 数百万度 or lon≈1e15 で wrapTurnsForLonSpan が [0] に縮退する入力を `woundLonArb`/`zoomedInArb` の範囲外まで拡張し、「clip kept ⇒ renderer paints on-screen」を頂点が全て画面外でエッジ/内部だけ視野横断のケース含めて検証。
6. **>360°(2周以上)地物の overlap/共有頂点(M5/M6)**: 540° と -180° 等2周離れた頂点を持つ terminal で worldWrapReplicas/ringsShareVertexAcrossSeam/detectTerminalOverlaps が取りこぼさないことを検証(既定 turns={-1,0,1} の偽陰性を露出)。
7. **量子化のシーム節点同一視(M3/L9)**: (179.99999996,0) と (-180,0)、多周回連続経度の量子化往復で節点が 360° 分離/シーム跨ぎ移動しないことを検証。
8. **boolean-ops 防御層(L12)**: 生折り畳み座標(179/-179 隣接)を intersection に渡したとき、誤結果が invariants をすり抜ける現象を回帰固定し、防御層に「非連続入力検出」を追加すべきか判断材料にする。

---

## 4. 重複排除済み「修正すべき候補」リスト(専用シーム修正パス向け)

優先度順。多数の所見が**2つの根本原因**に収束する。

### 根本原因 A: per-ring 独立 unwrap が共通 world-turn に整列されない(`alignRingTo` 欠落)
全領域横断で最大の被害源。`ring-hierarchy.ts` の `alignRingTo`/`anchorMultiPolygon` を**全 unwrap 経路の共通ヘルパ**に昇格して適用する。
- **C1 [HIGH]** `resolve-display-shapes.unwrapShape` にポリゴン単位の外環基準 align を追加(H4 → M7/M11/L11 が連動解消)。場所: `resolve-display-shapes.ts:119-160`。
- **C2 [HIGH]** `drill-geometry` で boolean-ops 前に region/target を共通アンカーへ align(H2)。場所: `drill-geometry.ts:193-214`。
- **C3 [HIGH]** `resolveFeatureArea` の集約 union 前に各子 leaf を共通フレームへ unwrap/align(H3)。場所: `resolve-shape.ts:178-248`。
- **C4 [MED]** U10 `overlap`/`bbox` を計算前に unwrapRing で連続化(M6/L10)。場所: `overlap.ts:84-176`, `bbox.ts:37-78`。
- **C5 [MED]** `rewrapRing` を連続性保存版へ置換し、素朴 per-vertex rewrap を消費側から排除(M4)。場所: `seam.ts:108-110`。

### 根本原因 B: unwrap が「隣接 180° 未満」「閉合辺無視」を前提とし、>180° 辺・閉合辺・対蹠で破綻
- **C6 [HIGH]** `unwrapRing`/`unwrapLonSequence` に閉合辺(last→first)の連続化を追加し、リング全体の正味巻き最小化アンカーを選ぶ(H5 → H6/M2/M8/M9/L6 が連動解消)。場所: `longitude.ts:95-117`, `seam.ts:89-94`。
- **C7 [HIGH]** `ringAreaKm2`/`polygonAreaKm2` を C6 修正後の連続化に依存させ、>180° 辺の数値正しさを担保(H6/M11)。場所: `geodesy.ts:129-208`。
- **C8 [MED]** `shortestLonDeltaDeg` の対蹠タイブレークをリング文脈依存に(M2/M9)。場所: `longitude.ts:46-52`。

### 独立した経路別の修正
- **C9 [HIGH]** grid-layer/graticuleLongitudes に safe-integer/magnitude ガードとメリディアン本数上限を追加(H1)。場所: `grid-layer.ts:147-162,215`, `grid.ts:148-152`。**他と独立・即時着手可。**
- **C10 [MED]** clip と draw の turn ロジックを単一ソース化し、clip 側にも MAX_WRAP_REPLICAS 縮退を共有、退避先を nearest-visible turn に(M1/L1/L2)。場所: `feature-layer.ts:228-237` と `vtransform.ts:322-361` の統合。
- **C11 [MED]** `worldWrapReplicas`/`ringsShareVertexAcrossSeam` の replica 範囲を span から動的算出(M5)。場所: `seam.ts:172-178,213-233`。
- **C12 [MED]** `quantizeScalar`/`quantizeRing` にシーム周期の節点同一視、または非連続入力検出(M3/L9)。場所: `quantize.ts:49-115`。
- **C13 [LOW]** boolean-ops の防御層に「非連続(>180° 辺)入力検出」を追加し契約違反を可視化(L12)。場所: `boolean-ops.ts:140-185`, `invariants.ts:253-306`。
- **C14 [LOW]** survey 測量線に連続スカラー長経路モード/UI 明示(M10)、greatCirclePath のニアミス対蹠フォールバック閾値を緩和(L8)。場所: `great-circle-path.ts:114-211`。
- **C15 [LOW]** screenToWorld/host-ports の極端 pan 時の数値劣化対策(L5)、clampGapToStep の収束上限見直し(L7)。場所: `vtransform.ts:101-111`, `longitude.ts:124-161`。

**着手順の推奨**: C9(独立・ハング修正)→ C6/C7(unwrap 根本)→ C1/C2/C3(align 根本、最大被害)→ C4/C5/C10/C11/C12 → 残り LOW。C1〜C3 と C6 は所見の大半を連動解消するため、これら4本でシーム欠陥の主要部分を塞げる。
