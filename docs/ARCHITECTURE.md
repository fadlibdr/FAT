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

## Phase 12 — Manufacturing, Projects, Assets

- **Manufacturing.** `BOM` (production item + raw-material rows) and `Work Order`
  (submittable). Submitting a Work Order emits a Stock Entry with a new
  **Manufacture** purpose that issues the BOM's materials from the source
  warehouse and receives the finished good into the target warehouse at the
  rolled-up material cost per unit (via `basic_rate` on the entry line); the
  order flips to Completed and cancel reverses the whole entry.
- **Projects.** `Project`, `Task`, and a submittable `Timesheet`. Submitting a
  Timesheet computes `billable_amount = hours × rate` (billable lines only) and
  rolls hours + amount onto the Project; cancel unwinds the rollup.
- **Assets.** `Asset` (submittable) + `Depreciation Entry` (submittable). A
  Depreciation Entry auto-computes the straight-line annual charge when left
  blank (never below salvage), books **Dr Depreciation Expense / Cr Accumulated
  Depreciation** to the GL, and steps the asset's accumulated depreciation,
  current value and status; cancel reverses the GL and unwinds the asset.
- Each module is a thin `BusinessModule` (JSON DocTypes + one event listener,
  no cross-module service imports) and surfaces automatically in the
  metadata-driven Desk sidebar, list and form views.

## Phase 13 — Payroll, Pricing, Support

- **Payroll.** `Salary Component` (Earning/Deduction + GL account),
  `Salary Structure` (earnings/deductions child tables), and a submittable
  `Salary Slip`. On submit the listener reads the structure, computes gross /
  total deduction / net pay, and posts a balanced journal — Dr each earning
  account (Σ = gross), Cr each deduction account, Cr the payable account (net);
  cancel reverses the GL.
- **Pricing rules.** A new **pre-write engine hook** (`HooksService.applyBeforeSave`,
  invoked by `DocumentService.create`/`update` before validation) lets listeners
  transform raw input. `PricingRuleListener` uses it to match each selling line
  against active `Pricing Rule`s (by item code / item group, optionally scoped to
  a customer and above a minimum qty) and set a fixed rate or apply a discount %;
  the recompute-totals job then derives amounts/totals from the adjusted rates.
- **Support.** `Service Level Agreement` (per-priority first-response and
  resolution targets) and `Issue`. The support listener stamps `response_by` /
  `resolution_by` from the applicable SLA on creation, and on Resolved/Closed
  compares the resolution time to the deadline to mark the agreement
  Fulfilled/Failed (direct SQL write-backs avoid event re-entry).
- Each module is a thin `BusinessModule` (JSON DocTypes + one event listener, no
  cross-module service imports) and appears automatically in the Desk sidebar,
  list and form views.

## Phase 14 — CRM pipeline, Subscriptions, Loyalty

- **CRM pipeline.** `Lead` and `Opportunity` gain conversion behaviour: marking a
  Lead "Converted" creates a `Customer` (once) and links it back; marking an
  Opportunity "Converted" builds a draft `Quotation` from its items (new
  `Opportunity Item` child) and links it back. Idempotent via the stamped
  back-links. The Pricing Rule listener is now gated to billing transactions
  (those with a `grand_total` field) so pre-sales Opportunities are not priced
  and the converted Quotation is discounted exactly once.
- **Subscriptions.** `Subscription Plan` + `Subscription`. A daily cron (and
  `POST /api/admin/run-subscriptions`, with an optional `as_of` date) bills every
  Active subscription whose `next_invoice_date` has arrived — raising and
  submitting a Sales Invoice from the plan via the generic `DocumentService` (so
  GL posts through the normal event path), then advancing the date and recording
  the run. It waits for the async recompute-totals job before submitting so GL
  posts the real amount.
- **Loyalty.** `Loyalty Program` + a `Loyalty Point Entry` ledger. Submitting a
  Sales Invoice earns `floor(grand_total × collection_factor)` points under the
  default active program (Accrual entry), reversed when the invoice is cancelled;
  redemptions are negative entries and the balance (sum of entries) is served at
  `GET /api/loyalty/balance/:customer`.
- Each is a thin `BusinessModule` (JSON DocTypes + a listener/service, no
  cross-module service imports) and appears automatically in the Desk.

## Phase 15 — Supply-chain & inventory control

