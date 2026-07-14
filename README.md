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

## Phase 16

- **Leave management** — `Leave Type` + a submittable `Leave Allocation` grant a
  balance; a `Leave Application`'s day count is derived from its dates, and a
  `before_submit` gate (which the approval workflow routes through) blocks
  approval when the employee lacks enough balance. Live balance at
  `GET /api/hr/leave-balance/:employee` (allocations − approved days).
- **Attendance & payroll proration** — an `Attendance` record per employee/day
  (Present/Absent/Half Day/On Leave). A `Salary Slip` with a period and
  `total_working_days` is now prorated: earnings scale by attendance days
  (Present/On Leave = 1, Half Day = 0.5) ÷ working days, so loss-of-pay flows
  through to the posted GL. Slips without a period stay full-pay.
- **Expense Claim** — a submittable `Expense Claim` with an expense grid books a
  balanced journal on submit (Dr each expense account / Cr the employee payable
  account) and reverses it on cancel.

## Phase 17

- **Sales Return / Credit Note** — a `Sales Invoice` with `is_return` (and an
  optional `return_against`) posts the reversed journal (Dr Sales + tax / Cr
  Debtors) and carries a negative outstanding, so the customer's net receivable
  is just the sum of invoice and credit-note balances.
- **Delivery Note return** — a `Delivery Note` with `is_return` receives goods
  back into stock (a positive movement at current valuation) instead of issuing
  them; cancel reverses it.
- **Landed Cost Voucher** — distributes an additional cost (freight, duty) across
  the items of a `Purchase Receipt` — by amount or by qty — increasing each
  item's `Bin` valuation and recording each share as a zero-quantity Stock Ledger
  Entry so cancel reverses it exactly.

## Phase 18

- **Purchase Invoice (AP)** — a submittable `Purchase Invoice` posts the payables
  journal (Dr expense/tax, Cr Creditors) with outstanding tracking and an
  `is_return` debit note; a Pay-type `Payment Entry` now reconciles Purchase
  Invoices (references generalised to either invoice type) — the full bill →
  Creditors → pay cycle.
- **Payment Terms** — a `Payment Terms Template` (portion % + credit days per
  term) expands, on `before_save`, into a due-dated `Payment Schedule` on Sales
  and Purchase Invoices (installments sum exactly to the total).
- **Bank Reconciliation** — `Bank Account` + `Bank Transaction`;
  `POST /api/accounting/bank-reconcile` auto-matches unreconciled transactions to
  submitted Payment Entries by amount and direction (deposit↔Receive,
  withdrawal↔Pay), preferring an equal reference number, and links both.

## Phase 19

- **Parameterized reports** — the `GET /api/query-report/:name` engine now accepts
  query-param filters and builds safe parameterized SQL, alongside the existing
  static reports.
- **AR / AP aging** — `accounts-receivable` / `accounts-payable` bucket open
  invoices by age (0-30 / 31-60 / 61-90 / 90+) relative to an `as_of` date, per
  party.
- **General Ledger** — `general-ledger` lists GL entries with a running balance,
  filterable by account, party, and date range (an account statement / party
  ledger).
- **Registers** — `sales-register` / `purchase-register` list submitted invoices
  over a date range with net / tax / grand total / outstanding / status.

## Phase 20

- **Request for Quotation** — submitting a `Request for Quotation` (items +
  invited suppliers) fans out a draft `Supplier Quotation` per supplier,
  pre-filled with the RFQ items and linked back.
- **Supplier Quotation + comparison** — suppliers fill in and submit their quoted
  rates; `GET /api/buying/rfq-comparison/:rfq` ranks the submitted quotes per
  item across suppliers and flags the lowest.
- **Quotation → Purchase Order** — `POST /api/buying/supplier-quotation/:name/
  make-purchase-order` turns a submitted quotation into a draft `Purchase Order`,
  links both, and marks the quotation Ordered — completing the sourcing cycle
  (RFQ → Supplier Quotation → PO → Receipt → Invoice).

## Phase 21

