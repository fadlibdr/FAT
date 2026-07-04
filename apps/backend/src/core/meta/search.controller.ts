import { Controller, Get, Query } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { PermType } from "@fat/shared";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { PermissionService } from "../permissions/permission.service";
import { tableNameFor, quoteIdent } from "../doctype/schema-sync.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

interface Hit {
  doctype: string;
  name: string;
  title: string;
}

@Controller("api/search")
export class SearchController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: DoctypeRegistryService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  async search(@CurrentUser() user: UserContext, @Query("q") q: string) {
    const term = (q ?? "").trim();
    if (term.length < 2) return { data: [] as Hit[] };
    const like = `%${term}%`;
    const hits: Hit[] = [];

    for (const dt of this.registry.list()) {
      if (dt.istable) continue;
      if (hits.length >= 20) break;
      if (!(await this.permissions.hasPerm(user, dt.name, PermType.Read))) continue;

      const titleField =
        dt.title_field && dt.fields.some((f) => f.fieldname === dt.title_field)
          ? dt.title_field
          : null;
      const cols = titleField
        ? `${quoteIdent("name")} AS name, ${quoteIdent(titleField)} AS title`
        : `${quoteIdent("name")} AS name, ${quoteIdent("name")} AS title`;
      const where = titleField
        ? `${quoteIdent("name")} ILIKE $1 OR ${quoteIdent(titleField)} ILIKE $1`
        : `${quoteIdent("name")} ILIKE $1`;
      try {
        const rows = await this.dataSource.query(
          `SELECT ${cols} FROM ${quoteIdent(tableNameFor(dt.name))} WHERE ${where} LIMIT 5`,
          [like],
        );
        for (const r of rows) {
          hits.push({ doctype: dt.name, name: r.name, title: r.title ?? r.name });
        }
      } catch {
        // table may not exist yet; skip
      }
    }
    return { data: hits.slice(0, 20) };
  }
}
