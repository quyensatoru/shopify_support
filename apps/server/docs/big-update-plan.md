# Big Update Plan — Support Agent

> **TRẠNG THÁI TRIỂN KHAI** (cập nhật): Phase 0, 1, 2, 3 — ✅ ĐÃ IMPLEMENT (typecheck pass).
> Phase 4 (bounded agency) — ✅ scaffold đã implement nhưng **flag-gated, mặc định TẮT**:
> chạy khi `INVESTIGATION_MODE=agentic` (cần `ANTHROPIC_API_KEY`, phát sinh phí). Mặc định `structured`
> giữ nguyên hành vi cũ. `auto` (định tuyến tự động theo độ khó) CHƯA làm — cần wiring loop-back, để sau.
> Chi tiết các file đã đổi xem mục cuối "Đã implement".


> Cơ sở: `docs/context-prompt-review.md` (Tầng 1: chất lượng context; Tầng 2: linh hoạt cấu trúc).
> Plan này liệt kê **chính xác file/đoạn code cần đổi**, chia 5 phase theo thứ tự rủi ro thấp→cao và phụ thuộc.
> Mỗi mục ghi rõ: mục tiêu · file · thay đổi · ánh xạ take-note.
>
> Nguyên tắc xuyên suốt: **mọi side-effect vẫn khóa read-only/approval**; chỉ nới tự do ở khâu *điều tra*.

## Bản đồ phụ thuộc (đọc trước khi làm)

```
Phase 0 (quick wins, độc lập)
   └─> Phase 1 (retrieval) ────┐
   └─> Phase 2 (multi-step DB) ─┼─> Phase 4 (bounded agency)
Phase 3 (knowledge cleaning) ───┘        (cần Phase 1+2 ổn trước)
```
Phase 0/1/2/3 đều cải thiện cả kiến trúc hiện tại lẫn agentic về sau → **làm trước, độc lập**.
Phase 4 là thay đổi lớn nhất → chỉ bắt đầu khi context (1,2,3) đã sạch.

---

## PHASE 0 — Quick wins (1 buổi, rủi ro thấp, độc lập)

### 0.1 Giữ bằng chứng phủ định *(take-note A4 — bug-ish, lợi ngay)*
- **Vấn đề:** [graph/nodes/diagnose.ts:14-24](../src/graph/nodes/diagnose.ts) `evidenceFromResult` chỉ giữ `found===true` → "shop không tồn tại / queue rỗng / không có data 24h" bị vứt.
- **Đổi:**
  - `evidenceFromResult`: tạo evidence cho **cả** probe `status==='done'` (kể cả `found===false`); thêm trường `polarity: 'positive'|'negative'`, claim ghi rõ "not found / empty".
  - `packages/shared/src/state/index.ts` — `EvidenceSchema` thêm `polarity` (optional, default 'positive').
  - `reasoning/analyze.ts` — evidenceSummary in kèm polarity; thêm 1 dòng hướng dẫn: "kết quả phủ định cũng là bằng chứng, dùng để loại/khẳng định hypothesis".
- **Rebuild shared.**

### 0.2 Trần số probe trong planner *(take-note #8)*
- **File:** [reasoning/plan.ts](../src/reasoning/plan.ts) (prompt instructions).
- **Đổi:** thêm "Tối đa ~2-3 repo liên quan nhất + 2-3 DB source liên quan nhất, ≤ 8 probe mỗi vòng. Ưu tiên theo từ khóa kỹ thuật."

### 0.3 Bổ sung `snapshot` vào danh sách surface *(take-note #11)*
- **File:** [reasoning/plan.ts](../src/reasoning/plan.ts) dòng "surface options".
- **Đổi:** `code | database | logs | shopify | browser | config | snapshot`.

---

## PHASE 1 — Retrieval code (P0/P1, đòn bẩy lớn nhất)

### 1.1 Khóa truy hồi code = keyword kỹ thuật tiếng Anh *(take-note #1 + #3 — P0)*
- **Vấn đề:**
  - [gatherContext.ts:42](../src/graph/nodes/gatherContext.ts) `buildRepoContext(cg, request.issueText)` → truyền nguyên văn tiếng Việt.
  - [gatherContext.ts:47-49](../src/graph/nodes/gatherContext.ts) `searchSymbols(cg, request.issueText.split(' ').slice(0,3).join(' '), 10)` → lấy "Khách báo ko" làm symbol query.