- **Warranty Claim** — `Serial No` gains a `warranty_expiry_date`; a
  `Warranty Claim` derives its warranty status (In / Out of Warranty) from the
  serial's expiry vs the complaint date (and auto-fills the item) on `before_save`.
- **Maintenance Schedule** — a `Maintenance Schedule` expands `start_date` +
  `periodicity` (Weekly … Yearly) + `no_of_visits` into dated visit rows on
  `before_save`.
- **Maintenance Visit** — submitting a `Maintenance Visit` closes the earliest
  pending scheduled visit on its schedule (and stamps the visit back); cancel
  reopens it.

## Phase 22

- **Sales Order fulfillment** — a `Sales Order` tracks `per_delivered` /
  `per_billed` and a status (To Deliver and Bill → To Bill / To Deliver →
  Completed), recomputed whenever a `Delivery Note` or `Sales Invoice` linked to
  it (via `sales_order`) is submitted or cancelled.
- **Purchase Order fulfillment** — a `Purchase Order` tracks `per_received` /
  `per_billed` and status the same way, driven by linked `Purchase Receipt` /
  `Purchase Invoice` documents.
- **Order → document conversions** — `POST /api/selling/sales-order/:name/
  make-delivery-note` (and `make-sales-invoice`), plus `POST /api/buying/
  purchase-order/:name/make-purchase-receipt` (and `make-purchase-invoice`),
  create pre-filled draft documents linked back to the order.

## Phase 23

- **Item attributes & templates** — `Item Attribute` (with allowed values) plus
  `has_variants` / `variant_of` / `attributes` on Item let an item be a variant
  template.
- **Variant generation** — `POST /api/selling/item/:template/make-variants`
  creates one variant Item per combination of the template's attribute values
  (cartesian product), named by abbreviation and copying the base fields;
  idempotent (existing variants are skipped).
- **Resolver + guards** — `GET /api/selling/item/:template/variant?Attr=Val…`
  returns the variant matching a combination; a `before_save` guard blocks an
  item that is both template and variant, and rejects a duplicate attribute
  combination among a template's variants.

## Phase 24

- **Workstations, Operations & BOM costing** — a `BOM` gains an `operations`
  routing (each an `Operation` on a `Workstation`); on save it prices every
  operation (time × workstation hour rate) and rolls raw-material + operating cost
  into the BOM's `total_cost`.
- **Job Cards & labour valuation** — submitting a `Work Order` now generates a
  `Job Card` per BOM operation and folds operating cost into the finished-good
  valuation (material + labour), so the produced item is costed fully; cancel
  removes the Job Cards.
- **Production Plan** — a submitted `Production Plan` spins up a draft `Work Order`
  per planned item, linked back for scheduling.

## Phase 25

- **Coupon Codes** — a `Coupon Code` unlocks a `coupon_based` Pricing Rule only
  when it's present on the transaction and still valid (within date, under its
  max-use); usage is counted when the invoice is submitted (reversed on cancel).
- **Promotional Schemes** — a submitted `Promotional Scheme` generates one
  Pricing Rule per discount tier (e.g. 5% at qty ≥ 10, 12% at ≥ 50), tagged with
  the scheme so its rules are replaced/removed cleanly.
- **Free-item promotions** — a Pricing Rule with a `Product` discount type adds a
  free line item (rate 0) to the transaction when it matches (buy-X-get-Y).

## Phase 26

- **Asset Movement** — an `Asset Movement` relocates an asset; on submit it stamps
  the previous location and updates the asset's current `location`/`custodian`
  (cancel restores it).
