# Đánh giá chất lượng context & prompt của Planner

> Nguồn phân tích: `apps/server/plan.txt` — prompt thực tế của node `planner` cho ca:
> App `mida`, Issue "Khách báo ko xem đc heatmap. chỉ thấy màn trắng tinh",
> 7 repo (`sama-proxy/extensions/recorder/search/hm/api/cms`), 6 DB source (5 mongo + rabbitmq + redis).
>
> Kết luận ngắn: **context hiện CHƯA chuẩn**. Phần grounding (codebase + app knowledge) bị nhiễu nặng
> và truy hồi sai trọng tâm, khiến guardrail "chỉ dùng fact có thật" phản tác dụng — model bị kẹt giữa
> "không được đoán" và "fact có thật thì toàn rác". Dưới đây là các vấn đề xếp theo mức ảnh hưởng.

---

## P0 — Sai từ gốc, giết độ chính xác

### 1. Query truy hồi codegraph = nguyên văn tiếng Việt → tìm sai trên codebase tiếng Anh
**Dẫn chứng:** mọi block "Query:" trong context đều là `Khách báo ko xem đc heatmap. chỉ thấy màn trắng tinh`
(plan.txt:19, 62, 125, 138, 228, 312). Kèm cảnh báo lặp lại "⚠️ Low-confidence match — matched mostly on common words"
(plan.txt:39-46, 108-115, 209-212).

**Vấn đề:** codegraph search theo từ khóa/FTS trên **symbol tiếng Anh** (heatmap, render, canvas, snapshot...).
Dùng câu phàn nàn tiếng Việt làm khóa tìm kiếm → match trúng "common words" → trả về toàn entry point bậy:
`Router`, `import koa`, `constant app @ server.js`. Code thật sự liên quan (render canvas, giải nén snapshot,
replay rrweb) gần như không nổi lên.

**Tại sao phải sửa:** đây là **lỗi gốc** — toàn bộ grounding phía sau dựa trên kết quả truy hồi này. Sai từ đây
thì hypotheses, probes, analyze đều lệch theo. Guardrail "chỉ dùng symbol có thật" càng làm hại vì symbol có thật = rác.

**Cách sửa:** tách "khóa truy hồi code" khỏi "issue gốc". Trước khi gọi codegraph, sinh một **truy vấn kỹ thuật tiếng Anh**
(keyword: `heatmap render canvas blank`, `rrweb snapshot replay decompress`, `session recording`) từ issue —
bằng 1 bước normalize/dịch nhẹ hoặc trích keyword. Truy hồi theo khóa này, không phải nguyên văn tiếng Việt.
**File:** `graph/nodes/gatherContext.ts`, `connectors/codegraph.ts` (hàm build query).

### 2. APP KNOWLEDGE là rác (cookie banner, URL ảnh, "Last updated")
**Dẫn chứng:** plan.txt:369-393 — `View Heatmaps | MIDA Docs: ck.`, các URL ảnh gitbook dài ngoằng,
`This site uses cookies...`, `AcceptReject`, `Last updated 8 months ago`.

**Vấn đề:** crawl doc nhưng không làm sạch: giữ lại nav, banner cookie, link ảnh base64. Gần như 0 giá trị chẩn đoán,
lại ngốn token và làm loãng tín hiệu.

**Tại sao phải sửa:** context "kiến thức app" lẽ ra phải là phần bù đắp khi code mơ hồ. Hiện nó phản tác dụng:
tốn token + đánh lạc hướng. Với issue heatmap, doc đúng (cách heatmap render, điều kiện hiển thị) đáng lẽ rất quý.

**Cách sửa:** pipeline crawl phải strip boilerplate (nav/footer/cookie/markdown image/URL), chunk theo đoạn văn xuôi,
lọc chunk theo điểm tương đồng tối thiểu, bỏ chunk chỉ toàn link/ảnh.
**File:** `knowledge/*` (crawl + chunk + embed), `graph/nodes/gatherContext.ts` (lọc top-k theo score).

---

## P1 — Lãng phí token & thiếu khả năng grounding

### 3. Context code đầy boilerplate, không xếp hạng theo liên quan
**Dẫn chứng:** "Relevant symbols" toàn `import koa`, `import koa-static`, `constant app @ server.js`,
`constant Router @ ...route.js` (plan.txt:48-57, 116-120, 127-134, 214-224, 297-307).

