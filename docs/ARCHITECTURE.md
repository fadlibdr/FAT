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

## Phase 40 — Deferred revenue recognition

A self-contained deferred-revenue flow in the accounting module (two DocTypes + a
`DeferredRevenueListener` + a `DeferredRevenueService`, no cross-module imports):

- **Schedule.** `before_save` splits the total into equal monthly installments (the
  last row absorbing the rounding remainder). On submit the listener books the full
  amount Dr Receivable / Cr Deferred Revenue (a liability) and marks the schedule
  Active; cancel deletes the GL.
- **Recognition.** `DeferredRevenueService.run(asOf)` (exposed at
  `POST /api/accounting/deferred-revenue/run`) walks every Active schedule, posts
  Dr Deferred Revenue / Cr Income for each unrecognized installment due on/before
  the cutoff, flags the row, bumps the recognized total, and completes the schedule
  when fully released. Flagging rows makes the run idempotent (verified: a repeat
  run recognizes nothing).
- **Report.** A `deferred-revenue` report shows total / recognized / remaining per
  schedule. The trial balance stays balanced throughout.

## Phase 41 — Project scheduling & progress

A self-contained project-scheduling flow in the projects module (a `TaskListener`
added alongside the existing `ProjectsListener`, no cross-module imports):

- **Scheduling gate.** Task gains `exp_start_date`, `depends_on` (a Link to another
  Task), and `progress`. A `before_save:Task` gate (`suppressErrors:false`) rejects
  a task whose end precedes its start, and — for a dependent task — a start that
  falls before the task it depends on finishes (finish-to-start). Date fields
  deserialize as `Date` objects, so comparisons normalise through epoch
  milliseconds rather than string order.
- **Progress rollup.** Project gains a read-only `percent_complete`. On task insert
  or update the listener recomputes it as the average `progress` of the project's
  tasks (verified: 40 → 70 on a second task, then 90 after editing the first).
- **Report.** A `project-progress` report shows, per project, the task count, the
  completed/open split (NULL status counts as open, since field defaults are
  UI-applied), average task progress, and the stored percent-complete.

## Phase 42 — Employee advances & settlement

A self-contained advance/expense flow in the HR module (a new `Employee Advance`
DocType + `EmployeeAdvanceListener`, plus an extension of the existing
`ExpenseClaimListener`; no cross-module imports):

- **Advance.** On submit the listener books Dr Employee Advance (an asset — the
  employee owes it back) / Cr the paid-from account (Cash/Bank) for the advance
  amount and marks it Paid. Cancel reverses the GL.
- **Settlement.** An Expense Claim may link an advance. On submit the claim still
  debits each expense line, but the credit is **split**: the part covered by the
  advance's remaining balance (`advance_amount − claimed_amount`) is credited to
  the advance account — working the receivable down rather than raising a new
  payable — and only the excess is credited to Employee Payable. The advance's
  `claimed_amount` is bumped and it flips to Claimed once fully consumed. A
  `before_submit` gate (`suppressErrors:false`) blocks a claim adjusting against a
  different employee's advance or one with no balance left; cancel unwinds the
  adjustment (restoring `claimed_amount` and status). Every posting stays a
  balanced double entry (verified: a 600 claim credits the advance in full, a
  follow-up 700 claim credits 400 to the advance and 300 to the payable).
- **Report.** An `employee-advance-summary` report shows per advance the amount
  paid, claimed, and outstanding balance.

## Phase 43 — Exchange rate revaluation

A self-contained revaluation flow in the accounting module (an `Exchange Rate
Revaluation` submittable DocType + child account table + an
`ExchangeRevaluationListener`; GL posted through the generic `DocumentService`, no
cross-module imports). This closes the "single conversion rate, no revaluation"
multi-currency gap noted below.

- **Computation.** `before_save` walks the account rows and sets each row's
  `gain_loss = round(balance × (new_rate − current_rate))`, summing them into the
  header `total_gain_loss` (verified: a 1000-balance row from 1.10→1.20 yields +100,
  a 500-balance row from 1.40→1.30 yields −50, total +50).