- **Đổi:**
  - Thêm bước **trích keyword kỹ thuật** (English) từ issue. Hai lựa chọn:
    - (a) 1 call LLM rẻ ở `intake` → sinh `searchKeywords: string[]` + `caseHints` (vd `["heatmap","render","canvas","rrweb","snapshot","blank"]`). Lưu vào state.
    - (b) Heuristic + bảng map thuật ngữ (rẻ, không cần LLM) — kém linh hoạt hơn.
  - Khuyến nghị (a): thêm node nhỏ `extract_keywords` hoặc gộp vào intake; lưu `state.searchQuery` / `state.searchKeywords`.
  - `gatherContext.ts`: dùng `state.searchQuery` (English) cho `buildRepoContext` và `searchSymbols`, KHÔNG dùng issueText thô.
- **File:** `graph/nodes/intake.ts` (hoặc node mới), `graph/state.ts` (+`searchKeywords`), `gatherContext.ts`, `packages/shared/src/state` nếu thêm field state.

### 1.2 Xếp hạng symbol, loại boilerplate *(take-note #3 — P1)*
- **Vấn đề:** [codegraph.ts:116-123](../src/connectors/codegraph.ts) `searchSymbols` trả top theo FTS; gatherContext nhận về toàn `import koa`, `Router`, `constant app`.
- **Đổi:**
  - Trong `codegraph.ts` (hoặc khi map ở gatherContext): lọc bỏ symbol kind/boilerplate (`import`, tên `app/Koa/Router/cors/koaBody...`); rank theo độ khớp `searchKeywords`; ưu tiên symbol nằm trong file có path khớp keyword (vd `render`, `heatmap`, `snapshot`).
  - Giữ ≤ N symbol điểm cao (vd 8), bỏ phần "top symbol của repo".

### 1.3 Tổng quát hóa expectedMarkers cho SPA *(take-note #4 — P1)*
- **Vấn đề:** [codegraph.ts:191-212](../src/connectors/codegraph.ts) `detectExpectedMarkers` chỉ tìm `handle` field + `customElements` (heuristic Shopify-theme) → app React/heatmap trả `[]` → guardrail viện dẫn markers nhưng rỗng → browser probe bị khóa.
- **Đổi:**
  - Mở rộng detect: canvas/container selector & id, hằng render (`HEATMAP_GRADIENT`), tên hàm render/mount, custom element, data-attribute. Gợi ý từ `searchKeywords`.
  - Đảm bảo prompt luôn render section "Expected browser markers" khi có; nếu thực sự không có marker, **nới guardrail** cho phép browser probe dùng selector suy từ code render đã thấy (thay vì bắt vào missingContext).
- **File:** `connectors/codegraph.ts`, `reasoning/plan.ts` (guardrail browser).

---

## PHASE 2 — Multi-step DB · identifiers · snapshot refine *(nối tiếp 2 update trước)*

### 2.1 Chuẩn hóa identifiers *(take-note #5)*
- **Vấn đề:** [intake.ts](../src/graph/nodes/intake.ts) không sinh identifiers; prompt thiếu dòng `Identifiers:` (chỉ có Store domain).
- **Đổi:** ở intake, suy `store_domain` từ `request.storeDomain/storeUrl` vào `request.identifiers` (chuẩn `{kind:'store_domain', value}`). Chuẩn hóa thêm `shop_id` nếu có trong metadata/providedContext.

### 2.2 Query DB phụ thuộc kết quả (chuỗi domain→shop_id→data) *(take-note #5)*
- **Vấn đề:** `runDbQueryReasoning` sinh query 1 lượt; nếu chỉ có domain mà bảng data cần `shop_id` thì tắc.
- **Đổi:**
  - Cho `probeRefine` chạy **nhiều vòng phụ thuộc** (đã có `refineCount`, nâng `MAX_REFINE` lên ~3 và nới điều kiện): vòng 1 discover; vòng 2 lookup shop theo domain → lấy shop_id (đưa vào evidence/identifiers); vòng 3 query data theo shop_id.
  - `runDbQueryReasoning`: nhận thêm `resolvedIds` (id lấy được từ vòng trước) để bắc cầu; cho phép đánh dấu probe "lookup id" vs "query data".
  - Cập nhật `needsRefine` để nhận biết "đã có shop_id chưa" trước khi query bảng data.