**Vấn đề:** danh sách symbol là "top symbol của repo" chứ không phải "symbol liên quan ngữ nghĩa". Tín hiệu thật
(`setupPeriodicSnapshot @ scripts/rrweb/record/dynamic-dom-handler.js:267` — plan.txt:117;
`HEATMAP_GRADIENT @ canvas.render.js` — plan.txt:72; component `HeatmapV2` ở sama-cms) bị chôn lẫn trong nhiễu.

**Tại sao phải sửa:** model phải tự lọc rác trong mỗi lần đọc → tốn token, dễ bám nhầm. Symbol vàng như
`setupPeriodicSnapshot` (đúng nhánh rrweb/snapshot — chính là gốc của ca này) phải được **đẩy lên đầu**, không phải vùi.

**Cách sửa:** xếp hạng symbol theo độ khớp keyword kỹ thuật; loại symbol framework/boilerplate (import, Router, app, Koa...);
chỉ giữ N symbol điểm cao. **File:** `connectors/codegraph.ts`.

### 4. "Expected browser markers" được guardrail viện dẫn nhưng KHÔNG hề có trong prompt
**Dẫn chứng:** guardrail nói "use marker values from 'Expected browser markers' listed above" (plan.txt:420)
nhưng trong prompt **không có** section markers nào.

**Vấn đề:** với lỗi "màn trắng tinh", **browser probe là kiểm tra trực diện nhất** (mở trang, xem canvas heatmap có render,
console error, asset 404). Nhưng vì không có marker → theo guardrail, model buộc phải đẩy vào `missingContext` thay vì
chạy browser probe. Trong khi code thừa marker để dùng: `HEATMAP_GRADIENT`, canvas selector, container id, tên hàm render.

**Tại sao phải sửa:** đang **tự khóa** mất surface hữu ích nhất cho đúng loại lỗi này. Mâu thuẫn nội tại giữa guardrail
và dữ liệu thực tế.

**Cách sửa:** trích `expectedMarkers` từ codeContexts (selector canvas, id container, hằng render như `HEATMAP_GRADIENT`)
và đưa vào prompt; hoặc nới guardrail cho phép browser probe dùng marker suy từ code render đã thấy.
**File:** `connectors/codegraph.ts` (điền `expectedMarkers`), `reasoning/plan.ts` (render section markers).

---

## P1 — Thiếu năng lực suy luận cho đúng ca này

### 5. Không có dòng "Identifiers" — store_domain có nhưng thiếu shop_id, chưa hỗ trợ tra cứu DB nhiều bước
**Dẫn chứng:** prompt chỉ có `Store:` + `Store URL:` (plan.txt:6-7), **không có** dòng `Identifiers:`
(template bỏ qua khi rỗng).

**Vấn đề:** muốn query heatmap-db cần `shop_id` nội bộ, nhưng ta chỉ có domain. Luồng đúng phải là **chuỗi 2 bước**:
query collection `shop` theo domain → lấy `shop_id` → query `heatmap`/`session` theo `shop_id`. Hiện
`runDbQueryReasoning` sinh query 1 lượt từ identifiers có sẵn — nếu thiếu shop_id, nó không tự bắc cầu được.

**Tại sao phải sửa:** đây chính là loại "suy luận query DB nhiều bước" mà ca thực tế cần. Không có nó, DB probe
sẽ trả rỗng hoặc phải hỏi người dùng shop_id (đúng cái ta muốn tránh).

**Cách sửa:** (a) chuẩn hóa identifiers từ storeDomain ngay từ intake; (b) cho `runDbQueryReasoning`/refine khả năng
sinh query **phụ thuộc kết quả** — bước 1 lấy shop_id, bước 2 dùng shop_id. Có thể làm bằng 1 vòng refine nữa (discover→lookup shop→query heatmap).
**File:** `graph/nodes/intake.ts`, `reasoning/dbQuery.ts`, `graph/nodes/probeRefine.ts`.

### 6. `build_snapshot` không thể phát ở plan đầu — cần được sinh ở bước refine sau discover
**Dẫn chứng:** hướng dẫn snapshot ở plan.txt:407-409 yêu cầu `recordingId` + `collection/idField/snapshotField`,
nhưng những thứ này **chưa biết** cho tới khi `discover` chạy (chưa có schema, chưa có recordingId từ DB).

**Vấn đề:** planner lần đầu chỉ nên phát `inspect_pipeline` + `discover`. `build_snapshot` (giống DB data-probe)
phải được **tổng hợp ở `refine_probes`** sau khi đã biết schema + tra ra recordingId của shop. Hiện `refine_probes`
mới chỉ tổng hợp DB query, **chưa tổng hợp `build_snapshot`**.