- **Posting.** On submit the listener books, per account, the adjustment as a
  balanced pair: a positive revaluation debits the account (its base value rose) and
  credits the `Exchange Gain/Loss` P&L account; a negative one reverses. The set is
  net-zero and the trial balance stays balanced (verified: GL Σdebit − Σcredit = 0).
  Cancel deletes the voucher's GL and flips the status to Cancelled.
- **Report.** An `exchange-rate-revaluation` report lists each account's balance,
  current/new rate, and gain/loss per submitted voucher.

Simplification: the gain/loss sign convention treats every revalued account the
same way (positive delta → debit the account); it does not distinguish asset vs
liability accounts, and balances are entered on the voucher rather than derived from
live foreign-currency ledger positions.

## Phase 44 — Perpetual inventory GL

An `InventoryGlListener` in the accounting module books the accounting side of each
stock movement, keeping the Stock In Hand asset account in step with the physical
stock ledger. It reads stock data (Bin valuation, Stock Ledger Entry) via SQL only —
no cross-module service imports; GL is posted through the generic `DocumentService`.

- **Receipt.** On Purchase Receipt submit it posts Dr Stock In Hand / Cr Stock
  Received But Not Billed at the received value (Σ qty × rate). Cancel deletes the
  voucher GL.
- **Issue.** On Delivery Note submit it posts Dr Cost of Goods Sold / Cr Stock In
  Hand at the delivered items' current valuation; a sales return reverses the sign.
  The valuation rate is read from the Bin moving-average rate (preserved across an
  issue), falling back to the latest stock-ledger rate if a Bin has been drawn to
  zero — so the COGS is race-independent of the stock-ledger listener that reacts to
  the same event. Cancel deletes the voucher GL.
- **Reconciliation report.** An `inventory-valuation` report lists each
  item/warehouse's Bin stock value beside the running Stock In Hand GL balance
  (verified: after receiving 10 @ 100 and delivering 4, both read 600; cancelling the
  delivery restores both to 1000).

Simplification: the Stock Received But Not Billed clearing account is raised on
receipt but not cleared by the Purchase Invoice (which still books its own expense);
perpetual and periodic postings therefore coexist rather than fully interlocking.

## Phase 45 — Sales pipeline forecasting

Extends the existing `CrmListener` (no new module, no cross-module imports):

- **Probability from stage.** `before_save:Opportunity` derives the win probability
  from the sales stage (Prospecting 10 / Qualification 25 / Proposal 50 / Negotiation
  75), but only when the save carries no explicit probability — a manually entered
  value sticks, and clearing it re-derives from the (possibly changed) stage. Running
  on before_save means it acts on the fields actually being changed.
- **Terminal override.** Closed Won forces 100% and Closed Lost forces 0%, regardless
  of any entered probability — a won deal is fully weighted, a lost one drops out.
- **Weighted value.** `weighted_amount = amount × probability` is computed in
  after_insert/after_update from the *persisted* row (a partial update may omit the
  amount, and `name` is not on the before_save payload) and written back with raw SQL,
  so there is no event re-entry.
- **Report.** A `sales-pipeline` report totals count, amount, and weighted forecast
  per open stage (Closed Won/Lost excluded). Verified: Proposal 10000 → 50 % / 5000;
  a Closed Won override → 100 % / 10000; Closed Lost → 0; re-deriving Negotiation →
  75 % / 7500.

## Phase 46 — Employee loans

A self-contained loan flow in the HR module (a `Loan` submittable DocType + a
`Loan Repayment` child schedule + a `LoanListener`; GL via the generic
`DocumentService`, no cross-module imports):

- **Amortisation.** `before_save` builds the repayment schedule with equal monthly
  principal and interest charged on the reducing balance
  (`balance × rate ÷ 12`), the last instalment absorbing any rounding so the loan
  closes at exactly zero. Total interest and total payable roll up onto the header
  (verified: 12000 @ 12 % over 12 months → interest 120, 110, … 10, total interest
  780, total payable 12780, closing balance 0).
- **Disbursement.** On submit the listener books Dr Employee Loan (an asset the
  employee owes back) / Cr the disbursing account (Cash/Bank) for the principal and
  marks the loan Disbursed. Cancel deletes the voucher GL and flips to Cancelled.