- **Stock Reconciliation.** A submittable `Stock Reconciliation` asserts absolute
  counted quantities per item+warehouse. On submit the Stock listener reads the
  current `Bin` balance and posts a Stock Ledger Entry for the *difference* only,
  reusing the shared moving-average/FIFO posting so the Bin lands exactly on the
  counted qty (and, for Opening Stock, an explicit valuation rate). It stamps
  each row's current/difference qty and the voucher's net valuation change;
  cancel reverses the same delta. No new ledger code — it rides the existing
  `post()`/`reverse()` path, so a reconciliation is just another voucher type.
- **Auto-reorder → Material Request → Purchase Order.** Items gain
  `reorder_level`/`reorder_qty`. A `ReorderService` (daily cron + `POST
  /api/buying/run-reorder`) sums on-hand qty across every Bin per reorder-enabled
  item and raises a single submitted `Material Request` (type Purchase) for the
  shortfall. `POST /api/buying/material-request/:name/make-purchase-order`
  converts a submitted request into a draft `Purchase Order`, marks the request
  Ordered, links the two, and stamps each line's ordered qty — all through the
  generic `DocumentService`, no cross-module service imports.
- **Quality Inspection.** This phase adds an awaitable **pre-submit gate** to the
  engine: `HooksService.applyBeforeSubmit` fires `doc.before_submit(:Doctype)`
  via `emitAsync` before a document transitions to submitted, and a listener that
  throws aborts the submit. The `Quality` module uses it two ways: a
  `before_save` hook derives a `Quality Inspection`'s status from its readings
  grid (Rejected if any reading fails), and a `before_submit:Purchase Receipt`
  gate (registered with `suppressErrors: false` so the thrown error propagates
  instead of being swallowed by the event emitter) blocks a receipt whose
  inspection-required items lack a submitted, Accepted inspection referencing it.
- Each is a thin `BusinessModule` (JSON DocTypes + a listener/service, no
  cross-module service imports) and appears automatically in the Desk.

## Phase 16 — HR & Payroll depth

- **Leave management.** `Leave Type` + a submittable `Leave Allocation` grant a
  balance; there is no separate ledger — balance is derived live as Σ(submitted
  allocations) − Σ(submitted applications' days) in `HrService`. A `before_save`
  hook stamps a Leave Application's inclusive day count, and the awaitable
  `before_submit` gate (added in Phase 15, and which the Leave-Approval workflow
  routes through via `setDocStatus`) blocks approval when the balance is
  insufficient — again registered with `suppressErrors: false`. Served at
  `GET /api/hr/leave-balance/:employee`.
- **Attendance & payroll proration.** An `Attendance` doctype records a status per
  employee/day. This closes a prior known limitation: the Payroll listener now
  computes a payment factor for a Salary Slip's period — Σ(attendance days, where
  Present/On Leave = 1 and Half Day = 0.5) ÷ `total_working_days` — and scales
  earnings by it before posting, so loss-of-pay reaches the GL. When no period or
  no attendance is recorded it defaults to full pay (factor 1), keeping existing
  slips unchanged. Payroll reads `tabAttendance` by SQL — no service import.
- **Expense Claim.** A submittable `Expense Claim` (+ `Expense Claim Detail`
  grid). On submit an HR listener books a balanced journal — Dr each line to its
  account (or a general employee-expense account) and Cr the total to the
  employee payable account — reversed on cancel, mirroring the Payroll/GL
  listeners' voucher pattern.
- Everything stays on the event bus: HR/Payroll import no other module's
  services, reading sibling tables by SQL and posting through the generic
  `DocumentService`.

## Phase 17 — Returns & landed cost

- **Sales Return / Credit Note.** A `Sales Invoice` gains `is_return` +
  `return_against`. The GL listener branches on it: a credit note debits Sales
  and tax and credits Debtors (the mirror of an invoice) using absolute amounts,
  since the return's own totals are negative, and sets a **negative outstanding**.
  No mutation of the original invoice — the customer's net receivable is simply
  the Debtors balance across both documents (verified: 225 − 100 = 125).
- **Delivery Note return.** A `Delivery Note` gains `is_return` + `return_against`.
  The stock listener posts a **positive** movement (goods back in at current
  valuation) instead of an issue; the existing `reverse()` handles cancel because
  the return's Stock Ledger Entry simply carries a positive `actual_qty`.
