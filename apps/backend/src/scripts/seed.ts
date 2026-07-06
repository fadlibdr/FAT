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

  // Manufacturing: a raw material + a BOM that produces WIDGET-1 from it.
  await create("Item", {
    item_code: "RAW-STEEL",
    item_name: "Steel Sheet",
    item_group: "Products",
    stock_uom: "Nos",
    standard_rate: 8,
    is_stock_item: 1,
  });
  await create("BOM", {
    item: "WIDGET-1",
    quantity: 1,
    is_active: 1,
    is_default: 1,
    items: [{ item_code: "RAW-STEEL", qty: 2, rate: 8 }],
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
