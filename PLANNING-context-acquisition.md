# Plan: Context-Acquisition + Investigator Deepening (chống hallucination)

> Bản plan để review. Chưa code. Nguồn: thảo luận M2 — nâng chất lượng context cho Planner + đào sâu investigator.

## Context — Vì sao cần thay đổi

Hiện `reasoning/plan.ts` (Planner) sinh hypotheses + probes mà **gần như không có context thật** về app:

- Prompt chỉ thấy: **tên** repo, **key** db source, shopify có/không cấu hình (`plan.ts:82-84`).
- KHÔNG biết: app làm gì, kiến trúc source code, tên file/symbol thật, scopes/webhooks thật, schema DB.

Hệ quả: probe target (`regex`, `glob`, `marker`, `query`) bị **đoán bừa**. Investigator chỉ thực thi mù:

- `code.ts:58-72` grep theo regex LLM tự chế.
- `browser.ts:22-42` check `marker` LLM tự bịa → tìm không ra (false negative) hoặc tìm trúng thứ vô quan (false positive) → **hallucination** ở root cause.

Thêm: RAG memory hiện là **keyword-only** — `getEmbedding` trả `null` khi thiếu `EMBEDDING_API_URL` (`memory/index.ts:27-47`), nên `similarMemories` (pgvector) chưa bao giờ chạy thật.

**Mục tiêu:** chèn một pha **thu thập context** (codebase map + app knowledge từ web) trước Planner, nạp context đó vào reasoning, và **đào sâu investigator** để mọi probe đều neo vào sự thật thay vì đoán.

## Quyết định đã chốt (từ Q&A + nghiên cứu)

| Hạng mục     | Chốt                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Code map     | Tích hợp **`@colbymchenry/codegraph@^0.9.9`** (lib nhúng), không tự build codegraph            |
| Repo lang    | Node/TS + đa ngôn ngữ → codegraph WASM tree-sitter phủ 20+ lang (TS/JS/PHP/Ruby/Liquid/Vue...) |
| App info web | **Web search theo tên app (Tavily)** + **crawl docUrls/homepage cấu hình** (Playwright)        |
| Embeddings   | **OpenAI `text-embedding-3-small`** (1536-dim, khớp cột pgvector sẵn có)                       |
| Fallback     | **Không dùng fallback** (theo triết lý PLANNING): thiếu nguồn → **skip kèm reason**            |

**codegraph fit:** WASM tree-sitter (`web-tree-sitter` + `tree-sitter-wasms`) → **không cần native build**, chạy Windows OK; engines `node >=20 <25`, dùng `node:sqlite` → Node 22.22 hiện tại ✓; lưu `.codegraph/codegraph.db` per-repo (cache tự nhiên, `sync()` incremental). API nhúng: `CodeGraph.init/open(path)`, `indexAll()`, `sync()`, `searchNodes()`, `getCallers()`, `callees()`, `getImpactRadius()`, `buildContext(query,{format:'markdown'})`.

## Kiến trúc mới — luồng graph

```
intake → gather_context (MỚI) → planner → ...giữ nguyên...
```

`gather_context` là node **deterministic** (chỉ 1 LLM-light để distill khi cần), chạy 2 việc **song song**:

1. **Code index** (codegraph): mỗi repo → cloneOrPull → open/sync (hoặc indexAll lần đầu) → `buildContext(issueText)` → `codeContext`.
2. **App knowledge** (RAG): retrieve top-k chunk từ `app_knowledge` theo issue. Nếu app **chưa từng learn** và có nguồn → `learnApp()` inline 1 lần (crawl + distill + embed + store) rồi retrieve. Lần sau chỉ retrieve (cache, không crawl lại).

## Triển khai theo phase

### Phase A — Embeddings thật + memory RAG (nền tảng, nhỏ)