- **Landed Cost Voucher.** References a `Purchase Receipt` and an additional cost
  to spread across its items (by amount = qty×rate, or by qty). On submit it bumps
  each item's `Bin` `stock_value` and recomputes `valuation_rate`, recording each
  share as a **zero-quantity** Stock Ledger Entry; cancel reads those entries to
  subtract the shares back out and re-derive the rate. No new GL — Purchase
  Receipts value stock via the stock ledger, so landed cost rides the same path.
- Everything reuses the existing GL/stock voucher patterns — the returns are
  branches on `is_return`, and landed cost is another Bin-valuation voucher — so
  no cross-module service imports are added.

## Phase 18 — Accounts payable & cash management

- **Purchase Invoice.** The AP counterpart to Sales Invoice: on submit the GL
  listener debits the expense (and input-tax) accounts and credits Creditors,
  tracks `outstanding_amount`, and supports an `is_return` debit note (the mirror
  posting with a negative outstanding). Totals ride the shared `recompute_totals`
  job (items + taxes). Payment reconciliation was generalised — a single
  `reconcileInvoice(refDoctype, …)` helper moves outstanding on either a Sales or
  a Purchase Invoice, so a Pay-type Payment Entry clears bills exactly as a
  Receive clears sales invoices.
- **Payment Terms.** A `Payment Terms Template` (each term a portion % + credit
  days) drives a `before_save` listener that, for any invoice carrying a template
  and no explicit schedule, expands it into a `Payment Schedule` child — due_date
  = posting_date + credit_days, amount = portion × (net + taxes), with the final
  installment absorbing rounding so the rows sum exactly to the total. Works for
  both invoice types off the same template.
- **Bank Reconciliation.** `Bank Account` + `Bank Transaction`, and a
  `BankReconciliationService` (`POST /api/accounting/bank-reconcile`) that
  auto-matches unreconciled transactions to submitted Payment Entries by amount
  and direction (a deposit ↔ a Receive, a withdrawal ↔ a Pay), preferring an
  equal `reference_no`; each Payment Entry is consumed once, so the run is
  idempotent. (Field defaults are UI-applied, so the matcher treats a NULL
  transaction status as unreconciled.)
- All of it stays on the event bus / generic engine — no cross-module service
  imports; the reconciliation service and terms listener read sibling tables by
  SQL.

## Phase 19 — Financial reporting depth

The `/api/query-report/:name` engine gains **parameters**: a report may declare
`filters` and supply a `build(filters)` that returns parameterized SQL
(`$1, $2, …`), while static reports keep their plain `sql`. Identifiers stay
literal in the builders; only values are bound — same posture as the rest of the
engine. Five reports are added on top of the accumulated GL/AR/AP data:

- **AR / AP aging** (`accounts-receivable`, `accounts-payable`). Open invoices
  (submitted, positive outstanding) bucketed by age relative to an `as_of` date
  into 0-30 / 31-60 / 61-90 / 90+, computed from `as_of − coalesce(due_date,
  posting_date)`. A shared `agingSql(doctype, partyField, asOf)` serves both.
- **General Ledger** (`general-ledger`). GL entries with a running balance
  (`sum(debit − credit) OVER (ORDER BY posting_date, creation ROWS …)`),
  filterable by account, party (`against`), and date range — an account
  statement when scoped to one account, a party ledger when scoped to a party.
- **Registers** (`sales-register`, `purchase-register`). Submitted invoices over a
  date range with net / tax / grand total / outstanding / status, via a shared
  `registerSql`.

Because each report reads its own source, a by-invoice AR total and the Debtors
GL control balance can legitimately differ by unallocated receipts and standalone
credit notes — the reports expose that gap rather than hiding it.

## Phase 20 — Procurement sourcing

Completes the buying cycle upstream of the Purchase Order (which already flowed
PO → Receipt → Invoice). A `SourcingService` (Buying module, no cross-module
service imports) drives it on the event bus and the generic `DocumentService`:

- **Request for Quotation.** A submittable RFQ carries an items grid and an
  invited-suppliers grid. On submit, `onRfqSubmit` creates one draft
  `Supplier Quotation` per supplier — pre-filled with the RFQ items at zero rate,
  linked via `request_for_quotation`, and stamped back onto the supplier row —
  then marks the RFQ Submitted.
- **Supplier Quotation + comparison.** Suppliers fill rates and submit (totals via
  the shared `recompute_totals` job; an on-submit hook flips the status to
  Submitted). `compare(rfq)` joins Supplier Quotation Item → Supplier Quotation,
  groups quotes per item across all *submitted* quotations for the RFQ, and flags
  the lowest — served at `GET /api/buying/rfq-comparison/:rfq`.
