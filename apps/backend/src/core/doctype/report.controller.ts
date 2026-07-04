import { Controller, Get, Param, Query } from "@nestjs/common";
import { PermType } from "@fat/shared";
import { DoctypeRegistryService } from "./doctype-registry.service";
import { DocumentService } from "./document.service";
import { PermissionService } from "../permissions/permission.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

const RESERVED = new Set(["group_by", "aggregate", "aggregate_field"]);

@Controller("api/report/:doctype")
export class ReportController {
  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  async run(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Query() query: Record<string, string>,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Report);

    const filters: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(query)) {
      if (!RESERVED.has(k)) filters[k] = v;
    }
    const data = await this.documents.report(dt, user, {
      groupBy: query.group_by,
      aggregate: query.aggregate === "sum" ? "sum" : "count",
      aggregateField: query.aggregate_field,
      filters,
    });
    return { data };
  }
}