- `env.ts`: thêm `EMBEDDING_MODEL` (default `text-embedding-3-small`), `TAVILY_API_KEY` optional.
- **Mới** `apps/server/src/llm/embeddings.ts`: `embed(text|text[]): number[]` dùng `openai` SDK (`client.embeddings.create`). Trả null/throw rõ ràng nếu thiếu `OPENAI_API_KEY` (không tự chế).
- `memory/index.ts`: thay `getEmbedding` stub → gọi `embed()`; `retrieveMemories` dùng **vector-only** `similarMemories(app, embeddingJson)` (đã có sẵn `db/repo/index.ts:188`). **KHÔNG fallback keyword** — nếu không embed được (thiếu key/lỗi) → retrieve trả rỗng + ghi reason. Có thể bỏ luôn nhánh `listMemories` keyword trong `retrieveMemories`.
- **Verify:** tạo 1 run → memorize → check cột `embedding` có giá trị; run thứ 2 issue tương tự → log cho thấy retrieve theo vector.

### Phase B — Codegraph integration (giá trị lớn nhất)

- `package.json` (server): thêm `@colbymchenry/codegraph`. Kiểm tra `skipLibCheck:true` trong tsconfig (thêm nếu thiếu).
- **Mới** `apps/server/src/connectors/codegraph.ts`: wrapper cache theo `repoPath` (Map in-process) — `ensureIndex(repo, repoPath, gitlab)` (cloneOrPull + open/sync/indexAll), `buildContext(repoPath, query)`, `searchNodes`, `getCallers`, `getCallees`, `getImpactRadius`. Đặt `.codegraph` trong `WORKSPACE_DIR/<repo>`.
- **Mới** `apps/server/src/graph/nodes/gatherContext.ts`: node `gather_context` (xem luồng trên). Ghi `codeContext` (+ `appKnowledge` ở Phase C) vào state + timeline.
- `graph/graph.ts`: thêm node `gather_context`; đổi edge `intake → gather_context → planner` (thay `intake → planner` ở `graph.ts:46`).
- `packages/shared/src/state/index.ts`: thêm slice `codeContext` (per-repo: `{repo, framework?, scopes?, webhooks?, entryPoints[], relevantSymbols[], contextMarkdown, expectedMarkers[]}`) + reducer trong `graph/state.ts`.
- `reasoning/plan.ts` + `reasoning/analyze.ts` + `reasoning/fixPlan.ts`: nạp `codeContext` vào prompt. **Guardrail** Planner: "probe target (regex/glob/marker/query/symbol) CHỈ được tham chiếu file/symbol/marker có thật trong code map dưới đây; thiếu dữ kiện → đưa vào `missingContext`, KHÔNG đoán."
- **Đào sâu `code` investigator** (`investigators/code.ts`): thêm action codegraph `find_symbol` / `find_callers` / `find_callees` / `impact` / `build_context` như các action **đồng hạng** (Planner chọn action phù hợp theo mục tiêu, không phải fallback). `search_code` regex vẫn là 1 action hợp lệ cho trường hợp grep chuỗi cụ thể. Thêm các action vào `ProbeTargetSchema`/handling (`domain/index.ts`). → probe code chính xác theo symbol thật; phục vụ luôn `mode:fix` (impact radius).
- **Verify:** run issue dạng code → timeline có `gather_context`; log `buildContext` markdown; probe `code` trả symbol/caller thật (không phải regex bừa).

### Phase C — App knowledge từ web (cache, không crawl lại)

- DB: thêm vào mảng `MIGRATIONS` (`db/migrate.ts`) + drizzle schema (`db/schema/index.ts`):
    - `app_knowledge`: `id, app_key, source(web_search|doc_url|app_store), url, title, chunk TEXT, embedding vector(1536), content_hash, created_at` + index theo `app_key`.
    - Track freshness: cột `learned_at`/`sources_hash` lưu trong `app_configs.config` jsonb (không cần bảng mới).