- **Quotation → Purchase Order.** `makePurchaseOrder(sq)` builds a draft Purchase
  Order from the chosen quotation's lines, links both, and marks the quotation
  Ordered (idempotent — a second award is rejected). Mirrors the existing
  Material-Request → Purchase-Order conversion.

## Phase 21 — Maintenance & warranty

A new `Maintenance` module (after-sales service) tied to the existing Serial No
and Customer masters, entirely on the event bus:

- **Warranty Claim.** `Serial No` gains `warranty_expiry_date`. A submittable
  `Warranty Claim`'s `before_save` hook reads the referenced serial, fills the
  item, and sets warranty status to In / Out of Warranty by comparing the serial's
  expiry to the complaint date.
- **Maintenance Schedule.** A submittable schedule whose `before_save` hook
  expands `start_date` + `periodicity` (Weekly / Monthly / Quarterly / Half-Yearly
  / Yearly) + `no_of_visits` into a `Maintenance Schedule Detail` grid of dated,
  Pending visits — the same generate-a-child-table-before-write pattern as Payment
  Terms.
- **Maintenance Visit.** On submit, the listener closes the *earliest still-pending*
  scheduled visit on the referenced schedule (FIFO) — marking it Completed and
  stamping the visit — and reopens it on cancel. Cross-document child-row update
  by SQL, no service import.

## Phase 22 — Order fulfillment & billing status

Ties the transactional documents together into order-to-cash and procure-to-pay
lifecycles, still purely on the event bus:

- **Sales Order.** Gains `per_delivered` / `per_billed` and a status. Selling's
  `FulfillmentService.recomputeSalesOrder` sums, per item, the qty on submitted
  non-return Delivery Notes and Sales Invoices that link back via `sales_order`,
  caps each at the ordered qty (Σ min(done, ordered) / Σ ordered), and derives the
  status (To Deliver and Bill / To Bill / To Deliver / Completed). A listener
  recomputes on order submit and on any linked Delivery Note / Sales Invoice
  submit **or cancel**, so progress reverses correctly.
- **Purchase Order.** The buying-side mirror (`PoFulfillmentService`), driven by
  linked Purchase Receipts / Purchase Invoices. The per-item qty helper skips the
  `is_return` filter for doctypes that don't declare it (Purchase Receipt has no
  return flag), so the same aggregation serves both sides.
- **Conversions.** `makeFromSalesOrder` / `makeFromPurchaseOrder` build a
  pre-filled **draft** Delivery Note / Sales Invoice (or Purchase Receipt /
  Invoice) from an order's lines, linked back — so submitting the draft flows
  straight into the order's fulfillment status. Exposed under `/api/selling/…`
  and `/api/buying/…`.

## Phase 23 — Item variants

Shows the DocType engine generating documents from metadata. An Item can be a
variant template (`has_variants`) carrying an `attributes` grid of the
`Item Attribute`s it varies on; each attribute owns its allowed values.

- **Generation.** `VariantService.makeVariants` loads each listed attribute's
  values, takes their cartesian product, and creates one child Item per
  combination — `item_code` suffixed by the value abbreviations, `variant_of` set,
  the base fields copied, and the specific combination stored in the variant's
  `attributes`. It checks existence first, so a re-run is idempotent and never
  trips the uniqueness guard.
- **Resolver.** `resolve(template, {attr: value, …})` scans the template's
  variants and returns the one whose attribute combination matches every pair —
  the runtime "which SKU is Medium/Blue?" lookup.
- **Guards.** A `before_save:Item` listener (suppressErrors:false) rejects an item
  that is simultaneously a template and a variant, and blocks a second variant
  with an attribute combination already used by a sibling — comparing order-
  independent signatures of the combinations.

## Phase 24 — Manufacturing shop floor

Deepens the Manufacturing module (BOM + Work Order) with routing, labour costing,
and planning — all on the existing event bus:

- **Routing & BOM costing.** `Workstation` (hour rate) and `Operation` masters,
  plus a `BOM Operation` grid on the BOM. A `before_save:BOM` hook prices each
  operation (`time_in_mins/60 × workstation hour_rate`) and sets the BOM's
  `raw_material_cost` / `operating_cost` / `total_cost` — so a BOM now carries a
  full costed bill (verified: 16 material + 30 labour = 46).