- **Report.** A `loan-repayment-schedule` report lists each instalment's principal,
  interest, total payment, and outstanding-after balance per submitted loan.

## Phase 47 — Loan repayment & closure

Completes the loan lifecycle with a `Loan Repayment Entry` submittable DocType + a
`LoanRepaymentListener` (still HR, still no cross-module imports):

- **Split posting.** Each repayment carries a principal and an interest part. On submit
  the listener posts Dr the receiving account (Cash/Bank) for the total, Cr Employee
  Loan for the principal (reducing the asset), and Cr Interest Income for the interest
  — a balanced three-line entry (verified: 1000 + 120 → Dr Cash 1120 / Cr Employee Loan
  1000 / Cr Interest Income 120, Σdebit − Σcredit = 0).
- **Tracking & closure.** The loan's `repaid_principal` / `interest_paid` roll up and the
  loan flips to Closed once the principal is fully repaid. A `before_submit` gate
  (`suppressErrors:false`) blocks over-repayment (repaid + this > loan amount) and
  repaying a loan that is not Disbursed (verified: a 20000 repayment on an 11000
  outstanding is rejected). Cancel reverses the GL and unwinds the loan totals, dropping
  it back to Disbursed.
- **Report.** A `loan-outstanding` report shows per disbursed loan the amount, principal
  repaid, outstanding, and interest collected.

## Phase 48 — Batch payroll run

A `Payroll Entry` submittable DocType + a `PayrollEntryListener` orchestrate payroll at
scale, still purely over the engine (no cross-module imports — slips are created and
submitted through the generic `DocumentService`):

- **Generation.** On submit the listener selects the active employees of the entry's
  company and, for each, creates a Salary Slip stamped with the structure, period, and a
  back-link to the entry, then submits it — the existing `PayrollListener` computes that
  slip's gross/net and posts its balanced journal (verified: 6 employees → 6 slips at
  gross 6000 / deduction 900 / net 5100, all GL balanced).
- **Rollup.** The entry records employees paid and total net pay. Because the slip
  `on_submit` hook is fire-and-forget (`emit`, not `emitAsync`), the per-slip `net_pay`
  is not yet persisted when `setDocStatus` returns; the entry therefore totals the
  structure's *nominal* net (Σ earnings − Σ deductions) × employees paid, which equals
  the summed slip nets when attendance is full (verified: total 30600).
- **Cascade cancel.** Cancelling the entry cancels every slip carrying its back-link,
  reversing each slip's GL (verified: 6 slips dropped to draft, their GL removed).
- **Report.** A `payroll-register` report lists each submitted slip's gross, deduction,
  and net, filterable by payroll run.

Simplification: the entry's headline total uses the structure's nominal net; per-employee
loss-of-pay proration still applies on each individual slip and shows in the register.

## Phase 49 — End-of-service gratuity

A self-contained gratuity flow in the HR module (a `Gratuity` submittable DocType + a
`GratuityListener`; GL via the generic `DocumentService`, no cross-module imports):

- **Computation.** `before_save` derives service years from (relieving − joining) ÷ 365.25
  and the gratuity amount = (monthly salary ÷ 30) × days-per-year × service years
  (verified: joined 2020-01-01, relieved 2026-01-01, salary 6000, 15 days/year →
  6.0 years, 18000).
- **Provision.** On submit the listener books Dr Gratuity Expense / Cr Gratuity Payable
  for the amount and marks it Submitted; cancel deletes the voucher GL and flips to
  Cancelled (verified: balanced GL, clean reversal).
- **Report.** A `gratuity-summary` report shows per submitted voucher the employee,
  service years, monthly salary, gratuity amount, and status.

## Phase 50 — Budget control

A `BudgetGateListener` in the accounting module enforces budgets at spend time (no new
DocType — the existing Budget gains an over-budget action; the gate reads GL via SQL,
no cross-module imports):

