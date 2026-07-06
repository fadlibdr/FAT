import { Args, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { GraphQLJSON } from "./json.scalar";
import { ForbiddenException } from "@nestjs/common";
import { PermType } from "@fat/shared";
import { DoctypeRegistryService } from "../core/doctype/doctype-registry.service";
import { DocumentService, ListOptions } from "../core/doctype/document.service";
import { PermissionService } from "../core/permissions/permission.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { UserContext } from "../core/permissions/permission.service";

/**
 * A single generic resolver over the metadata-driven DocType engine — the same
 * DocumentService and permission checks the REST controller uses. One schema
 * serves every DocType; documents flow as the permissive JSON scalar.
 */
@Resolver()
export class DocumentResolver {
  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    private readonly permissions: PermissionService,
  ) {}

  @Query(() => [GraphQLJSON], { name: "documents" })
  async documents_(
    @CurrentUser() user: UserContext,
    @Args("doctype") doctype: string,
    @Args("filters", { type: () => GraphQLJSON, nullable: true }) filters?: Record<string, unknown>,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("offset", { type: () => Int, nullable: true }) offset?: number,
    @Args("orderBy", { nullable: true }) orderBy?: string,
    @Args("orderDir", { nullable: true }) orderDir?: string,
  ): Promise<unknown[]> {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Read);
    const opts: ListOptions = {
      filters: filters ?? {},
      limit,
      offset,
      orderBy,
      orderDir: orderDir === "asc" ? "ASC" : "DESC",
    };
    return this.documents.list(dt, user, opts);
  }

  @Query(() => GraphQLJSON, { name: "document", nullable: true })
  async document_(
    @CurrentUser() user: UserContext,
    @Args("doctype") doctype: string,
    @Args("name") name: string,
  ): Promise<unknown> {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Read);
    const doc = await this.documents.get(dt, name);
    if (!(await this.documents.canAccessRow(dt, user, doc))) {
      throw new ForbiddenException(`No permission for ${doctype} ${name}`);
    }
    return doc;
  }

  @Mutation(() => GraphQLJSON, { name: "saveDocument" })
  async saveDocument(
    @CurrentUser() user: UserContext,
    @Args("doctype") doctype: string,
    @Args("data", { type: () => GraphQLJSON }) data: Record<string, unknown>,
    @Args("name", { nullable: true }) name?: string,
  ): Promise<unknown> {
    const dt = this.registry.getOrThrow(doctype);
    if (name) {
      await this.permissions.assertPerm(user, doctype, PermType.Write);
      return this.documents.update(dt, user, name, data);
    }
    await this.permissions.assertPerm(user, doctype, PermType.Create);
    return this.documents.create(dt, user, data);
  }

  @Mutation(() => GraphQLJSON, { name: "submitDocument" })
  async submitDocument(
    @CurrentUser() user: UserContext,
    @Args("doctype") doctype: string,
    @Args("name") name: string,
  ): Promise<unknown> {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Submit);
    return this.documents.setDocStatus(dt, user, name, 1);
  }

  @Mutation(() => GraphQLJSON, { name: "cancelDocument" })
  async cancelDocument(
    @CurrentUser() user: UserContext,
    @Args("doctype") doctype: string,
    @Args("name") name: string,
  ): Promise<unknown> {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Cancel);
    return this.documents.setDocStatus(dt, user, name, 2);
  }

  @Mutation(() => Boolean, { name: "deleteDocument" })
  async deleteDocument(
    @CurrentUser() user: UserContext,
    @Args("doctype") doctype: string,
    @Args("name") name: string,
  ): Promise<boolean> {
    const dt = this.registry.getOrThrow(doctype);
    await this.permissions.assertPerm(user, doctype, PermType.Delete);
    await this.documents.remove(dt, user, name);
    return true;
  }
}