- **Job Cards & labour in valuation.** The existing Work-Order → Manufacture
  Stock Entry flow is extended: on submit it also creates a `Job Card` per
  operation (scaled to the order qty) and adds the operating cost to the
  finished-good rate, so the produced item is valued at **material + labour**
  (10 units → rate 46, `produced_value` 460). Cancel deletes the Job Cards along
  with reversing the stock entry.
- **Production Plan.** A submittable `Production Plan` whose on-submit handler
  creates a **draft** Work Order per planned item (left in draft for scheduling)
  and links it back — plan → Work Orders → (submit) → manufacture, end to end.

## Phase 25 — Sales promotions

Builds on the Pricing Rule engine (Phase 13). The `before_save` pricing listener
gains coupon gating and product (free-item) discounts; a separate promotion
listener handles usage counting and scheme generation.

- **Coupon Codes.** A `Coupon Code` points at a `coupon_based` Pricing Rule. In
  the pricing listener, a coupon-based rule is skipped unless the document's
  `coupon_code` resolves to it and the coupon is valid (within `valid_upto`, and
  `used < max_use`). Usage is tracked out-of-band: submitting a Sales Invoice
  with a coupon increments its `used` count (decremented on cancel), so a
  max-use coupon stops unlocking its rule once spent.
- **Promotional Schemes.** A submittable `Promotional Scheme` with a tier grid
  (min qty → discount %). On submit, the promotion listener deletes the rules
  previously generated for the scheme and creates one Pricing Rule per tier
  (priority = min qty, tagged `promotional_scheme`), so a single scheme drives a
  whole qty-based discount ladder; cancel removes them.
