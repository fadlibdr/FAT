import { ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  PermType,
  SUPER_ROLES,
  type DocTypePermissions,
  NO_PERMISSIONS,
  ALL_PERMISSIONS,
} from "@fat/shared";
import { DocPermEntity } from "../doctype/entities/docperm.entity";
import { HasRoleEntity } from "./entities/has-role.entity";

export interface UserContext {
  name: string;
  roles: string[];
  isSuper: boolean;
}

const PERM_COLUMN: Record<PermType, keyof DocPermEntity> = {
  [PermType.Read]: "can_read",
  [PermType.Write]: "can_write",
  [PermType.Create]: "can_create",
  [PermType.Delete]: "can_delete",
  [PermType.Submit]: "can_submit",
  [PermType.Cancel]: "can_cancel",
  [PermType.Report]: "can_report",
};

@Injectable()
export class PermissionService {
  constructor(
    @InjectRepository(DocPermEntity)
    private readonly permRepo: Repository<DocPermEntity>,
    @InjectRepository(HasRoleEntity)
    private readonly hasRoleRepo: Repository<HasRoleEntity>,
  ) {}

  async getRoles(userName: string): Promise<string[]> {
    const rows = await this.hasRoleRepo.find({ where: { parent: userName } });
    return rows.map((r) => r.role);
  }

  async buildContext(userName: string): Promise<UserContext> {
    const roles = await this.getRoles(userName);
    const isSuper = roles.some((r) => SUPER_ROLES.includes(r));
    return { name: userName, roles, isSuper };
  }

  /** Base-level (permlevel 0) permission rows for a DocType across the roles. */
  private async permsFor(
    ctx: UserContext,
    doctype: string,
  ): Promise<DocPermEntity[]> {
    if (ctx.roles.length === 0) return [];
    return this.permRepo
      .createQueryBuilder("p")
      .where("p.parent = :dt", { dt: doctype })
      .andWhere("p.permlevel = 0")
      .andWhere("p.role IN (:...roles)", { roles: ctx.roles })
      .getMany();
  }

  async hasPerm(
    ctx: UserContext,
    doctype: string,
    perm: PermType,
  ): Promise<boolean> {
    if (ctx.isSuper) return true;
    const rows = await this.permsFor(ctx, doctype);
    const col = PERM_COLUMN[perm];
    return rows.some((r) => (r[col] as number) === 1);
  }

  async assertPerm(
    ctx: UserContext,
    doctype: string,
    perm: PermType,
  ): Promise<void> {
    if (!(await this.hasPerm(ctx, doctype, perm))) {
      throw new ForbiddenException(
        `No ${perm} permission on ${doctype} for user ${ctx.name}`,
      );
    }
  }

  /** Effective permission booleans for the UI. */
  async getEffectivePermissions(
    ctx: UserContext,
    doctype: string,
  ): Promise<DocTypePermissions> {
    if (ctx.isSuper) return { ...ALL_PERMISSIONS };
    const rows = await this.permsFor(ctx, doctype);
    const has = (col: keyof DocPermEntity) =>
      rows.some((r) => (r[col] as number) === 1);
    return {
      read: has("can_read"),
      write: has("can_write"),
      create: has("can_create"),
      delete: has("can_delete"),
      submit: has("can_submit"),
      cancel: has("can_cancel"),
      report: has("can_report"),
    };
  }

  /**
   * The set of permlevels the user can READ for a DocType (for field-level
   * hiding). permlevel 0 is always included when the user has any read perm.
   */
  async readablePermlevels(
    ctx: UserContext,
    doctype: string,
  ): Promise<Set<number>> {
    if (ctx.isSuper) return new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    if (ctx.roles.length === 0) return new Set();
    const rows = await this.permRepo
      .createQueryBuilder("p")
      .where("p.parent = :dt", { dt: doctype })
      .andWhere("p.role IN (:...roles)", { roles: ctx.roles })
      .andWhere("p.can_read = 1")
      .getMany();
    return new Set(rows.map((r) => r.permlevel));
  }

  static empty(): DocTypePermissions {
    return { ...NO_PERMISSIONS };
  }
}
