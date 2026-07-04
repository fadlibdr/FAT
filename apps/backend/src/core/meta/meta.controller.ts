import { Controller, ForbiddenException, Get, Param } from "@nestjs/common";
import { PermType, type DocTypeMeta } from "@fat/shared";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { PermissionService } from "../permissions/permission.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

@Controller("api/meta")
export class MetaController {
  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly permissions: PermissionService,
  ) {}

  /** DocTypes the current user may read (for navigation). */
  @Get()
  async list(@CurrentUser() user: UserContext) {
    const out: Array<{ name: string; module: string; is_submittable: boolean }> = [];
    for (const dt of this.registry.list()) {
      if (dt.istable) continue;
      if (await this.permissions.hasPerm(user, dt.name, PermType.Read)) {
        out.push({
          name: dt.name,
          module: dt.module,
          is_submittable: dt.is_submittable,
        });
      }
    }
    out.sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
    return out;
  }

  /** Full metadata for one DocType, filtered to the user's permissions. */
  @Get(":doctype")
  async get(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
  ): Promise<DocTypeMeta> {
    const dt = this.registry.getOrThrow(doctype);
    if (!(await this.permissions.hasPerm(user, doctype, PermType.Read))) {
      throw new ForbiddenException(`No read permission on ${doctype}`);
    }
    const readable = await this.permissions.readablePermlevels(user, doctype);
    const permissions = await this.permissions.getEffectivePermissions(user, doctype);

    return {
      name: dt.name,
      module: dt.module,
      naming_rule: dt.naming_rule,
      istable: dt.istable,
      is_submittable: dt.is_submittable,
      title_field: dt.title_field,
      fields: dt.fields.filter((f) => (f.permlevel ?? 0) === 0 || readable.has(f.permlevel ?? 0)),
      permissions,
    };
  }
}