**Tại sao phải sửa:** nếu không, hoặc planner bịa recordingId (vi phạm guardrail), hoặc bỏ qua build_snapshot —
mất chính năng lực vừa xây cho app recording.

**Cách sửa:** mở rộng `probeRefine` để khi caseType là recording/heatmap và đã có discover + shop_id →
sinh `build_snapshot` với field thật. **File:** `graph/nodes/probeRefine.ts`, `reasoning/dbQuery.ts` (hoặc reasoning snapshot riêng).

### 7. Không có "vai trò repo" → probe rải sai trọng tâm trên 7 repo
**Dẫn chứng:** 7 repo liệt kê phẳng ở plan.txt:9, không nói repo nào lo gì.

**Vấn đề:** "blank heatmap render" nằm ở `sama-cms` (react frontend) + nhánh replay rrweb (`sama-recorder`/`extensions`),
còn pipeline dữ liệu ở `sama-hm`/`sama-api`. Planner không biết điều này → dễ phát code probe vào repo sai
(vd grep `sama-proxy` cho lỗi render).

**Tại sao phải sửa:** giảm số probe vô ích, tăng tỉ lệ trúng. Với 7 repo, định hướng vai trò là đòn bẩy lớn.

**Cách sửa:** thêm mô tả vai trò repo vào `ResolvedAppConfig.repos[].role/description` (cấu hình 1 lần) và đưa vào prompt.
**File:** config app (`config/index.ts`, schema `dbSources`/`repos`), `reasoning/plan.ts`.

### 8. Không có trần số probe — 7 repo × 6 source dễ bùng nổ
**Vấn đề:** prompt không giới hạn số probe. Với quy mô này planner có thể đẻ hàng chục probe (discover ×6, code ×7...),
tốn thời gian/LLM/IO.

**Cách sửa:** nêu trần rõ trong prompt (vd "tối đa 2-3 repo liên quan nhất, 2-3 DB source liên quan nhất, ≤8 probe/lần"),
ưu tiên theo keyword. **File:** `reasoning/plan.ts`.

---

## P2 — Robustness / chất lượng nhỏ

### 9. Cắt cụt giữa chừng `contextMarkdown.slice(0, 2000)`
**Dẫn chứng:** code bị cắt ngang token, vd plan.txt:366 `setConversionActive((pr` (cụt).
**Cách sửa:** cắt theo ranh giới symbol/dòng thay vì cắt cứng theo ký tự; hoặc tóm tắt thay vì cắt.
**File:** `reasoning/plan.ts` (chỗ `.slice(0, 2000)`), `connectors/codegraph.ts`.

### 10. caseType chưa có nhóm cho recording/heatmap
**Vấn đề:** enum chỉ có `frontend_bug/data_integrity/performance/...`. Việc kích hoạt snapshot surface đang dựa vào
keyword issue, không dựa caseType — chấp nhận được, nhưng thêm 1 caseType `session_recording` sẽ rõ ràng & dễ định tuyến hơn.
**File:** `reasoning/plan.ts` (PlanOutputSchema), shared nếu cần.

### 11. Lỗi chính tả/khác biệt nhỏ trong hướng dẫn surface
**Dẫn chứng:** plan.txt:401 liệt kê `code | database | logs | shopify | browser | config` nhưng **thiếu `snapshot`**
ở dòng "surface options" (dù có hướng dẫn snapshot ở dưới). Nên thêm `snapshot` vào danh sách surface chính cho nhất quán.
**File:** `reasoning/plan.ts`.

---

## Tóm tắt ưu tiên

