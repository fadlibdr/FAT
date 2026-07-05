import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { FieldType, PermType, isDataFieldType } from "@fat/shared";
import { DoctypeRegistryService } from "./doctype-registry.service";
import { DocumentService } from "./document.service";
import { PermissionService } from "../permissions/permission.service";
import { tableNameFor, quoteIdent } from "./schema-sync.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

@Controller("api/print/:doctype/:name")
export class PrintController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    private readonly permissions: PermissionService,
  ) {}

  private async customHtml(doctype: string, name: string): Promise<string | null> {
    if (!this.registry.has("Print Format")) return null;
    const fmt = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("html")} AS html FROM ${quoteIdent(tableNameFor("Print Format"))}
         WHERE ${quoteIdent("document_type")} = $1 AND ${quoteIdent("is_active")} = 1 LIMIT 1`,
        [doctype],
      )
    )[0];
    if (!fmt?.html) return null;
    const dt = this.registry.getOrThrow(doctype);
    const doc = await this.documents.get(dt, name);
    return String(fmt.html).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, field) => {
      const v = doc[field];
      return v === null || v === undefined ? "" : String(v);
    });
  }

  /** Default HTML when no custom Print Format is active. */
  private async defaultHtml(doctype: string, name: string): Promise<string> {
    const dt = this.registry.getOrThrow(doctype);
    const doc = await this.documents.get(dt, name);
    const rows = dt.fields
      .filter((f) => isDataFieldType(f.fieldtype as FieldType) && (f.fieldtype as FieldType) !== FieldType.Table)
      .map((f) => {
        const v = doc[f.fieldname];
        if (v === null || v === undefined || v === "") return "";
        return `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${f.label ?? f.fieldname}</td><td style="padding:4px 0">${String(v)}</td></tr>`;
      })
      .join("");
    return `<div style="font-family:sans-serif"><h1 style="color:#4f46e5">${doctype} ${doc.name}</h1><table>${rows}</table></div>`;
  }

  /** Rendered HTML for a custom Print Format, or null if none (used by the UI). */
  @Get()
  async render(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
  ) {
    await this.permissions.assertPerm(user, doctype, PermType.Read);
    return { data: { html: await this.customHtml(doctype, name) } };
  }

  /** Server-rendered PDF via the pre-installed Chromium. */
  @Get("pdf")
  async pdf(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
    @Res() res: Response,
  ) {
    await this.permissions.assertPerm(user, doctype, PermType.Read);
    const html = (await this.customHtml(doctype, name)) ?? (await this.defaultHtml(doctype, name));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><body>${html}</body></html>`, {
        waitUntil: "load",
      });
      const pdf: Buffer = await page.pdf({ format: "A4", printBackground: true });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${doctype}-${name}.pdf"`);
      res.end(pdf);
    } finally {
      await browser.close();
    }
  }
}
