# FAT Architecture

FAT is an ERPNext-style ERP built as a **modular monolith** in TypeScript. This
document explains the design; see the root `README.md` for how to run it.

## Why a modular monolith

A single deployable process, but with hard internal module boundaries. Business
modules (CRM, Selling, Buying, Stock, Accounting, HR) are separate NestJS
modules that share one database and one process, yet do not import each other's
service code. Cross-module references are expressed as **data** (Link fields) and
**events**, not as compile-time dependencies. This keeps the codebase easy to
reason about and deploy, while preserving the option to split a module out later.

## The DocType engine (the core)

Everything a business module does flows through a metadata-driven engine modelled
on Frappe's DocType system.

```
*.doctype.json  ──load──▶  tabDocType / tabDocField / tabDocPerm  (metadata)
                                   │
                                   ├─ SchemaSyncService ──▶  tab<DocType>  (physical table, real columns)
                                   ├─ DocumentService   ──▶  generic CRUD REST API
                                   ├─ ValidationService ──▶  zod validation from field metadata
                                   ├─ PermissionService ──▶  role-based access per DocType
                                   └─ MetaController    ──▶  metadata for the dynamic UI
```

- **Definition** — each module ships version-controlled `*.doctype.json` files.
  On boot (`DoctypeLoaderService`) they are upserted into the metadata tables and
  registered in an in-memory `DoctypeRegistryService`.
