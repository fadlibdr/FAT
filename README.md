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

See `docs/ARCHITECTURE.md` for the full design.