- `domain` + `contracts` + `config/index.ts` + `apps.ts`: thêm field **không bí mật** `appStoreUrl?`, `docUrls?: string[]`, `homepage?`, `appDescription?` vào AppConfig (resolver + write schema; không mã hoá, không mask).
- **Mới** `apps/server/src/connectors/search.ts`: Tavily REST (`POST https://api.tavily.com/search`, plain fetch). Skip kèm reason nếu thiếu `TAVILY_API_KEY`.
- **Mới** `apps/server/src/knowledge/index.ts`:
    - `learnApp(appKey)`: web search theo tên app (Tavily) + crawl `docUrls`/`appStoreUrl`/`homepage` (tái dùng `connectors/playwright.ts renderPage`) → chunk → `embed()` → store `app_knowledge` (dedup theo `content_hash`); set `learned_at`. Reuse pattern distill của `reasoning/distill.ts` để tạo `appKnowledge.summary` ngắn.
    - `retrieveAppKnowledge(appKey, issueText, k)`: pgvector top-k (raw SQL như `similarMemories`).
- `gatherContext.ts`: gọi `retrieveAppKnowledge`; nếu rỗng + có nguồn → `learnApp` inline 1 lần. Ghi `appKnowledge` vào state.
- `reasoning/plan.ts`: nạp `appKnowledge.summary` + chunks vào prompt.
- **Mới** API `POST /api/apps/:appKey/learn` (`http/routes/apps.ts`): (re)build knowledge chủ động (pre-warm từ UI). Trả số chunk đã lưu.
- **Verify:** cấu hình app có `docUrls`/`appStoreUrl` + set `TAVILY_API_KEY` → gọi `/learn` → `app_knowledge` có rows + embedding; run mới → Planner prompt chứa app summary.

### Phase D — Đào sâu `browser` (và các surface nông khác)

- `investigators/browser.ts`: `marker` của `check_markers` lấy từ `codeContext.expectedMarkers` (handle block theme-extension trong `shopify.extension.toml`/`blocks/*.liquid`, app-embed handle, script asset, web-component tag — trích deterministic khi index repo) thay vì LLM bịa; nếu probe không có marker → tự suy ra từ codeContext. Thu thập tín hiệu giàu hơn: CSP/`frame-ancestors` header, sự hiện diện App Bridge, pattern console error, network 4xx/5xx tới host app → trả structured signals kèm provenance để `analyze` suy luận trên dữ liệu thật.
- Rà các action "nông" khác (`config.diff_expected` đang trả placeholder `config.ts:32-49`) → ghi chú nâng cấp khi có context thật.
- **Verify:** run issue `storefront_extension`/`embedded_admin_ui` có `storeUrl` → browser probe dùng marker thật từ repo; data trả về có CSP/console/network signals.

## Rủi ro / điểm cần lưu ý

- `node:sqlite` còn ExperimentalWarning ở Node 22 — chạy được nhưng có warning; xác nhận khi smoke-test codegraph (Phase B đầu tiên).
- Lần `indexAll` đầu trên repo lớn tốn thời gian → chạy 1 lần rồi `sync()`; cache `.codegraph.db` trong workspace persist qua các run.
- `learnApp` inline lần đầu thêm latency cho run đó → khuyến khích pre-warm qua `POST /learn` từ UI.
- Tavily cần API key (free tier) — thiếu key thì nhánh web-search **skip kèm reason** (không phải fallback; đúng triết lý PLANNING). Crawl docUrls/homepage vẫn chạy nếu có.
- Embeddings phụ thuộc `OPENAI_API_KEY` — thiếu key thì RAG (memory + app_knowledge) **skip kèm reason**, KHÔNG tụt về keyword. Luồng graph không vỡ, chỉ là không có context RAG.

## Verify tổng thể (end-to-end)

1. `pnpm --filter @shopify-support/server typecheck` sạch sau mỗi phase.
2. `tsx src/db/migrate.ts` chạy migration mới (app_knowledge).
3. Smoke test codegraph riêng: script nhỏ `CodeGraph.init(<repo>)` + `buildContext('session token')` in markdown.
4. Tạo run `mode:diagnose` interactive: timeline phải có `intake → gather_context → planner → diagnose → analyze`; kiểm tra Planner prompt (log) đã chứa codeContext + appKnowledge; probe có target neo vào symbol/marker thật.
5. So sánh trước/sau: cùng 1 issue, số probe "found đúng" tăng, ít verdict `inconclusive` do đoán bừa.