- **Physical storage** — `SchemaSyncService` reconciles each DocType into a real
  Postgres table `tab<Name>` with a column per field (Frappe's model), not a
  JSONB bag. It is **additive only** (never drops columns) and idempotent.
- **CRUD** — one `DocumentController` at `/api/resource/:doctype` serves every
  DocType. The pipeline is: resolve meta → check permission → naming → validate →
  validate links → write parent + child rows in one transaction → emit lifecycle
  event.
- **Validation** — driven entirely by field metadata via the field-type registry
  (`core/field-types`), which maps each fieldtype to a Postgres column type, a
  coercion function, and a zod validator. The same fieldtype enum is shared with
  the frontend through `@fat/shared`.
- **Permissions** — `tabDocPerm` rows grant roles rights (read/write/create/
  delete/submit/cancel/report) per DocType, with field-level `permlevel`. Mirrors
  Frappe. `Administrator`/`System Manager` bypass.
- **Naming** — `hash`, `prompt`, `field:<f>`, or `series:<PATTERN>` (atomic
  counter in `tabSeries`, e.g. `SO-00001`).
- **Submit/cancel** — submittable DocTypes use `docstatus` (0 draft / 1 submitted
  / 2 cancelled); submitted documents are immutable.

## Cross-module boundaries

- **Links, not imports.** A Sales Invoice (Accounting) referencing a Customer
  (CRM) uses a Link field (`options: "Customer"`) resolved generically by the
  engine. No module imports another module's services.
- **Events, not calls.** Behavioural coupling uses `EventEmitter2` via
  `HooksService`. Example: `StockLedgerListener` reacts to
  `doc.on_submit:Stock Entry`; `GlPostingListener` reacts to
  `doc.on_submit:Sales Invoice`. Dependencies stay unidirectional.
- **Shared masters.** Company, Currency, UOM, Territory, Customer/Item Group,
  Fiscal Year live in `core-domain` so any module can link to them.

## Frontend — the dynamic "Desk"

The Next.js app has no per-DocType React code. Two generic routes —
`/app/[doctype]` (list) and `/app/[doctype]/[name]` (form) — fetch metadata from
`/api/meta/:doctype` and render:

- `DynamicListView` — columns from `in_list_view`, filters from
  `in_standard_filter`.
- `DynamicForm` — one renderer per fieldtype from a registry
  (`components/form/fields`), including a `LinkField` typeahead and a `TableField`
  child grid. Save/Submit/Cancel/Delete buttons honour the permission booleans in
  the meta payload.

## Data-access choice

TypeORM manages the **fixed** framework entities (`tabDocType`, `tabDocField`,
`tabDocPerm`, `tabSeries`, `tabRole`, `tabHasRole`, `tabUser`). The **dynamic**
`tab<DocType>` tables are managed by `SchemaSyncService` via parameterized raw
SQL / DDL over the same connection. Prisma was rejected because its static,
compile-time schema cannot express runtime-defined tables. All dynamic SQL uses
parameterized values and an allowlist of column identifiers derived from
validated metadata.

## Ledgers, reports, jobs, and row-level permissions

- **Ledgers.** On submit, Accounting posts balanced double-entry `GL Entry`
  records (debit Debtors / credit Sales) and Stock posts `Stock Ledger Entry`
  movements; both reverse on cancel. Implemented purely as event listeners
  (`gl-posting.listener.ts`, `stock-ledger.listener.ts`) — no cross-module
  service imports.
- **Reports.** `GET /api/report/:doctype` returns group-by aggregations
  (count / sum), honouring filters and row-level permissions. The frontend
  `/report/[doctype]` renders a bar breakdown; a print view lives at
  `/app/[doctype]/[name]/print`.
- **Background jobs.** `JobService` runs jobs on a BullMQ queue when `REDIS_HOST`
  is set, and inline otherwise — identical calling code either way. The
  `recompute_totals` job sums child-table line amounts into `total`/`grand_total`.
- **Row-level permissions.** `User Permission` records restrict a user to
  specific records; `DocumentService.list`/`canAccessRow` filter list results and
  block direct reads of disallowed rows.

## Phase 8 — depth, workflow, analytics, developer platform

- **Accounting/Stock depth.** Sales/Purchase tax child tables feed the
  `recompute_totals` job (net → taxes → grand_total). A `Bin` DocType holds
  per-item-per-warehouse moving-average valuation, maintained by the stock ledger
  listener; Delivery Note / Purchase Receipt / Payment Entry all post via the
  event bus. `GET /api/query-report/:name` serves Trial Balance & Stock Balance.
- **Workflow & audit.** `WorkflowService` runs role-gated state machines
  (`/api/workflow/...`) that submit/cancel documents; `VersionListener` records a
  diff on every update; Comment/File DocTypes + `POST /api/upload` (served at
  `/files`); `if_owner` perms scope reads to the owner.
- **UX & analytics.** Home dashboard (report-driven charts), `GET /api/search`
  global search, per-DocType saved filters, and a Print Format engine
  (`GET /api/print/...` renders `{{ field }}` templates).
- **Developer platform.** In-app DocType builder (`POST /api/admin/doctype` →
  live table), `Webhook` DocType + listener, API keys
  (`Authorization: token <key>:<secret>`), and an OpenAPI spec at
  `/api/openapi.json` with docs at `/api/docs`.

## Phase 9 — realism, platform, scale

- **Accounting realism.** Multi-currency (`conversion_rate` + base amounts; GL
  posts in base), tax-account split in GL (Dr Debtors / Cr Sales / Cr tax
  accounts), payment reconciliation (`Payment Entry Reference` → invoice
  outstanding + Paid/Unpaid), and per-item **FIFO** valuation (layers on `Bin`)
  alongside moving average.
- **Platform.** Real-time updates over **SSE** (`GET /api/stream` →
  `RealtimeBridge` invalidates React Query), **scheduled jobs** (`@nestjs/schedule`
  + on-demand `POST /api/admin/run-scheduled`), in-app **Notifications** (bell +
  listener + overdue sweep), and a **visual workflow designer** (`/desk/workflow`).
- **Scale.** `RegistrySyncService` keeps every instance's metadata cache coherent
  via Redis pub/sub — a DocType created on one node is picked up live by the
  others (verified with two instances), closing the multi-instance gap.

## Phase 10 — completeness, interop, hardening

- **Accounting completeness.** Batch tracking (`Batch` DocType + `batch_no` on
  stock movements/ledger + batch-wise stock balance), cost centers (stamped on
  GL), budgets + Budget-vs-Actual, and **Profit & Loss / Balance Sheet**
  query-reports (GL joined to `Account.account_type`).
- **Platform interop/views.** Email transport for notifications (nodemailer;
  log-only until SMTP), CSV **import/export** (`/api/resource/:doctype/export|import`),
  **Kanban** (drag between Select columns) and month **Calendar** views, and
  server-rendered **PDF** print (`/api/print/.../pdf` via the bundled Chromium).
- **Hardening.** `@nestjs/throttler` rate limiting, an audit-log **retention**
  sweep (`RETENTION_DAYS`), an **RBAC admin** UI/endpoints (`/desk/rbac`,
  `/api/admin/rbac`), and a **Playwright e2e** suite (`apps/e2e`) wired into a
  dedicated CI job that seeds + boots both apps and runs the specs.

## Phase 11 — serial/batch depth, POS, GraphQL

- **Stock depth.** Serial numbers (`Serial No` DocType; `serial_no` on stock
  movements + ledger; the stock-ledger listener creates serials Active on receipt
  and flips them Delivered on issue) and **per-batch valuation** — `Bin` is now
  keyed by `item::warehouse::batch`, so moving-average/FIFO cost is tracked per
  batch and the stock-balance report re-aggregates back to item+warehouse.
- **Period close.** `Period Closing Voucher` (submittable): the GL listener zeroes
  every income/expense balance and books the net profit/loss into the equity
  closing account (Retained Earnings) with a balanced entry, reversible on cancel.
- **Point of Sale.** `/pos` rings up a sale — one tap posts a Sales Invoice + a
  reconciled Payment Entry. It is **offline-resilient**: when offline or the server
  is unreachable the order is persisted to a localStorage queue and retried
  automatically on reconnect (invoice name is stamped before payment so a
  mid-sequence retry never duplicates the invoice).
- **GraphQL alongside REST.** One generic Apollo (code-first) schema over the
  DocType engine — `documents`/`document` queries and `saveDocument`/
  `submitDocument`/`cancelDocument`/`deleteDocument` mutations — reusing
  `DocumentService` and the same permission checks. The global JWT guard,
  `CurrentUser`, and the throttler are execution-context aware (`requestFrom()`)
  so auth applies to REST and GraphQL alike.

## Known limitations (still open)

- Multi-currency has a single conversion rate (no revaluation); serial numbers
  track status/movement but not per-serial valuation.
- Email is log-only without SMTP; SSE stream is unauthenticated (doctype + name
  only); webhooks/print are best-effort.
- POS offline retry can duplicate a *payment* (not the invoice) if the invoice
  submitted but the client never saw the response; GraphQL exposes no
  subscriptions yet.
- The DocType builder does not yet edit child-table field layouts in the UI.