- **Asset Repair** — an `Asset Repair` either expenses the cost (Dr Repairs / Cr
  Creditors) or **capitalises** it (Dr the asset account / Cr Creditors, adding
  the cost to the asset's gross + current value); cancel reverses both.
- **Asset Disposal** — scrapping or selling an asset posts the removal journal
  (Dr Accumulated Depreciation + Cash, Cr Fixed Assets) and books the balancing
  **gain or loss** vs book value, marking the asset Scrapped/Sold; cancel reverses.

## Phase 27

- **Dunning** — a submittable `Dunning` charges interest on an overdue invoice
  (`outstanding × rate% × overdue_days / 365`) and books it as income on submit
  (Dr Debtors / Cr Interest Income); cancel reverses the GL.
- **Credit limit** — Customers gain a `credit_limit`; a `before_submit` gate
  blocks a Sales Invoice when the customer's open receivable plus the new invoice
  would exceed it (0 / unset = no limit).
- **Customer Statement** — a `customer-statement` query-report renders a statement
  of account for one customer: every receivable movement (invoices, payments,
  dunning interest) with a running balance.

## Phase 28

- **Repack** — a `Repack` consumes items and produces others from one warehouse;
  on submit it issues the consumed lines at their current valuation and receives
  the produced lines at a rolled-up rate so the produced stock value equals the
  value consumed (cost conserved). Cancel reverses every movement.
- **Pick List** — a `Pick List` whose `before_submit` gate blocks the submit when
  any location's qty exceeds the on-hand Bin balance; a submitted pick converts to
  a draft Delivery Note via `POST /api/stock/pick-list/:name/make-delivery-note`.
- **Putaway** — a `Putaway` moves received stock from a receiving warehouse into
  storage, posting a warehouse-to-warehouse transfer per line at the source's
  valuation; cancel reverses.

## Phase 29

- **Campaign** — a `Campaign` master; Leads carry a `campaign`, and a
  `campaign-performance` query-report shows leads, conversions, and conversion
  rate per campaign.
- **Contract** — a submittable `Contract` (Customer/Supplier) validates its date
  range on submit and derives status (Active, or Expired if the end date has
  already passed); cancel resets it.
- **Appointment** — a submittable `Appointment` whose `before_submit` gate blocks
  a booking that overlaps another submitted appointment for the same assignee.

## Phase 30

- **Accounting dimensions** — an `Accounting Dimension` master plus a `project`
  dimension on Sales/Purchase Invoices and the GL; the GL listener stamps each
  posted line with the voucher's project (alongside cost center).
- **Dimension reporting** — the `general-ledger` report gains a project filter,
  and a `project-ledger` report rolls debit/credit/net up by project + account.
- **Dimension budgets** — Budgets can target a `project`; a
  `project-budget-variance` report compares each project budget to its GL actual.

## Phase 31

- **Fleet** — a `Vehicle` master plus a submittable `Vehicle Log` (fuel + service);
  the log derives `fuel_cost = qty × rate` and, on submit, rolls fuel/service cost
  and the odometer onto the Vehicle (cancel unwinds the costs).
- **Odometer gate** — a `before_submit` gate blocks a Vehicle Log whose odometer
  reading is below the vehicle's current reading (readings are monotonic).
- **Running cost** — a `vehicle-running-cost` report gives per-vehicle fuel,
  service, distance (max − min odometer), total cost, and cost per km.

## Phase 32

- **Sales commission** — a `Sales Person` (commission rate + target); submitting a
  Sales Invoice tagged with one accrues `base_grand_total × rate%` commission and
  the sales total onto the person (cancel unwinds).
- **Commission report** — a `sales-commission` report shows each person's sales,
  commission, target, and attainment %.
- **Blanket Order** — a customer rate/qty agreement; a `before_submit` gate blocks
  a Sales Order that references it from ordering beyond the remaining qty, and each
  order rolls the blanket's `ordered_qty` (completing it when exhausted).

## Phase 33

- **Journal Entry posting** — a submittable `Journal Entry` of account debit/credit
  rows now posts to the GL on submit; a `before_submit` gate blocks an unbalanced
  entry (debit ≠ credit), and cancel reverses the postings.
- **Payment Request** — a submittable `Payment Request` against an invoice;
  `POST /api/accounting/payment-request/:name/make-payment` spins up a draft
  Payment Entry (Receive/Pay by reference), links it back, and marks the request Paid.
- **Journal register** — a `journal-register` report lists submitted journal
  entries with their date, remark, and total debit/credit.

See `docs/ARCHITECTURE.md` for the full design.
