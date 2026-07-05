import { Body, Controller, ForbiddenException, Get, Param, Post } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

/**
 * RBAC administration (System Manager only): list roles/users, view and edit a
 * user's role assignments (`tabHasRole`). Per-DocType permission editing reuses
 * the DocType admin endpoint / builder.
 */
@Controller("api/admin/rbac")
export class RbacController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private assert(user: UserContext) {
    if (!user.isSuper) throw new ForbiddenException("System Manager access required");
  }

  @Get("roles")
  async roles(@CurrentUser() user: UserContext) {
    this.assert(user);
    const rows = await this.dataSource.query(`SELECT "name" FROM "tabRole" ORDER BY "name"`);
    return { data: rows.map((r: { name: string }) => r.name) };
  }

  @Get("users")
  async users(@CurrentUser() user: UserContext) {
    this.assert(user);
    const rows = await this.dataSource.query(
      `SELECT "name", "email", "full_name" FROM "tabUser" ORDER BY "name"`,
    );
    return { data: rows };
  }

  @Get("user-roles/:user")
  async userRoles(@CurrentUser() user: UserContext, @Param("user") target: string) {
    this.assert(user);
    const rows = await this.dataSource.query(
      `SELECT "role" FROM "tabHasRole" WHERE "parent" = $1 ORDER BY "role"`,
      [target],
    );
    return { data: rows.map((r: { role: string }) => r.role) };
  }

  @Post("assign")
  async assign(@CurrentUser() user: UserContext, @Body() body: { user: string; role: string }) {
    this.assert(user);
    await this.dataSource.query(
      `INSERT INTO "tabHasRole" ("parent", "role") VALUES ($1, $2)
       ON CONFLICT ("parent", "role") DO NOTHING`,
      [body.user, body.role],
    );
    return { data: { user: body.user, role: body.role, assigned: true } };
  }

  @Post("unassign")
  async unassign(@CurrentUser() user: UserContext, @Body() body: { user: string; role: string }) {
    this.assert(user);
    await this.dataSource.query(
      `DELETE FROM "tabHasRole" WHERE "parent" = $1 AND "role" = $2`,
      [body.user, body.role],
    );
    return { data: { user: body.user, role: body.role, assigned: false } };
  }
}
