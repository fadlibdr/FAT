import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { DoctypeLoaderService } from "../doctype/doctype-loader.service";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

/**
 * In-app DocType builder. System Managers can create/edit DocTypes at runtime;
 * SchemaSyncService (via the loader) provisions/updates the physical table
 * immediately.
 */
@Controller("api/admin/doctype")
export class DoctypeAdminController {
  constructor(
    private readonly loader: DoctypeLoaderService,
    private readonly registry: DoctypeRegistryService,
  ) {}

  private assertAdmin(user: UserContext) {
    if (!user.isSuper) throw new ForbiddenException("System Manager access required");
  }

  @Get(":name")
  get(@CurrentUser() user: UserContext, @Param("name") name: string) {
    this.assertAdmin(user);
    const dt = this.registry.getOrThrow(name);
    return {
      data: {
        name: dt.name,
        module: dt.module,
        naming_rule: dt.naming_rule,
        istable: dt.istable,
        is_submittable: dt.is_submittable,
        title_field: dt.title_field,
        fields: dt.fields,
        permissions: dt.perms,
      },
    };
  }

  @Post()
  async create(@CurrentUser() user: UserContext, @Body() body: unknown) {
    this.assertAdmin(user);
    const loaded = await this.loader.registerDef(body);
    return { data: { name: loaded.name } };
  }

  @Put(":name")
  async update(@CurrentUser() user: UserContext, @Body() body: unknown) {
    this.assertAdmin(user);
    const loaded = await this.loader.registerDef(body);
    return { data: { name: loaded.name } };
  }
}