- **File:** `graph/nodes/probeRefine.ts`, `reasoning/dbQuery.ts`, có thể `graph/state.ts` (lưu `resolvedIds`).

### 2.3 Sinh `build_snapshot` ở refine sau discover *(take-note #6 — khép kín snapshot)*
- **Vấn đề:** `build_snapshot` cần `recordingId` + field thật → không phát được ở plan đầu; `probeRefine` hiện chưa sinh nó.
- **Đổi:** trong `probeRefine`, khi caseType/keyword là recording/heatmap **và** đã có schema (discover) + shop_id → sinh `build_snapshot` (source/collection/idField/snapshotField/recordingId thật, lấy recordingId từ kết quả query session/heatmap của shop). Thêm reasoning nhỏ `reasoning/snapshotProbe.ts` hoặc mở rộng `dbQuery`.
- **File:** `graph/nodes/probeRefine.ts`, reasoning tương ứng.

### 2.4 Vai trò repo *(take-note #7)*
- **Vấn đề:** [config/index.ts:13-21](../src/config/index.ts) repos chỉ có name/url/branch; planner không biết repo nào lo gì (7 repo).
- **Đổi:** `RepoConfigSchema` (+`role?`/`description?`); `resolveAppConfig` map thêm; `reasoning/plan.ts` in vai trò repo vào configSummary để định hướng probe.
- **File:** `packages/shared/src/domain/index.ts`, `config/index.ts`, `reasoning/plan.ts`. **Rebuild shared.** (Cần cập nhật dữ liệu config app — task vận hành.)

---

## PHASE 3 — Làm sạch App Knowledge *(take-note #2 — P0, độc lập)*

- **Vấn đề (xác nhận):** `knowledge/index.ts` — firecrawl markdown **không** được làm sạch; `chunkText` cắt cứng 800 ký tự, không overlap, tối đa 10 chunk; retrieval top-k **không ngưỡng** (`db/repo` `similarAppKnowledge` `ORDER BY distance LIMIT k`, không `WHERE distance <`).
- **Đổi:**
  1. **Làm sạch sau crawl:** strip markdown image `![](...)`, bare URL, dòng nav/footer/cookie ("Accept/Reject", "This site uses cookies", "Last updated ... ago"), heading rỗng. Áp cho cả nhánh firecrawl (hiện bỏ trống) lẫn tavily.
  2. **Chunk theo đoạn văn:** tách theo heading/đoạn (`\n\n`), gộp tới ~800-1000 ký tự có overlap ~100, không cắt giữa câu.
  3. **Ngưỡng relevance:** `similarAppKnowledge` thêm lọc `distance < threshold` (cosine), bỏ chunk quá xa; gatherContext chỉ nhận chunk đạt ngưỡng.
- **File:** `knowledge/index.ts` (clean + chunk), `db/repo/index.ts` (`similarAppKnowledge` thêm threshold), `gatherContext.ts` (lọc theo score).

---

## PHASE 4 — Bounded agency cho lõi điều tra *(Tầng 2 — thay đổi lớn nhất)*

> Mục tiêu: thay lõi cứng `diagnose → refine → analyze → replan` bằng **vòng agentic có ngân sách**, giữ nguyên bộ xương + safety.
> CHỈ bắt đầu khi Phase 1-3 đã ổn (context sạch). Bật theo cờ, có đường lui về luồng cũ.

