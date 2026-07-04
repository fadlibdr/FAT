import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { PermType } from "@fat/shared";
import { DoctypeRegistryService } from "./doctype-registry.service";
import { DocumentService, ListOptions } from "./document.service";
import { PermissionService } from "../permissions/permission.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

const RESERVED_QUERY_KEYS = new Set([
  "fields",
  "limit",
  "offset",
  "order_by",
  "order_dir",
]);

@Controller("api/resource/:doctype")
export class DocumentController {
  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Query() query: Record<string, string>,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Read);

    const filters: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(query)) {
      if (!RESERVED_QUERY_KEYS.has(k)) filters[k] = v;
    }
    const opts: ListOptions = {
      filters,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      orderBy: query.order_by,
      orderDir: query.order_dir === "asc" ? "ASC" : "DESC",
    };
    const data = await this.documents.list(dt, opts);
    return { data };
  }

  @Get(":name")
  async get(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Read);
    return { data: await this.documents.get(dt, name) };
  }

  @Post()
  async create(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Create);
    return { data: await this.documents.create(dt, user, body) };
  }

  @Put(":name")
  async update(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Write);
    return { data: await this.documents.update(dt, user, name, body) };
  }

  @Delete(":name")
  async remove(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Delete);
    await this.documents.remove(dt, user, name);
    return { data: { name } };
  }

  @Post(":name/submit")
  async submit(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Submit);
    return { data: await this.documents.setDocStatus(dt, user, name, 1) };
  }

  @Post(":name/cancel")
  async cancel(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
  ) {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Cancel);
    return { data: await this.documents.setDocStatus(dt, user, name, 2) };
  }
}