- **Action.** Budget gains `action_if_annual_budget_exceeded` (Ignore / Warn / Stop).
- **Gate.** A `before_submit:Purchase Invoice` gate (`suppressErrors:false`) matches a
  Budget by the bill's expense account + cost centre, sums the cumulative actual
  (Σ GL Dr − Cr) already posted there, and compares actual + this bill to the budget.
  Stop throws and aborts the submit; Warn logs and allows; Ignore does nothing (a debit
  note is exempt). Verified: on a 1000 budget, an 800 bill posts, a following 500 bill
  is blocked (actual 800 + 500 > 1000); a Warn budget lets a 500 bill through over a 100
  limit.
- **Report.** A `budget-utilization` report shows per budget the amount, actual, remaining,
  percent used, and action.

## Phase 51 — Commission payout

Builds on the Salesteam commission accrual (which rolls `total_commission` onto each Sales
Person as invoices submit) with a settlement flow — a `Commission Payout` submittable
DocType + a `CommissionPayoutListener` (still Salesteam, no cross-module imports):

- **Payout.** On submit the listener books Dr Commission Expense / Cr Commission Payable for
  the amount and bumps the sales person's `paid_commission`.
- **Gate.** A `before_submit` gate (`suppressErrors:false`) blocks a payout that would push
  paid above accrued (verified: on 500 accrued, a 300 payout posts, a second 300 is rejected
  as exceeding the 200 unpaid balance). Cancel reverses the GL and unwinds `paid_commission`.
- **Report.** A `commission-payable` report shows per sales person the accrued, paid, and
  outstanding commission.

## Phase 52 — Asset depreciation run

An `AssetDepreciationService` (+ an `AssetsController`) adds batch depreciation on top of the
existing per-entry posting (no cross-module imports — entries are created and submitted through
the generic `DocumentService`):

- **Run.** `POST /api/assets/depreciation/run` (body `as_of`) walks every submitted asset still
  above its salvage value and not yet depreciated for the cutoff, computes one month of
  straight-line depreciation ((gross − salvage) ÷ life ÷ 12, capped at the remaining depreciable
  base), and creates + submits a Depreciation Entry — the AssetsListener posts Dr Depreciation
  Expense / Cr Accumulated Depreciation and rolls up the asset's accumulated total. The asset's
  `last_depreciation_date` is stamped so a repeat run for the same cutoff is a no-op.
- **Report.** An `asset-depreciation-schedule` report shows per asset the gross, salvage, monthly
  charge, accumulated depreciation, current value, last run date, and status.

Verified: a 12000 / 5-year asset depreciates 200 per run (balanced GL); a repeat run for the same
month is skipped; the next month advances accumulated to 400 and current value to 11600.

## Phase 53 — Accounting period lock

An `Accounting Period` DocType + a `PeriodLockListener` prevent back-posting into closed
periods (accounting module, no cross-module imports):

- **Period.** An Accounting Period defines a date range and a `is_closed` flag.
- **Gate.** `before_submit` gates on Journal Entry, Sales Invoice, and Purchase Invoice
  (`suppressErrors:false`) reject a submit whose posting date falls inside any closed period.
  Reopening the period (clearing the flag) lets the same voucher post (verified: a 2026-07-15
  Journal Entry is blocked while July is closed, a 2026-08-15 one posts, and the July entry
  posts once the period is reopened).
- **Report.** An `accounting-period-status` report lists each period with its lock state and the
  count of GL entries already posted in its range.

## Phase 54 — Purchase three-way match

A `ThreeWayMatchListener` in the buying module enforces that received and billed quantities stay
within what was ordered (event-bus only, reads via SQL, no cross-module imports):

- **Gates.** `before_submit` on Purchase Receipt and Purchase Invoice (`suppressErrors:false`)
  sums the quantity already received / billed per item against the linked Purchase Order (from
  other *submitted* documents), adds this document's lines, and rejects the submit if any item
  would exceed the ordered quantity. Receipts/invoices not linked to a PO are unaffected.
- **Report.** A `purchase-order-status` report shows per submitted PO the order value, % received,
  % billed, and status.

Verified: on a PO for 10, a receipt of 6 posts, a further receipt of 6 is blocked (12 > 10), and a
receipt of 4 (reaching 10) posts; likewise a Purchase Invoice for 12 is blocked while one for 10
posts, after which the PO reads 100% received / 100% billed.