| # | Vấn đề | Ảnh hưởng | Sửa ở đâu |
|---|--------|-----------|-----------|
| 1 | Query codegraph = tiếng Việt nguyên văn | **P0** | gatherContext, codegraph |
| 2 | App knowledge toàn rác (cookie/URL ảnh) | **P0** | knowledge/*, gatherContext |
| 3 | Symbol context đầy boilerplate, không rank | P1 | codegraph |
| 4 | "Expected browser markers" viện dẫn nhưng rỗng | P1 | codegraph, plan |
| 5 | Thiếu identifiers + chưa tra DB nhiều bước (domain→shop_id→heatmap) | P1 | intake, dbQuery, probeRefine |
| 6 | build_snapshot chưa được sinh ở refine sau discover | P1 | probeRefine, dbQuery |
| 7 | Không có vai trò repo | P1 | config, plan |
| 8 | Không giới hạn số probe | P1 | plan |
| 9 | Cắt cụt code giữa token | P2 | plan, codegraph |
| 10 | caseType thiếu nhóm recording | P2 | plan |
| 11 | Danh sách surface thiếu `snapshot` | P2 | plan |

**Nhận định cốt lõi:** nút thắt lớn nhất KHÔNG nằm ở phần hướng dẫn (instructions/guardrail đã khá rõ),
mà ở **chất lượng truy hồi context** (mục 1, 2, 3, 4). Sửa khâu retrieval (khóa tìm tiếng Anh, làm sạch doc,
rank symbol, điền markers) sẽ nâng chất lượng plan hơn mọi chỉnh sửa câu chữ trong prompt.

---

# TẦNG 2 — Linh hoạt cấu trúc (workflow có quá khuôn mẫu?)

> Tầng 1 ở trên = "sửa cho đường ray chạy tốt hơn". Tầng 2 = "liệu bản thân đường ray có quá cứng".
> Câu trả lời: **có**. Kể cả sửa hết 11 mục tầng 1, lõi vẫn là pipeline tuyến tính cố định
> `plan(1 phát) → diagnose → refine → analyze → replan`. Phần "thông minh" bị đóng hộp vào các call LLM
> rời rạc với schema cứng; agent không tự quyết được "làm X, tùy kết quả mới làm Y" ngoài các cạnh đã hardcode.
>
> **Quan trọng:** tầng 1 vẫn phải làm — retrieval rác thì kiến trúc nào cũng chết. Tầng 2 đi kèm, không thay thế.

## A. Các điểm cứng (rigidity) — có dẫn chứng

### A1. Plan-once: lập kế hoạch trước khi thấy bất kỳ tín hiệu nào
Planner đẻ toàn bộ hypotheses + probes upfront (`reasoning/plan.ts`). Chỉ có 2 vòng lặp hẹp:
`refine_probes` (DB-query + env trace) và `replan` (khi low-confidence). Không có vòng
"quan sát → suy nghĩ → hành động → quan sát" mở như người debug thật.
**Hệ quả:** điều tra theo giả định ban đầu, khó bẻ lái giữa chừng.

### A2. Taxonomy action đóng cứng (áo bó)
Surface + action là enum đóng. DB chỉ có `read_schema / check_record_exists / count_check / key_inspect /
queue_inspect / peek_messages` (`investigators/database.ts`). **Không diễn đạt được:** "đếm heatmap của shop
trong 24h qua", "lấy N bản ghi mới nhất theo timestamp", "group/aggregate", "join shop↔session↔heatmap",
"đối chiếu queue depth với thời điểm ghi DB". Với đúng ca heatmap, câu hỏi cốt lõi *"shop này có data heatmap
gần đây không"* gần như không gói được bằng `count_check`.
**Hệ quả:** nhiều câu hỏi chẩn đoán thực tế không biểu đạt được → bỏ sót hoặc trả lời hời hợt.

### A3. Ranh giới schema làm rụng thông tin
`plan / analyze / replan` là các call LLM riêng, context riêng. `analyze` chỉ nhận `evidence` đã chắt lọc —
KHÔNG thấy raw probe result, KHÔNG thấy chuỗi suy luận trước. Mỗi lần qua schema là mất ngữ cảnh.
**Hệ quả:** suy luận cuối nghèo ngữ cảnh hơn dữ liệu thực có.

### A4. Bỏ kết quả âm khỏi evidence (bug-ish)
`evidenceFromResult` trong `graph/nodes/diagnose.ts` chỉ giữ probe `found===true`. Nhưng "shop KHÔNG tồn tại",
"queue RỖNG", "KHÔNG có data 24h" thường là tín hiệu mạnh nhất — lại bị loại.
**Hệ quả:** chính các bằng chứng phủ định (hay quyết định nhất) không tới được `analyze`.
**Sửa nhanh (đáng làm bất kể tầng 2):** giữ cả kết quả âm, gắn nhãn `polarity: positive|negative`.

### A5. Khóa cứng vào hypotheses ban đầu
Mọi thứ xoay quanh 2-4 giả thuyết planner đẻ lúc đầu. Nếu nguyên nhân thật không nằm trong đó → `analyze`
chỉ trả "inconclusive" rồi replan TRONG CÙNG KHUNG. Không có cơ chế *reframe* lại bài toán.

### A6. Vòng lặp nông
`MAX_REFINE=2` (`graph/nodes/probeRefine.ts`), `maxIterations=3` (mặc định). Chuỗi nhiều bước thật
(domain→shop_id→heatmap_config→queue→snapshot) vượt trần.

## B. Nhưng cái cứng đó đang mua thứ quý — đừng đập đi xây lại

Agent này đụng **DB production của khách**. Bộ khung cứng đang bảo đảm:
- Read-only enforcement (transaction READ ONLY + guard).
- Cổng approval cho fix (interrupt `need_approval`).
- Provenance/audit từng probe.
- Kiểm soát chi phí (model free, vòng lặp có trần).
- Resume qua checkpointer + interrupt.

Một ReAct agent tự do hoàn toàn sẽ đánh đổi mất tất cả: lang thang, tốn token, khó audit, nguy hiểm khi chạm prod.
**Lỗi kinh điển cần tránh:** vứt bộ khung deterministic đang chạy để lấy một agent "thông minh" mà mất kiểm soát.

## C. Hướng đề xuất: AGENCY CÓ RANH GIỚI (bounded agency)

Giữ **bộ xương** deterministic (intake · safety gate · approval · memory · finalize), thay **lõi điều tra**
(`diagnose ↔ analyze`) bằng một vòng lặp agentic có ngân sách:

1. **Tool = chính các investigator hiện tại** (đã deterministic + an toàn), expose dạng tool-calling.
   → Agency nằm ở *"nhìn cái gì tiếp theo"*, KHÔNG BAO GIỜ ở *"gây side-effect gì"*. Side-effect vẫn khóa
   read-only/approval y như cũ. Đây là ranh giới an toàn cốt lõi.
2. **Vòng quan sát mở:** mỗi bước agent đọc TOÀN BỘ quan sát tích lũy → chọn tool+args → quan sát → lặp,
   tới khi đủ tin cậy hoặc hết budget. → Gỡ A1, A3, A5, A6.
3. **Một tool "query DB tự do (read-only, có guard)":** thoát áo bó taxonomy (A2) mà vẫn an toàn nhờ
   `assertReadOnlyWhere` + transaction READ ONLY đã có. (Mongo: cho aggregate read-only có giới hạn stage.)
4. **Định tuyến theo độ khó:** ca dễ chạy đường structured rẻ/nhanh như hiện tại; chỉ **escalate** sang vòng
   agentic khi confidence cứ thấp sau 1-2 vòng. → Tận dụng cả hai, không đốt token bừa.
5. **Ngân sách rõ ràng:** trần số bước + trần token cho vòng agentic; vẫn ghi timeline/provenance từng bước.

### Cái gì GIỮ NGUYÊN vs THAY ĐỔI

| Thành phần | Quyết định |
|---|---|
| intake, gather_context, memory, finalize | **Giữ** (deterministic, rẻ) |
| Safety: read-only adapter, guard, approval gate | **Giữ tuyệt đối** — agency không chạm side-effect |
| Investigator (code/db/logs/...) | **Giữ làm tool**, bọc thêm interface tool-calling |
| planner (plan-once) | **Đổi**: từ "đẻ full plan" → "đề xuất hướng mở đầu + budget" |
| diagnose ↔ analyze (lõi) | **Đổi**: thành vòng observe→reason→act có ngân sách |
| replan/refine | **Gộp** vào vòng agentic (không còn là node tách rời) |
| Định tuyến dễ/khó | **Thêm mới** |

## D. Quan hệ với tầng 1

Tầng 1 (retrieval, markers, multi-step DB, build_snapshot) là **điều kiện cần** cho cả hai kiến trúc:
context rác thì agent loop cũng quẩn. Thứ tự đề xuất:
1. Làm A4 (giữ kết quả âm) — sửa nhỏ, lợi ngay, đúng cho mọi kiến trúc.
2. Làm P0/P1 tầng 1 (retrieval, markers).
3. Thử nghiệm vòng bounded-agency cho lõi `diagnose↔analyze`, bật theo cờ + chỉ escalate ca khó.

> **TL;DR:** workflow hiện tại đúng là khuôn mẫu (A1–A6). Đừng bỏ khung — khung đang giữ an toàn/audit/chi phí.
> Hãy nới đúng chỗ: biến lõi điều tra thành *agency có ranh giới* (tự do chọn cái để nhìn, không tự do gây tác động),
> và định tuyến theo độ khó để không trả giá token cho ca dễ.
