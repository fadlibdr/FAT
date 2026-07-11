# FAT — a modular-monolith ERP (ERPNext-style)

FAT is an ERPNext-inspired ERP built as a **modular monolith** in TypeScript.
Its core is a **metadata-driven DocType engine** (à la Frappe): business objects
are defined by metadata, and the framework auto-generates database tables, CRUD
REST APIs, validation, permissions, and dynamic forms/list views.

## Stack

- **Backend:** NestJS + TypeORM + PostgreSQL
- **Frontend:** Next.js (App Router) — a dynamic "Desk" that renders from metadata
- **Shared:** `@fat/shared` — DocType/fieldtype types and zod schemas used by both
- **Monorepo:** pnpm workspaces + Turborepo

## Architecture

```
apps/backend      NestJS API — the DocType engine + business modules
apps/frontend     Next.js Desk — dynamic list/form views
packages/shared   Shared TypeScript types + zod schemas
```

The engine lives in `apps/backend/src/core`:

- `core/doctype` — DocType/DocField metadata, registry, loader, runtime schema
  sync (DDL), the generic Document CRUD service/controller, validation, naming.
- `core/permissions` — Frappe-style role permissions + guard.
- `core/meta` — serves metadata to the frontend.
- `core/field-types` — maps each fieldtype to a Postgres column type, a
  validator, and a frontend widget key.

Business modules (`apps/backend/src/modules/*`) are thin: each ships
`*.doctype.json` files and registers them with the engine. Cross-module
references are **Link fields (data)**, not code imports.

## Quick start

```bash
# 1. Start Postgres + Adminer
docker compose up -d

# 2. Configure env
cp .env.example .env

# 3. Install deps
pnpm install

# 4. Create framework tables + seed (admin user, roles, DocTypes, sample data)
pnpm backend:migration:run
pnpm backend:seed

# 5. Run everything (backend :3001, frontend :3000)
pnpm dev
```

Then open http://localhost:3000, log in with the credentials from `.env`
(`admin@example.com` / `admin`), and open a DocType such as `/app/todo`.

Adminer (DB browser) is at http://localhost:8080 (server `postgres`, user/pass
`fat`). Auto-created document tables are named `tab<DocType>` (e.g. `tabToDo`).

## Modules included

Core framework + `core-domain` masters, plus CRM, Selling, Buying, Stock,
Accounting, and HR as metadata-defined modules.

## Beyond CRUD

- **Ledgers** — submitting a Sales Invoice posts balanced GL entries; submitting a
  Stock Entry posts stock ledger movements (both reverse on cancel), via events.
- **Reports** — `GET /api/report/:doctype` group-by aggregations; a `/report/…`
  UI and a printable document view at `/app/…/print`.
- **Background jobs** — `JobService` runs on BullMQ when `REDIS_HOST` is set
  (`docker compose up -d redis`), inline otherwise.
- **Row-level access** — `User Permission` records restrict users to specific rows.

## Phase 8 (also merged/in progress)

- **Accounting/Stock depth** — tax tables + grand totals, moving-average item
  valuation (`Bin`), Delivery Note / Purchase Receipt / Payment Entry postings,
  and Trial Balance + Stock Balance reports.
- **Workflow & audit** — role-gated approval workflows, version history, comments,
  file attachments, and `if_owner` permissions.
- **Analytics & UX** — a dashboard, global search, saved filters, and a
  print-format engine.
- **Developer platform** — an in-app DocType builder, webhooks, API keys
  (`Authorization: token <key>:<secret>`), and OpenAPI docs at `/api/docs`.

## Phase 9

- **Accounting realism** — multi-currency (base amounts), tax-split GL, payment
  reconciliation (invoice outstanding → Paid/Unpaid), and FIFO valuation.
- **Platform** — real-time SSE list refresh, scheduled jobs, in-app notifications,
  and a visual workflow designer.
- **Scale** — multi-instance metadata-cache coherence via Redis pub/sub.

## Phase 10

- **Accounting completeness** — batch tracking, cost centers, budgets, and
  Profit & Loss / Balance Sheet reports.
- **Interop & views** — email notifications, CSV import/export, Kanban + calendar
  views, and server-rendered PDF print.
- **Hardening** — rate limiting, audit-log retention, an RBAC admin UI, and a
  Playwright e2e suite in CI.

## Phase 11

- **Stock depth** — serial numbers (`Serial No`, Active→Delivered) and per-batch
  valuation (`Bin` keyed by item+warehouse+batch).
- **Period close** — a `Period Closing Voucher` moves net profit/loss into equity
  (Retained Earnings) with a balanced GL entry.
- **Point of Sale** — `/pos` posts an invoice + reconciled payment in one tap,
  with an offline localStorage queue that auto-syncs on reconnect.
- **GraphQL** — a generic Apollo schema at `/graphql` over the same DocType
  engine and permissions (`documents`/`document` queries, `saveDocument`/
  `submitDocument`/`cancelDocument`/`deleteDocument` mutations).

## Phase 12

- **Manufacturing** — `BOM` + `Work Order`; submitting a Work Order issues raw
  materials and receives the finished good (Manufacture stock entry) at rolled-up
  material cost.
- **Projects** — `Project`, `Task`, and a submittable `Timesheet` that rolls
  billable hours × rate onto the project.
- **Assets** — `Asset` + `Depreciation Entry` posting straight-line depreciation
  (Dr Depreciation Expense / Cr Accumulated Depreciation) to the GL.

## Phase 13

- **Payroll** — `Salary Component`, `Salary Structure` (earnings/deductions), and
  a submittable `Salary Slip` that computes gross/deduction/net and books a
  balanced journal (Dr earnings, Cr deductions + net pay to the payable account).
- **Pricing rules** — a `Pricing Rule` (by item/item-group, customer, min qty)
  applied through a new pre-write engine hook: it sets a line's fixed rate or a
  discount % before totals are computed.
- **Support** — `Service Level Agreement` (per-priority response/resolution
  targets) and `Issue`, which is stamped with SLA deadlines on creation and
  marked Fulfilled/Failed when resolved.

## Phase 14

- **CRM pipeline** — converting a `Lead` creates a `Customer`; converting an
  `Opportunity` (with items) spins up a draft `Quotation`, both linked back.
- **Subscriptions** — `Subscription Plan` + `Subscription`; a daily (and
  on-demand) run bills every due subscription, submitting a Sales Invoice and
  advancing the next billing date.
- **Loyalty** — a `Loyalty Program` accrues points on Sales Invoice submit into a
  `Loyalty Point Entry` ledger; balance at `GET /api/loyalty/balance/:customer`.

## Phase 15

- **Stock Reconciliation** — a physical-count voucher asserts absolute on-hand
  quantities per item+warehouse; on submit it posts an adjusting Stock Ledger
  Entry for the difference (driving each `Bin` to the counted qty/valuation) and
  records the net valuation change. Cancel reverses it.
- **Auto-reorder** — Items carry a `reorder_level`/`reorder_qty`; a daily (and
  on-demand `POST /api/buying/run-reorder`) run raises one submitted `Material
  Request` for every item below its level, and `POST /api/buying/material-request/
  :name/make-purchase-order` turns a request into a draft `Purchase Order`
  (stamping ordered qty and linking both).
- **Quality Inspection** — a `Quality Inspection` (with a readings grid) whose
  status is derived from the readings (Rejected if any reading fails). A new
  awaitable `before_submit` engine gate blocks a `Purchase Receipt` from being
  submitted until every item flagged *inspection required* has a submitted,
  Accepted inspection referencing that receipt.

See `docs/ARCHITECTURE.md` for the full design.