## Phase 55 — Sales fulfilment control

A `SoFulfillmentGateListener` in the selling module is the sell-side mirror of the purchase
three-way match (event-bus only, reads via SQL, no cross-module imports):

- **Gates.** `before_submit` on Delivery Note and Sales Invoice (`suppressErrors:false`) sum the
  quantity already delivered / billed per item against the linked Sales Order (from other
  *submitted*, non-return documents), add this document's lines, and reject the submit if any item
  would exceed the ordered quantity. Returns (`is_return`) and documents without a Sales Order are
  exempt. This composes with the existing stock-availability and quality-inspection gates.
- **Report.** A `sales-order-status` report shows per submitted Sales Order the order value,
  % delivered, % billed, and status.

Verified: on a Sales Order for 10, a delivery of 6 posts, a further delivery of 6 is blocked
(12 > 10), and a delivery of 4 posts; a Sales Invoice for 12 is blocked while one for 10 posts.
(The demo "buy 5 WIDGET-1 get 1 WIDGET-F free" pricing rule adds a free line to the order, which
the report's % delivered correctly reflects.)

## Phase 56 — Recurring journals

A `Recurring Journal` template (+ a `Recurring Journal Account` child) and a
`RecurringJournalService` (+ endpoint) automate periodic accruals/prepayments (accounting module,
posts through the generic `DocumentService`, no cross-module imports):

- **Template.** A Recurring Journal carries a frequency (Weekly/Monthly), a next posting date, an
  enabled flag, and a set of account rows (account / debit / credit).
- **Run.** `POST /api/accounting/recurring-journal/run` (body `as_of`) posts, for each enabled
  template due on or before the cutoff, one Journal Entry per due period up to the cutoff (a
  catch-up loop) — the JournalListener validates the balance and posts the GL — then advances the
  template's next date so a repeat run is a no-op. Each entry is stamped with a back-link to its
  template.
- **Report.** A `recurring-journal-status` report lists each template's frequency, next date,
  enabled flag, and the count of Journal Entries it has posted.

Verified: a monthly template (Dr COGS 1000 / Cr Cash 1000, next 2026-07-01) posts one balanced
entry when run as-of 2026-07-15 (next → 2026-08-01); a repeat run posts nothing; a run as-of
2026-09-15 catches up two entries (Aug + Sep), advancing next to 2026-10-01 (3 entries total).

## Phase 57 — Cash reporting

Three query-reports complete the cash picture (no schema changes — read-only over GL and invoice
outstanding):

- **cash-flow-statement.** Direct method: movements on the Cash / Bank accounts, classified into
  Operating / Investing / Financing by the voucher type that moved the cash (assets/depreciation →
  Investing; loans/gratuity/commission/period-close → Financing; everything else → Operating), with
  optional from/to date filters.
- **bank-cash-summary.** Per cash/bank account, total inflow (Σ debit), outflow (Σ credit), and
  current balance.
- **cash-flow-forecast.** Forward view: open Sales-Invoice outstanding as expected inflows and open
  Purchase-Invoice outstanding as expected outflows, bucketed by how far off each due date is
  (Overdue / 0-30 / 31-60 / 60+).

Verified: after a loan disbursement (Cr Cash 5000) and recurring journals (Cr Cash 3000), the
statement shows Financing −5000 and Operating −3000; the summary shows the Cash account at −8000;
the forecast nets open receivables 1500 against payables 1000 to +500.

Cash accounts are identified by name (`Cash`, `Bank`) since the demo chart types them both as Asset.

## Phase 58 — Bad-debt write-off

A `Write Off Entry` submittable DocType + a `WriteOffListener` handle uncollectable receivables
(accounting module, GL via the generic `DocumentService`, no cross-module imports):

- **Default & gate.** `before_save` defaults the write-off amount to the linked Sales Invoice's
  outstanding; a `before_submit` gate (`suppressErrors:false`) rejects an amount that exceeds that
  outstanding (verified: 1000 against a 0-outstanding invoice is blocked).
- **Posting.** On submit the listener books Dr Bad Debt Expense / Cr Debtors and, when a Sales
  Invoice is linked, reduces its outstanding and flips it to **Written Off** once cleared. Cancel
  deletes the voucher GL and restores the invoice's outstanding and status (verified: a 400 invoice
  writes off to 0 / Written Off with a balanced entry, and cancel restores it to 400 / Unpaid).
