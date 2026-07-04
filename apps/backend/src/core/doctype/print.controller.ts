import { Controller, Get, Param } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { PermType } from "@fat/shared";
import { DoctypeRegistryService } from "./doctype-registry.service";
import { DocumentService } from "./document.service";
import { PermissionService } from "../permissions/permission.service";
import { tableNameFor, quoteIdent } from "./schema-sync.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

@Controller("api/print/:doctype/:name")
export class PrintController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    private readonly permissions: PermissionService,
  ) {}

  /** Returns the rendered HTML for a custom Print Format, or null if none. */
  @Get()
  async render(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Read);

    if (!this.registry.has("Print Format")) return { data: { html: null } };
    const fmt = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("html")} AS html FROM ${quoteIdent(tableNameFor("Print Format"))}
         WHERE ${quoteIdent("document_type")} = $1 AND ${quoteIdent("is_active")} = 1
         LIMIT 1`,
        [doctype],
      )
    )[0];
    if (!fmt?.html) return { data: { html: null } };

    const doc = await this.documents.get(dt, name);
    const html = String(fmt.html).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, field) => {
      const v = doc[field];
      return v === null || v === undefined ? "" : String(v);
    });
    return { data: { html } };
  }
}
