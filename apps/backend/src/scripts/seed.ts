import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getDataSourceToken } from "@nestjs/typeorm";
import { AppModule } from "../app.module";
import { loadConfig } from "../config";
import { AuthService } from "../auth/auth.service";
import { DoctypeRegistryService } from "../core/doctype/doctype-registry.service";
import { DocumentService } from "../core/doctype/document.service";
import type { UserContext } from "../core/permissions/permission.service";

const ROLES = [
  "Administrator",
  "System Manager",
  "Sales User",
  "Purchase User",
  "Stock User",
  "Accounts User",
  "HR User",
];

async function main() {
  const logger = new Logger("Seed");
  const cfg = loadConfig();

  // Booting the app context registers every module's DocTypes and syncs their
  // physical tables (via each module's onModuleInit).
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  const ds = app.get<DataSource>(getDataSourceToken());
  const registry = app.get(DoctypeRegistryService);
  const documents = app.get(DocumentService);

  // --- Roles ---
  for (const role of ROLES) {
    await ds.query(
      `INSERT INTO "tabRole" ("name", "disabled") VALUES ($1, 0)
       ON CONFLICT ("name") DO NOTHING`,
      [role],
    );
  }

  // --- Administrator user ---
  const passwordHash = await AuthService.hashPassword(cfg.admin.password);
  await ds.query(
    `INSERT INTO "tabUser" ("name", "email", "full_name", "password_hash", "enabled", "creation")
     VALUES ($1, $1, $2, $3, 1, now())
     ON CONFLICT ("name") DO UPDATE SET "password_hash" = EXCLUDED."password_hash"`,
    [cfg.admin.email, "Administrator", passwordHash],
  );
  for (const role of ["Administrator", "System Manager"]) {
    await ds.query(
      `INSERT INTO "tabHasRole" ("parent", "role") VALUES ($1, $2)
       ON CONFLICT ("parent", "role") DO NOTHING`,
      [cfg.admin.email, role],
    );
  }

  const sys: UserContext = {
    name: cfg.admin.email,
    roles: ["Administrator", "System Manager"],
    isSuper: true,
  };

  // --- Sample master + transactional data (idempotent: ignore duplicates) ---
  async function create(doctype: string, data: Record<string, unknown>) {
    const dt = registry.get(doctype);
    if (!dt) return;
    try {
      await documents.create(dt, sys, data);
      logger.log(`Seeded ${doctype}: ${JSON.stringify(data).slice(0, 60)}`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) return; // already exists
      logger.warn(`Skip ${doctype}: ${(err as Error).message}`);
    }
  }

  // Create a submittable document and submit it (idempotent: skip on conflict).
  async function submit(doctype: string, data: Record<string, unknown>) {
    const dt = registry.get(doctype);
    if (!dt) return;
    try {
      const doc = await documents.create(dt, sys, data);
      await documents.setDocStatus(dt, sys, String(doc.name), 1);
      logger.log(`Seeded+submitted ${doctype}: ${doc.name}`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) return; // already exists
      logger.warn(`Skip ${doctype}: ${(err as Error).message}`);
    }
  }

  await create("Currency", { currency_name: "USD", symbol: "$", fraction: "Cent" });
  await create("Company", {
    company_name: "FAT Demo Co",
    abbr: "FDC",
    default_currency: "USD",
    country: "United States",
  });
  await create("Customer Group", { customer_group_name: "Commercial" });
  await create("Territory", { territory_name: "All Territories" });
  await create("Item Group", { item_group_name: "Products" });
  await create("UOM", { uom_name: "Nos" });

  await create("Customer", {
    customer_name: "Acme Inc",
    customer_group: "Commercial",
    territory: "All Territories",
    email_id: "hello@acme.example",
    credit_limit: 100000,
  });
  await create("Item", {
    item_code: "WIDGET-1",
    item_name: "Standard Widget",
    item_group: "Products",
    stock_uom: "Nos",
    standard_rate: 25,
    is_stock_item: 1,
  });

  // Chart-of-accounts stubs used by GL posting on Sales Invoice submit.
  await create("Account", { account_name: "Debtors", account_type: "Asset", company: "FAT Demo Co" });
  await create("Account", { account_name: "Sales", account_type: "Income", company: "FAT Demo Co" });
  await create("Account", { account_name: "Cash", account_type: "Asset", company: "FAT Demo Co" });
  await create("Account", { account_name: "Creditors", account_type: "Liability", company: "FAT Demo Co" });
  await create("Account", { account_name: "VAT", account_type: "Liability", company: "FAT Demo Co" });
  await create("Account", { account_name: "Cost of Goods Sold", account_type: "Expense", company: "FAT Demo Co" });
  await create("Account", { account_name: "Retained Earnings", account_type: "Equity", company: "FAT Demo Co" });
  await create("Account", { account_name: "Fixed Assets", account_type: "Asset", company: "FAT Demo Co" });
  await create("Account", { account_name: "Accumulated Depreciation", account_type: "Asset", company: "FAT Demo Co" });
  await create("Account", { account_name: "Repairs Expense", account_type: "Expense", company: "FAT Demo Co" });
  await create("Account", { account_name: "Gain/Loss on Asset Disposal", account_type: "Income", company: "FAT Demo Co" });
  await create("Account", { account_name: "Depreciation Expense", account_type: "Expense", company: "FAT Demo Co" });
  await create("Account", { account_name: "Interest Income", account_type: "Income", company: "FAT Demo Co" });
  await create("Account", { account_name: "Salary Expense", account_type: "Expense", company: "FAT Demo Co" });
  await create("Account", { account_name: "Salaries Payable", account_type: "Liability", company: "FAT Demo Co" });
  await create("Account", { account_name: "Tax Withheld Payable", account_type: "Liability", company: "FAT Demo Co" });
  await create("Account", { account_name: "Employee Expense", account_type: "Expense", company: "FAT Demo Co" });
  await create("Account", { account_name: "Employee Payable", account_type: "Liability", company: "FAT Demo Co" });
  await create("Cost Center", { cost_center_name: "Main", company: "FAT Demo Co" });
  await create("Budget", { cost_center: "Main", account: "Sales", budget_amount: 10000 });
  await create("Batch", { batch_id: "BATCH-A", item: "WIDGET-1" });
  await create("Currency", { currency_name: "EUR", symbol: "€", fraction: "Cent" });
  await create("Item", {
    item_code: "WIDGET-F",
    item_name: "FIFO Widget",
    item_group: "Products",
    stock_uom: "Nos",
    standard_rate: 20,
    valuation_method: "FIFO",
    is_stock_item: 1,
  });
  // Warehouses for stock ledger postings.
  await create("Warehouse", { warehouse_name: "Stores", company: "FAT Demo Co" });
  await create("Warehouse", { warehouse_name: "Finished Goods", company: "FAT Demo Co" });
  await create("Warehouse", { warehouse_name: "Receiving", company: "FAT Demo Co" });

  // Item variants: attributes + a template T-Shirt that varies on Size and Color.
  await create("Item Attribute", {
    attribute_name: "Size",
    values: [
      { attribute_value: "Small", abbreviation: "S" },
      { attribute_value: "Medium", abbreviation: "M" },
      { attribute_value: "Large", abbreviation: "L" },
    ],
  });
  await create("Item Attribute", {
    attribute_name: "Color",
    values: [
      { attribute_value: "Red", abbreviation: "RED" },
      { attribute_value: "Blue", abbreviation: "BLU" },
    ],
  });
  await create("Item", {
    item_code: "T-SHIRT",
    item_name: "T-Shirt",
    item_group: "Products",
    stock_uom: "Nos",
    standard_rate: 15,
    is_stock_item: 1,
    has_variants: 1,
    attributes: [{ attribute: "Size" }, { attribute: "Color" }],
  });

  // A serial-tracked unit under warranty, for maintenance/warranty demos.
  await create("Serial No", {
    serial_no: "SN-DEMO-001",
    item: "WIDGET-1",
    warehouse: "Stores",
    status: "Active",
    warranty_expiry_date: "2027-01-01",
  });

  // Manufacturing: a raw material + a BOM that produces WIDGET-1 from it.
  await create("Item", {
    item_code: "RAW-STEEL",
    item_name: "Steel Sheet",
    item_group: "Products",
    stock_uom: "Nos",
    standard_rate: 8,
    is_stock_item: 1,
  });
  // Shop floor: a workstation + operation, referenced by the BOM's routing so
  // the finished good is costed at material + labour.
  await create("Workstation", { workstation_name: "Assembly Line", hour_rate: 60 });
  await create("Operation", { operation_name: "Assemble", default_workstation: "Assembly Line" });
  await create("BOM", {
    item: "WIDGET-1",
    quantity: 1,
    is_active: 1,
    is_default: 1,
    items: [{ item_code: "RAW-STEEL", qty: 2, rate: 8 }],
    operations: [{ operation: "Assemble", workstation: "Assembly Line", time_in_mins: 30 }],
  });

  // Payroll: components + a salary structure for the demo employee.
  await create("Salary Component", { component_name: "Basic", component_type: "Earning", gl_account: "Salary Expense" });
  await create("Salary Component", { component_name: "Allowance", component_type: "Earning", gl_account: "Salary Expense" });
  await create("Salary Component", { component_name: "Tax", component_type: "Deduction", gl_account: "Tax Withheld Payable" });
  await create("Salary Structure", {
    structure_name: "Standard Engineer",
    company: "FAT Demo Co",
    is_active: 1,
    earnings: [
      { salary_component: "Basic", amount: 5000 },
      { salary_component: "Allowance", amount: 1000 },
    ],
    deductions: [{ salary_component: "Tax", amount: 900 }],
  });

  // Selling: a volume discount rule for Acme on WIDGET-1 (10+ qty -> 10% off).
  await create("Pricing Rule", {
    title: "Acme Widget Volume 10%",
    is_active: 1,
    priority: 1,
    apply_on: "Item Code",
    item_code: "WIDGET-1",
    customer: "Acme Inc",
    min_qty: 10,
    rate_or_discount: "Discount Percentage",
    discount_percentage: 10,
  });

  // Promotions: a coupon-gated 20%-off rule on WIDGET-F (+ its coupon), and a
  // buy-5-get-1-free rule (free FIFO Widget). The coupon links to the rule by
  // name, so create the rule directly to capture it.
  const prDt = registry.get("Pricing Rule");
  if (prDt) {
    try {
      const couponRule = await documents.create(prDt, sys, {
        title: "Coupon SAVE20 (WIDGET-F 20% off)",
        is_active: 1,
        priority: 5,
        apply_on: "Item Code",
        item_code: "WIDGET-F",
        coupon_based: 1,
        rate_or_discount: "Discount Percentage",
        discount_percentage: 20,
      });
      await create("Coupon Code", {
        coupon_code: "SAVE20",
        pricing_rule: couponRule.name,
        max_use: 5,
        valid_upto: "2027-12-31",
      });
    } catch (err) {
      logger.warn(`Skip coupon seed: ${(err as Error).message}`);
    }
  }
  await create("Pricing Rule", {
    title: "Buy 5 WIDGET-1 get 1 WIDGET-F free",
    is_active: 1,
    priority: 2,
    apply_on: "Item Code",
    item_code: "WIDGET-1",
    min_qty: 5,
    rate_or_discount: "Discount Percentage",
    price_or_product_discount: "Product",
    free_item: "WIDGET-F",
    free_qty: 1,
  });

  // Support: a default SLA with per-priority response/resolution targets.
  await create("Service Level Agreement", {
    service_level: "Default SLA",
    is_active: 1,
    is_default: 1,
    priorities: [
      { priority: "Low", response_time_hours: 24, resolution_time_hours: 120 },
      { priority: "Medium", response_time_hours: 8, resolution_time_hours: 48 },
      { priority: "High", response_time_hours: 4, resolution_time_hours: 24 },
      { priority: "Urgent", response_time_hours: 1, resolution_time_hours: 8 },
    ],
  });

  // Subscriptions: a monthly plan (demo subscription is created by the smoke run).
  await create("Subscription Plan", {
    plan_name: "Widget Monthly",
    item: "WIDGET-1",
    price: 25,
    billing_interval: "Month",
    interval_count: 1,
  });

  // Loyalty: a default program earning 0.1 points per currency unit invoiced.
  await create("Loyalty Program", {
    program_name: "Standard Rewards",
    is_active: 1,
    is_default: 1,
    collection_factor: 0.1,
    redemption_factor: 1,
  });

  // Accounts payable + cash management: a payment-terms template (half now, half
  // in 30 days) and a bank account mapped to the Cash GL account.
  await create("Payment Terms Template", {
    template_name: "50/50 Net 30",
    terms: [
      { description: "On receipt", invoice_portion: 50, credit_days: 0 },
      { description: "Net 30", invoice_portion: 50, credit_days: 30 },
    ],
  });
  await create("Bank Account", {
    account_name: "Main Checking",
    bank_name: "Demo Bank",
    account: "Cash",
  });

  // Buying: a supplier, plus a reorder-enabled consumable that starts below its
  // reorder level so the reorder run raises a Material Request for it.
  await create("Supplier", {
    supplier_name: "Global Supply Co",
    supplier_group: "Raw Material",
    email_id: "sales@globalsupply.example",
  });
  await create("Supplier", {
    supplier_name: "Budget Parts Ltd",
    supplier_group: "Raw Material",
    email_id: "quotes@budgetparts.example",
  });
  await create("Item", {
    item_code: "BOLT-1",
    item_name: "Hex Bolt",
    item_group: "Products",
    stock_uom: "Nos",
    standard_rate: 2,
    is_stock_item: 1,
    reorder_level: 50,
    reorder_qty: 100,
  });

  // Quality: an item that requires incoming inspection before its Purchase
  // Receipt can be submitted.
  await create("Item", {
    item_code: "GLASS-1",
    item_name: "Tempered Glass Panel",
    item_group: "Products",
    stock_uom: "Nos",
    standard_rate: 40,
    is_stock_item: 1,
    inspection_required_before_purchase: 1,
  });

  await create("ToDo", {
    description: "Welcome to FAT — try creating a Customer or Sales Order",
    status: "Open",
    priority: "High",
  });
  await create("ToDo", {
    description: "Review the DocType engine in apps/backend/src/core",
    status: "Open",
    priority: "Medium",
  });

  // HR demo + workflow.
  await create("Employee", {
    employee_name: "Jordan Lee",
    company: "FAT Demo Co",
    designation: "Engineer",
    status: "Active",
  });

  // HR: leave types + a submitted allocation so Jordan has a leave balance.
  await create("Leave Type", { leave_type_name: "Casual Leave", max_days_allowed: 12, is_paid: 1 });
  await create("Leave Type", { leave_type_name: "Sick Leave", max_days_allowed: 10, is_paid: 1 });
  await create("Leave Type", { leave_type_name: "Privilege Leave", max_days_allowed: 15, is_paid: 1 });
  await submit("Leave Allocation", {
    employee: "EMP-00001",
    leave_type: "Casual Leave",
    from_date: "2026-01-01",
    to_date: "2026-12-31",
    new_leaves_allocated: 12,
  });

  // Projects demo.
  await create("Project", {
    project_name: "Website Revamp",
    status: "Open",
    customer: "Acme Inc",
  });
  await create("Task", {
    subject: "Design mockups",
    project: "Website Revamp",
    status: "Open",
    priority: "High",
  });
  await create("Print Format", {
    print_format_name: "Sales Invoice Standard",
    document_type: "Sales Invoice",
    is_active: 1,
    html:
      "<div style='font-family:sans-serif'><h1 style='color:#4f46e5'>Invoice {{ name }}</h1>" +
      "<p><b>Customer:</b> {{ customer }}</p><p><b>Posting Date:</b> {{ posting_date }}</p>" +
      "<hr/><p>Net Total: {{ total }}</p><p>Taxes: {{ total_taxes_and_charges }}</p>" +
      "<h2>Grand Total: {{ grand_total }}</h2></div>",
  });
  await create("Workflow", {
    workflow_name: "Leave Approval",
    document_type: "Leave Application",
    is_active: 1,
    workflow_state_field: "workflow_state",
    states: [
      { state: "Open", doc_status: "0" },
      { state: "Approved", doc_status: "1" },
      { state: "Rejected", doc_status: "0" },
    ],
    transitions: [
      { state: "Open", action: "Approve", next_state: "Approved", allowed: "HR User" },
      { state: "Open", action: "Reject", next_state: "Rejected", allowed: "HR User" },
    ],
  });

  await app.close();
  logger.log("Seed complete.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("seed failed:", err);
  process.exit(1);
});