- **Report.** A `write-off-register` report lists submitted write-offs by customer, invoice,
  amount, account, and reason.

## Phase 59 — Sales tax templates

A `Sales Taxes Template` DocType + a `TaxTemplateListener` make invoice/order taxes reusable
(accounting module, reads the template via SQL, no cross-module imports):

- **Template.** A Sales Taxes Template holds a set of tax rows (account head, rate, description) in
  the same `Sales Taxes and Charges` child table the invoices use.
- **Application.** A `before_save` on Sales Invoice and Sales Order copies the template's rows into
  the document's `taxes` — but only when it carries none of its own, so explicit taxes still win.
  The existing recompute-totals job then computes each `tax_amount` (rate × net) and the grand
  total.
- Seeds a "Standard VAT 10%" template.

Verified: a Sales Invoice (net 400) naming the template auto-fills a VAT row and recomputes to
tax 40 / grand total 440; a Sales Order does the same.

## Phase 60 — Purchase tax templates

The buy-side mirror of Phase 59. A `Purchase Taxes Template` DocType and the same
`TaxTemplateListener` (now generalized over template + child doctype) populate purchase taxes:

- **Template.** A Purchase Taxes Template holds tax rows in the `Purchase Taxes and Charges` child
  the purchase documents use.
- **Application.** The listener's `before_save` on Purchase Invoice and Purchase Order copies the
  named template's rows into `taxes` when the document carries none of its own; recompute-totals
  then fills each `tax_amount` and the grand total.
- Seeds a "Standard Input VAT 10%" template.

Verified: a Purchase Invoice and a Purchase Order (net 400) naming the template each recompute to
tax 40 / grand total 440; an explicit tax row (25) on a document overrides the template.

## Phase 61 — Internal transfer

A `Contra Entry` submittable DocType + a `ContraEntryListener` move money between the company's own
accounts (accounting module, GL via the generic `DocumentService`, no cross-module imports):

- **Gate.** A `before_submit` gate (`suppressErrors:false`) rejects a non-positive amount or a
  from-account equal to the to-account.
- **Posting.** On submit the listener books Dr the receiving account / Cr the paying account; cancel
  deletes the voucher GL. Because both legs sit on cash/bank accounts, the transfer nets to zero in
  the cash-flow statement while moving the per-account balances in the bank/cash summary.
- **Report.** A `contra-entry-register` report lists submitted transfers.

Verified: a Cash → Bank transfer of 1000 books Dr Bank 1000 / Cr Cash 1000 (balanced) and the
bank/cash summary shows Bank +1000; a same-account transfer is blocked; cancel restores the balances.

## Phase 62 — Sales analytics

Three read-only query-reports over submitted (non-return) Sales Invoices (no schema changes):

- **top-selling-items** — quantity sold and revenue per item, ranked by revenue.
- **customer-revenue** — per customer, invoice count, total billed, and total outstanding.
- **gross-profit** — per item, revenue vs cost (sold quantity costed at the item's average Bin
  moving-average valuation), gross profit, and margin % (gross profit ÷ revenue).

Verified: with WIDGET-1 sold at revenue 1900 against an average cost of 100/unit (cost 1400), the
gross-profit report reads gross profit 500 / margin 26.3 %; customer-revenue shows Acme Inc with
1900 billed and 1500 outstanding; the free promotional line (WIDGET-F) reports zero revenue.

## Phase 63 — Inventory analytics

Three read-only query-reports over the Bin balances and Stock Ledger Entry history (no schema
changes):

- **stock-ageing** — on-hand item/warehouse balances with the date of their last stock movement and
  the age in days (relative to an `as_of` filter), surfacing stagnant stock.
- **slow-moving-items** — in-stock items ranked by days since their last *outbound* (sale) movement;
  items never sold sort to the top.
- **stock-value-by-group** — on-hand quantity and valuation aggregated per item group.