- **Free-item promotions.** A Pricing Rule's `price_or_product_discount` = Product
  (+ `free_item`/`free_qty`) makes a match append a **free line** (rate 0) rather
  than discount the matched line — buy-X-get-Y. The listener appends the free
  lines after scanning, and is idempotent (won't re-add an existing free line).
- All of it stays on the event bus / generic engine — no cross-module service
  imports.

## Phase 26 — Asset lifecycle

Extends the Assets module (Asset + Depreciation Entry) with movement, repair, and
disposal, all handled by the existing `AssetsListener` on the event bus:

- **Asset Movement.** On submit, stamps the movement's `from_location` with the
  asset's current location and updates the asset to the new location/custodian;
  cancel restores the previous location.
- **Asset Repair.** Expenses the cost (Dr Repairs Expense / Cr the payable) or
  **capitalises** it (Dr the asset account / Cr the payable, and adds the cost to
  the asset's `gross_purchase_amount` + `value_after_depreciation`). Cancel
  reverses the GL and unwinds any capitalisation.
- **Asset Disposal.** Scrap or sale. Posts the removal journal — Dr Accumulated
  Depreciation + Dr Cash (sale proceeds), Cr the fixed-asset cost — and books the
  balancing **gain (Cr) or loss (Dr)** against `sale − book value`, so the entry
  always balances (verified for loss, gain, and scrap). Marks the asset
  Scrapped/Sold and zeroes its value; cancel reverses and restores the asset's
  depreciated state.

## Phase 27 — Accounts-receivable collections

A new thin `Receivables` module (one JSON DocType + one `ReceivablesListener`,
no cross-module service imports) plus a query-report, all driven by the event bus:

- **Dunning.** A `before_save` computes the interest on an overdue invoice
  (`outstanding × rate% × overdue_days / 365`); on submit the listener books it
  Dr Debtors / Cr Interest Income (balanced, verified) and marks the notice
  Unresolved, and cancel deletes the GL. Interest income realises the time value
  of an overdue receivable without touching the original invoice.
- **Credit limit.** `Customer` gains a `credit_limit`. A
  `before_submit:Sales Invoice` gate (`suppressErrors:false`, so a throw aborts
  the submit) sums the customer's open receivable from already-submitted invoices
  and blocks the transition when adding the new invoice would exceed the limit;
  an unset/zero limit is unlimited, and credit notes (`is_return`) are exempt.
- **Customer Statement.** A `customer-statement` query-report reads the receivable
  account movements for one customer straight from `tabGL Entry` (account =
  Debtors, `against` = customer) — invoices (Dr), payments (Cr) and dunning
  interest (Dr) — with a window-function **running balance**, i.e. a statement of
  account. It reuses the ledger the other listeners already post to, so no
  separate aggregation is maintained.

## Phase 28 — Warehouse operations

Three warehouse flows added to the Stock module, all reusing the existing
`StockLedgerListener.post()` valuation engine (moving-average / FIFO) so cost
tracking stays consistent — no new ledger logic:

- **Repack.** Consumes items and produces others from one warehouse. On submit it
  reads each consumed line's current Bin rate, issues it, and sums the consumed
  value; the produced lines are then received at a single rolled-up rate
  (`consumedValue / totalProducedQty`) so the produced stock value equals the
  value consumed — cost is transformed, not created (verified 10×RAW @8 → 4 units
  valued 80). Cancel reverses every Stock Ledger Entry.
- **Putaway.** Moves received stock from a staging/receiving warehouse into
  storage: each line is a warehouse-to-warehouse transfer (issue from source,
  receive into target at the source's current valuation, so value follows the
  goods). Cancel reverses.
- **Pick List.** A `before_submit` gate (`suppressErrors:false`) blocks the submit
  when any location's qty exceeds the current Bin balance — you cannot pick what
  isn't on hand. A submitted pick is converted to a **draft Delivery Note** by
  `PickListService` (`POST /api/stock/pick-list/:name/make-delivery-note`), which
  links the note back onto the pick and flips it to Delivered; the actual stock
  issue happens when that Delivery Note is submitted, through the existing listener.

## Phase 29 — Customer engagement

A new thin `Engagement` module (three JSON DocTypes + one `EngagementListener`,
no cross-module service imports) plus a query-report:

- **Campaign.** A master that Leads attribute to via a new `campaign` Link field.
  The `campaign-performance` query-report groups `tabLead` by campaign, counting
  leads and — reusing the CRM pipeline's stamped `customer` back-link as the
  conversion signal — converted leads and the conversion rate. No separate
  attribution table is maintained.
- **Contract.** A submittable agreement (Customer/Supplier via a Dynamic Link).
  A `before_submit` gate (`suppressErrors:false`) rejects an end-before-start
  range; on submit the listener derives the status (Expired if the end date has
  already passed, else Active) and cancel resets it. Dates arrive as `Date`
  objects, so comparisons normalise through epoch milliseconds rather than string
  compare.
- **Appointment.** A submittable booking with a `Datetime` range. The
  `before_submit` gate rejects a non-positive duration and, with a half-open
  overlap test (`existing.start < new.end AND existing.end > new.start`), blocks a
  submit that would double-book the same assignee — adjacent, touching slots are
  allowed. Passing the gate flips the status to Scheduled.

## Phase 30 — Accounting dimensions

ERPNext-style accounting dimensions: a second axis of analysis (project) carried
on the ledger alongside the account and cost center, so the same GL can be sliced
by project.

- **Capture.** An `Accounting Dimension` master documents which dimensions exist
  (name → reference DocType → fieldname). A `project` field is added to Sales
  Invoice, Purchase Invoice, and GL Entry; the existing `GlPostingListener`
  stamps `doc.project` onto every GL line it posts (the `Line` interface carries
  it exactly like `cost_center`) — a purely additive change, `null` when unset.
- **Report.** The `general-ledger` query-report gains a `project` filter, and a
  `project-ledger` report groups the GL by project + account (debit / credit /
  net). Both read the stamped column directly, so no separate dimension store is
  maintained.
- **Budget.** `Budget` becomes dimension-aware — `cost_center` is now optional and
  a `project` may be set instead. The `project-budget-variance` report matches
  each project budget to its GL actual (Dr − Cr for that project + account), the
  same sign convention as the cost-center `budget-variance`.

## Phase 31 — Fleet management

A new thin `Fleet` module (two JSON DocTypes + one `FleetListener`, no
cross-module service imports) plus a query-report:

- **Vehicle + Vehicle Log.** A `before_save` derives the log's
  `fuel_cost = fuel_qty × fuel_rate`. On submit the listener rolls the fuel and
  service costs onto the `Vehicle` (`total_fuel_cost` / `total_service_cost`,
  accumulated with `coalesce(…,0) + …`) and advances `last_odometer` with
  `greatest(…)`; cancel subtracts the costs back out (the odometer is not rolled
  back — readings only ever move forward).
- **Odometer gate.** A `before_submit` gate (`suppressErrors:false`) rejects a log
  whose odometer is below the vehicle's current reading, keeping the reading
  monotonic.
- **Running cost.** The `vehicle-running-cost` report aggregates a vehicle's
  submitted logs — fuel, service, distance (`max − min` odometer), total cost, and
  cost per km — reading straight from `tabVehicle Log`.

## Phase 32 — Sales team & agreements

A new thin `Salesteam` module (two JSON DocTypes + one `SalesteamListener`, no
cross-module service imports), plus a `sales_person` field on Sales Invoice and a
`blanket_order` field on Sales Order:

- **Commission.** On Sales Invoice submit, if a `sales_person` is set, the listener
  reads that person's `commission_rate` and rolls `base_grand_total` into
  `total_sales` and `base_grand_total × rate%` into `total_commission` on the
  Sales Person (credit notes are skipped). Cancel reverses with the opposite sign.
  The `sales-commission` report exposes the rollups plus target attainment.
- **Blanket Order.** A customer rate/quantity agreement for one item. A
  `before_submit` gate on Sales Order (`suppressErrors:false`) sums the order's
  qty for the blanket's item and blocks the submit if `ordered_qty + thisQty`
  exceeds `total_qty`; on submit it advances `ordered_qty` (and flips the blanket
  to Completed when exhausted), and cancel rolls it back. All quantity roll-ups are
  plain SQL over the sibling table — no shared service.

## Phase 33 — Manual accounting & payment requests

Closes the manual-voucher gap in the accounting module (all inside `Accounting`,
no cross-module imports):

- **Journal Entry posting.** A `JournalListener` totals the account rows on
  `before_save`, gates the submit (`suppressErrors:false`) to require a non-zero,
  balanced entry (`Σ debit == Σ credit`), and on submit writes one GL Entry per
  row (voucher_type `Journal Entry`); cancel deletes them. Journal Entries were
  submittable before but posted nothing — now they carry double-entry weight and
  keep the trial balance balanced (verified end-to-end).
- **Payment Request.** A submittable request against a Sales/Purchase Invoice.
  `on_submit` moves it to Requested; `PaymentRequestService.makePayment`
  (`POST /api/accounting/payment-request/:name/make-payment`) creates a **draft**
  Payment Entry — Receive for a Sales Invoice, Pay for a Purchase Invoice — carrying
  the reference allocation, links it back onto the request, and marks it Paid. The
  actual reconciliation happens when that Payment Entry is submitted, through the
  existing `GlPostingListener`.
- **Journal register.** A `journal-register` query-report lists submitted journal
  entries (date, remark, total debit/credit).

## Phase 34 — Payment modes & cash management

Teaches the Payment Entry which real account it hits, all inside `Accounting`:

- **Mode of Payment.** A master mapping a mode (Cash / Bank / Cheque) to a default
  account. Payment Entry gains a `mode_of_payment`; the `GlPostingListener`'s
  payment handler resolves the cash side of the entry from that mode's account
  (Bank Transfer → Bank, Cash → Cash), falling back to the `Cash` constant when
  unset — the party control-account side (Debtors/Creditors) is unchanged, so the
  entry still balances (verified Bank and Cash routings).
- **Reference gate.** A `before_submit:Payment Entry` gate (`suppressErrors:false`)
  requires a `reference_no` whenever the mode's type is not Cash, so a cheque or
  bank transfer can always be traced to its instrument number.
- **Mode summary.** A `payment-mode-summary` report groups submitted payments by
  mode into received (Receive) / paid (Pay) / net, over `base_paid_amount`.

## Phase 35 — Shift & attendance

Adds shift scheduling and attendance depth to the HR module (two JSON DocTypes +
fields on Attendance + a `ShiftListener`, no cross-module imports):

- **Shift Type & Assignment.** A `Shift Type` carries the working window and
  expected hours; a submittable `Shift Assignment` links an employee to a shift
  over a date range and flips Active/Cancelled on submit/cancel.
- **Attendance depth.** Attendance gains `shift`, `check_in`, `check_out`,
  `working_hours`. A `before_save` (`suppressErrors:false`) computes the worked
  hours from the check window, downgrades a day shorter than half the shift's
  expected hours to Half Day, and — since field defaults are UI-applied — defaults
  the status to Present. The same handler enforces **one attendance per employee
  per date**, excluding the row itself on update.
- **Attendance summary.** An `attendance-summary` report tallies Present / Absent /
  Half Day / On Leave counts and total hours per employee over a date range.

## Phase 36 — Tax withholding (TDS)

Withholding tax on purchases, handled entirely in the accounting module's GL
listener (additive — no new posting listener, no race between writers):

- **Category + posting.** A `Tax Withholding Category` carries a rate, TDS account,
  and single-invoice threshold. A Purchase Invoice gains `apply_tds` /
  `tax_withholding_category` / `tds_amount`. Inside the existing
  `onPurchaseInvoiceSubmit`, when TDS applies and the net is at/above the
  threshold, two extra lines are appended to the **same** GL post — Dr Creditors
  and Cr the TDS account for the withheld amount — so the entry stays balanced
  while the Creditors control account nets to `grand − tds`; the invoice's
  `outstanding_amount` is set to `grand − tds` in the same write. Cancel already
  deletes every GL line for the voucher, TDS included.
- **Supplier default.** Suppliers carry a default `tax_withholding_category`; a
  `before_save:Purchase Invoice` fills the invoice's category (and turns on
  `apply_tds`) from the supplier when the invoice hasn't set one.
- **Report.** A `tds-payable` report totals the withheld credits per supplier.

## Phase 37 — Stock reservation & availability

Adds availability discipline to the Stock module (one JSON DocType + a
`ReservationListener`, no cross-module imports), reading the Bin balance directly:

- **Stock Reservation.** A submittable reservation earmarks quantity of an item in
  a warehouse. Its `before_submit` gate (`suppressErrors:false`) computes
  availability as `on-hand − already-reserved` (excluding the reservation itself)
  and blocks over-reserving; submit/cancel flip the status.
- **Delivery gate.** A `before_submit:Delivery Note` gate blocks issuing more of an
  item than is physically on hand in the source warehouse (sales returns, which
  receive goods back, are exempt) — closing the door on silent negative stock at
  the point of delivery.
- **Projected quantity.** A `projected-qty` report joins Bin (on-hand) to submitted
  Stock Reservations (reserved) and reports `on-hand − reserved` — what is free to
  promise, which can legitimately go negative when more is reserved than is held.

## Phase 38 — Supplier scorecard & performance

Supplier performance governs purchasing, in the Buying module (one submittable
DocType + child + a `ScorecardListener`, no cross-module imports):

- **Scorecard.** A `Supplier Scorecard` holds weighted criteria rows; `before_save`
  computes `Σ weight·score / Σ weight` into `total_score` and maps it to a standing
  band (≥80 Excellent, ≥60 Good, ≥40 Average, else Poor).
- **Purchasing gate.** A `before_submit:Purchase Order` gate looks up the supplier's
  most recent submitted scorecard (via `DISTINCT ON`) and blocks the order when the
  standing is Poor — a data-driven approval control that stays out of the ledger.
- **Report.** A `supplier-scorecard` report lists each supplier's latest score and
  standing.

## Phase 39 — Contact & address book

Fills out the CRM party model (one new DocType + a field on Contact + a
`ContactListener`, no cross-module imports):

- **Address.** An `Address` DocType records postal addresses against a customer,
  with a primary flag.
- **Primary contact.** Contacts gain `is_primary`. On `after_insert`/`after_update`,
  when a primary contact is saved for a customer the listener rolls its
  email/mobile onto the `Customer` (canonical details) and demotes any other
  primary contact of that customer — enforcing one primary per party. Write-backs
  are direct SQL to avoid event re-entry.
- **Report.** A `party-contacts` report lists a customer's contacts, primary first.

## Known limitations (still open)

- Multi-currency has a single conversion rate (no revaluation); serial numbers
  track status/movement but not per-serial valuation.
- Email is log-only without SMTP; SSE stream is unauthenticated (doctype + name
  only); webhooks/print are best-effort.
- POS offline retry can duplicate a *payment* (not the invoice) if the invoice
  submitted but the client never saw the response; GraphQL exposes no
  subscriptions yet.
- The DocType builder does not yet edit child-table field layouts in the UI.
- Pricing Rules apply a single best (highest-priority) match per line — no rule
  stacking or margin/validity-date windows. SLA deadlines are elapsed-hours
  based (no business-hours calendar, holidays, or pause). Payroll proration is
  attendance-day based only (no per-component LWP config, and deductions are not
  prorated).
- Subscriptions bill a single-line invoice per plan (no proration, tax templates,
  or dunning); loyalty redemption is recorded as a ledger entry but is not yet
  auto-applied as an invoice discount; a partial update that omits a child table
  replaces it (clients submit the whole document).