### 4.0 Tiền đề: model có tool-calling
- **Vấn đề:** [llm/index.ts](../src/llm/index.ts) hiện chỉ có structured-output qua model **free** `gpt-oss-120b:free` (`response_format: json_object`); Anthropic đang bị comment; **chưa có** đường tool-calling.
- **Quyết định cần chốt:** vòng agentic cần model gọi tool ổn định (thực tế là Anthropic). Đề xuất: **định tuyến theo độ khó** — ca dễ chạy luồng structured rẻ (free model) như hiện tại; chỉ **escalate** sang vòng agentic + Anthropic khi confidence thấp sau 1-2 vòng. Cost chỉ phát sinh ở ca khó.
- **File:** `llm/index.ts` thêm `getToolCallingLlm()` (Anthropic `.bindTools`).

### 4.1 Tool hóa investigator
- **Đổi:** bọc `dispatchInvestigator` thành tập tool LangChain/Anthropic (mỗi surface 1 tool, hoặc 1 tool `run_probe(surface, action, target)`), schema = ProbeTarget. Investigator giữ nguyên (đã deterministic + read-only).
- **Thêm tool "query DB read-only tự do"** *(take-note A2 — thoát áo bó)*: 1 tool nhận SELECT/aggregate read-only, đi qua `assertReadOnlyWhere` + transaction READ ONLY đã có (Mongo: aggregate giới hạn stage, cấm `$out/$merge`).
- **File:** mới `graph/agent/tools.ts`, dùng lại `investigators/*`, `connectors/db/*`.

### 4.2 Node vòng điều tra agentic
- **Đổi:** node mới `investigate_loop`: agent đọc toàn bộ quan sát tích lũy (probe results raw, không chắt lọc mất mát) → chọn tool → quan sát → lặp tới khi đủ tin cậy / hết budget (trần bước + trần token). Ghi timeline + provenance mỗi bước (giữ audit).
- Thay cụm `diagnose ↔ refine_probes ↔ analyze ↔ replan` bằng node này (giữ `analyze` cuối để chốt synthesis có cấu trúc cho fix/memorize).
- **File:** mới `graph/nodes/investigateLoop.ts`; sửa `graph/graph.ts` (định tuyến theo độ khó: structured-first → escalate); `graph/state.ts` (budget/agent scratchpad).

### 4.3 Giữ nguyên (KHÔNG đổi)
- `intake`, `gather_context`, `memorize`, `finalize`.
- Safety: read-only adapter + guard + `approve`/`fixApply` gate.
- Interrupt `need_context` / `need_approval`, checkpointer/resume.

### 4.4 Rủi ro & kiểm soát
- Lang thang/tốn token → trần bước + trần token + early-stop khi confidence cao.
- Không xác định → vẫn ghi provenance, có thể replay.
- Đường lui: cờ `INVESTIGATION_MODE=structured|agentic|auto(default)`.

---

## Bảng ánh xạ take-note → phase

| Take-note | Mô tả | Phase |
|---|---|---|
| A4 | Giữ bằng chứng phủ định | 0.1 |
| #8 | Trần số probe | 0.2 |
| #11 | surface list thiếu snapshot | 0.3 |
| #1 | Query codegraph tiếng Việt | 1.1 |
| #3 | Symbol boilerplate, không rank | 1.1 + 1.2 |
| #4 | Expected markers rỗng cho SPA | 1.3 |
| #5 | Identifiers + multi-step DB | 2.1 + 2.2 |
| #6 | build_snapshot ở refine | 2.3 |
| #7 | Vai trò repo | 2.4 |
| #2 | App knowledge rác | 3 |
| #9 | Cắt cụt code giữa token | 1.2 (kèm) |
| #10 | caseType recording | 2.3 (kèm) |
| A1,A2,A3,A5,A6 | Rigidity cấu trúc | 4 |

## Thứ tự đề xuất triển khai
1. **Phase 0** (1 buổi) — lợi ngay, không rủi ro.
2. **Phase 1 + Phase 3 song song** — đều là retrieval, độc lập nhau; đòn bẩy lớn nhất cho chất lượng.
3. **Phase 2** — khép kín luồng DB nhiều bước + snapshot (nối 2 update trước).
4. **Phase 4** — sau khi context đã sạch; bật `auto`, escalate ca khó sang agentic.

> Khuyến nghị: KHÔNG nhảy thẳng Phase 4. Context rác (Phase 1-3 chưa làm) thì agent loop cũng quẩn và còn đốt token hơn.