Verified: WIDGET-1 stock (95 units across two warehouses, valued 9500) shows an age of 10 days as of
2026-07-25; the Receiving balance (never sold) tops the slow-moving list; stock-value-by-group rolls
the Products group to 9500.

## Phase 64 — Quotation → Sales Order

Completes the quote-to-order step of the sales cycle. The existing `FulfillmentService` gains a
`makeSalesOrder` method and the selling controller an endpoint (no cross-module imports — everything
goes through the generic `DocumentService`):

- **Conversion.** `POST /api/selling/quotation/:name/make-sales-order` loads a *submitted* Quotation,
  creates a draft Sales Order from its items (delivery date defaulted from the quotation's valid-till),
  links the order back to the quotation, and stamps the quotation `Ordered`. It refuses an unsubmitted
  quotation or one already converted.
- **Fields.** Quotation gains a `status` (Draft / Open / Ordered / Expired) and a `sales_order`
  back-link; Sales Order gains a `quotation` link.
- **Report.** A `quotation-status` report lists submitted quotations with their status and linked order.

Verified: converting before submit is rejected; a submitted quotation (grand total 450) produces
SO-00004 with the item copied, both linked, and the quotation marked Ordered; a second conversion is
rejected as already ordered.

## Phase 65 — Purchasing analytics

Three read-only query-reports over submitted (non-return) Purchase Invoices — the buy-side complement
to the Phase 62 sales analytics (no schema changes):

- **top-purchased-items** — quantity and spend per item, ranked by spend.
- **supplier-spend** — per supplier, invoice count, total billed, and total outstanding.
- **purchase-price-trend** — per item, the average / minimum / maximum purchase rate and total qty,
  surfacing price dispersion across bills.

Verified: WIDGET-1 purchased 10 @ 100 shows spend 1000 and a flat avg/min/max rate of 100; supplier
Budget Parts Ltd rolls up to 1 invoice / 1000 spend / 1000 outstanding.

## Phase 66 — Lead → Opportunity

Completes the front of the CRM funnel. A `CrmService` + `CrmController` add an on-demand conversion
(the `CrmListener` still handles the automatic status-triggered ones); documents are created through
the generic `DocumentService`, so CRM imports no other module's services:

- **Conversion.** `POST /api/crm/lead/:name/make-opportunity` ensures the lead has a Customer (reusing
  its already-converted customer, or creating one named after the lead), opens an Opportunity against
  that customer linked back to the lead, and stamps the lead with the customer, the opportunity, and a
  Qualified status. It refuses a lead that already has an opportunity.
- **Report.** A `lead-conversion` report shows every lead with its funnel links (customer, opportunity).

With the earlier Opportunity → Quotation (CrmListener) and Quotation → Sales Order (Phase 64), the
funnel now runs Lead → Opportunity → Quotation → Sales Order, each step linked.

Verified: a fresh lead with no customer converts to a new Customer and Opportunity (both linked back,
lead marked Qualified); a second conversion is rejected as already having an opportunity.

## Phase 67 — Opportunity → Quotation

Adds the next explicit, on-demand step of the CRM funnel alongside the existing conversions, still
routed through the generic `DocumentService` (no cross-module service imports):

- **Conversion.** `POST /api/crm/opportunity/:name/make-quotation` copies the opportunity's customer and
  any Opportunity Items onto a new draft Quotation linked back to the opportunity, then stamps the
  opportunity with the quotation and advances its status to Quotation. It refuses an opportunity that
  already has a quotation. The Quotation DocType gains a read-only `opportunity` Link back-reference.
- **Report.** An `opportunity-funnel` report lists every opportunity with its status, sales stage,
  amount, weighted amount, and its source-lead and quotation links.

The funnel now runs Lead → Opportunity → Quotation → Sales Order end to end, every step created through
an explicit endpoint and linked in both directions.

Verified: an opportunity with two items converts to QTN-00002 (customer and both item lines copied,
`opportunity` back-link set); the opportunity moves to status Quotation with the quotation linked; a
second conversion is rejected; the funnel report shows the opportunity with weighted amount 4500
(7500 × 60% probability) and its quotation link.

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
