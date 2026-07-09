import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, QueryRunner } from "typeorm";
import { FieldType, STANDARD_COLUMNS, type FatDocument } from "@fat/shared";
import { getFieldTypeHandler, hasColumn } from "../field-types/field-type.registry";
import { DoctypeRegistryService, LoadedDocType } from "./doctype-registry.service";
import { tableNameFor, quoteIdent } from "./schema-sync.service";
import { NamingService } from "./naming.service";
import { ValidationService } from "./validation.service";
import { HooksService } from "./hooks.service";
import { PermissionService } from "../permissions/permission.service";
import type { UserContext } from "../permissions/permission.service";

export interface ListOptions {
  fields?: string[];
  filters?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: "ASC" | "DESC";
}

export interface ReportOptions {
  groupBy: string;
  aggregate?: "count" | "sum";
  aggregateField?: string;
  filters?: Record<string, unknown>;
}

export interface ReportRow {
  group: string | null;
  value: number;
}

@Injectable()
export class DocumentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: DoctypeRegistryService,
    private readonly naming: NamingService,
    private readonly validation: ValidationService,
    private readonly hooks: HooksService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Row-level restrictions for a list query, derived from the user's User
   * Permissions: restrict this DocType's own `name`, and any Link field that
   * targets a restricted DocType, to the allowed values.
   */
  private rowFilters(
    dt: LoadedDocType,
    permMap: Map<string, Set<string>>,
  ): Array<{ column: string; values: string[] }> {
    const filters: Array<{ column: string; values: string[] }> = [];
    if (permMap.size === 0) return filters;
    if (permMap.has(dt.name)) {
      filters.push({ column: "name", values: [...permMap.get(dt.name)!] });
    }
    for (const f of dt.fields) {
      if ((f.fieldtype as FieldType) !== FieldType.Link || !f.options) continue;
      if (permMap.has(f.options)) {
        filters.push({ column: f.fieldname, values: [...permMap.get(f.options)!] });
      }
    }
    return filters;
  }

  /** True if a single document satisfies the user's row-level restrictions. */
  async canAccessRow(
    dt: LoadedDocType,
    ctx: UserContext,
    doc: FatDocument,
  ): Promise<boolean> {
    const permMap = await this.permissions.getUserPermissionMap(ctx);
    for (const { column, values } of this.rowFilters(dt, permMap)) {
      const value = column === "name" ? doc.name : (doc[column] as string | null);
      if (value === null || value === undefined || !values.includes(String(value))) {
        return false;
      }
    }
    if (await this.permissions.isOwnerOnly(ctx, dt.name)) {
      if (doc.owner !== ctx.name) return false;
    }
    return true;
  }

  // ---- column helpers (all identifiers come from validated metadata) ----

  private dataFields(dt: LoadedDocType) {
    return dt.fields.filter((f) => hasColumn(f.fieldtype as FieldType));
  }

  private childFields(dt: LoadedDocType) {
    return dt.fields.filter((f) => (f.fieldtype as FieldType) === FieldType.Table);
  }

  private validColumns(dt: LoadedDocType): Set<string> {
    const cols = new Set<string>(STANDARD_COLUMNS as readonly string[]);
    if (dt.istable) ["parent", "parenttype", "parentfield"].forEach((c) => cols.add(c));
    for (const f of this.dataFields(dt)) cols.add(f.fieldname);
    return cols;
  }

  // ---- read ----

  async list(
    dt: LoadedDocType,
    ctx: UserContext,
    opts: ListOptions,
  ): Promise<FatDocument[]> {
    const table = tableNameFor(dt.name);
    const valid = this.validColumns(dt);

    const selectCols = [...valid].map((c) => quoteIdent(c)).join(", ");

    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.filters) {
      for (const [k, v] of Object.entries(opts.filters)) {
        if (!valid.has(k)) continue;
        params.push(v);
        where.push(`${quoteIdent(k)} = $${params.length}`);
      }
    }

    // Apply row-level User Permission restrictions.
    const permMap = await this.permissions.getUserPermissionMap(ctx);
    for (const { column, values } of this.rowFilters(dt, permMap)) {
      if (!valid.has(column)) continue;
      const placeholders = values.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      where.push(`${quoteIdent(column)} IN (${placeholders.join(", ")})`);
    }

    // if_owner: restrict to documents owned by the user.
    if (await this.permissions.isOwnerOnly(ctx, dt.name)) {
      params.push(ctx.name);
      where.push(`${quoteIdent("owner")} = $${params.length}`);
    }

    const orderBy = opts.orderBy && valid.has(opts.orderBy) ? opts.orderBy : "modified";
    const orderDir = opts.orderDir === "ASC" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);

    const sql =
      `SELECT ${selectCols} FROM ${quoteIdent(table)}` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY ${quoteIdent(orderBy)} ${orderDir} NULLS LAST` +
      ` LIMIT ${limit} OFFSET ${offset}`;

    return this.dataSource.query(sql, params);
  }

  /**
   * Grouped aggregation report: count of rows (or sum of a numeric field) per
   * distinct value of `groupBy`. Honours user filters and row-level permissions.
   */
  async report(
    dt: LoadedDocType,
    ctx: UserContext,
    opts: ReportOptions,
  ): Promise<ReportRow[]> {
    const valid = this.validColumns(dt);
    if (!valid.has(opts.groupBy)) {
      throw new BadRequestException(`Unknown group-by field: ${opts.groupBy}`);
    }

    let agg = "count(*)";
    if (opts.aggregate === "sum") {
      if (!opts.aggregateField || !valid.has(opts.aggregateField)) {
        throw new BadRequestException("sum requires a valid aggregate field");
      }
      agg = `coalesce(sum(${quoteIdent(opts.aggregateField)}), 0)`;
    }

    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.filters) {
      for (const [k, v] of Object.entries(opts.filters)) {
        if (!valid.has(k)) continue;
        params.push(v);
        where.push(`${quoteIdent(k)} = $${params.length}`);
      }
    }
    const permMap = await this.permissions.getUserPermissionMap(ctx);
    for (const { column, values } of this.rowFilters(dt, permMap)) {
      if (!valid.has(column)) continue;
      const ph = values.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      where.push(`${quoteIdent(column)} IN (${ph.join(", ")})`);
    }

    const sql =
      `SELECT ${quoteIdent(opts.groupBy)} AS "group", ${agg}::float8 AS "value" ` +
      `FROM ${quoteIdent(tableNameFor(dt.name))}` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` GROUP BY ${quoteIdent(opts.groupBy)} ORDER BY "value" DESC`;
    const rows: Array<{ group: string | null; value: number }> = await this.dataSource.query(
      sql,
      params,
    );
    return rows.map((r) => ({ group: r.group, value: Number(r.value) }));
  }

  async get(dt: LoadedDocType, name: string): Promise<FatDocument> {
    const table = tableNameFor(dt.name);
    const rows: FatDocument[] = await this.dataSource.query(
      `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("name")} = $1`,
      [name],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`${dt.name} ${name} not found`);
    }
    const doc = rows[0];
    // Attach child tables.
    for (const cf of this.childFields(dt)) {
      const childName = cf.options;
      if (!childName || !this.registry.has(childName)) continue;
      const childTable = tableNameFor(childName);
      doc[cf.fieldname] = await this.dataSource.query(
        `SELECT * FROM ${quoteIdent(childTable)}
         WHERE ${quoteIdent("parent")} = $1 AND ${quoteIdent("parentfield")} = $2
         ORDER BY ${quoteIdent("idx")} ASC`,
        [name, cf.fieldname],
      );
    }
    return doc;
  }

  // ---- write ----

  private buildRow(
    dt: LoadedDocType,
    data: Record<string, unknown>,
  ): { cols: string[]; vals: unknown[] } {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const f of this.dataFields(dt)) {
      if (!Object.prototype.hasOwnProperty.call(data, f.fieldname)) continue;
      const handler = getFieldTypeHandler(f.fieldtype as FieldType);
      if (!handler) continue;
      cols.push(f.fieldname);
      vals.push(handler.toColumn(data[f.fieldname]));
    }
    return { cols, vals };
  }

  private async validateLinks(
    dt: LoadedDocType,
    data: Record<string, unknown>,
  ): Promise<void> {
    for (const f of dt.fields) {
      if ((f.fieldtype as FieldType) !== FieldType.Link) continue;
      const target = f.options;
      const value = data[f.fieldname];
      if (!target || value === undefined || value === null || value === "") continue;
      if (!this.registry.has(target)) continue;
      const rows = await this.dataSource.query(
        `SELECT 1 FROM ${quoteIdent(tableNameFor(target))} WHERE ${quoteIdent("name")} = $1 LIMIT 1`,
        [String(value)],
      );
      if (rows.length === 0) {
        throw new BadRequestException(
          `${f.label ?? f.fieldname}: '${String(value)}' does not exist in ${target}`,
        );
      }
    }
  }

  private async writeChildren(
    qr: QueryRunner,
    dt: LoadedDocType,
    parentName: string,
    data: Record<string, unknown>,
    replace: boolean,
  ): Promise<void> {
    for (const cf of this.childFields(dt)) {
      const childName = cf.options;
      if (!childName || !this.registry.has(childName)) continue;
      const childDt = this.registry.getOrThrow(childName);
      const childTable = tableNameFor(childName);

      if (!Object.prototype.hasOwnProperty.call(data, cf.fieldname) && !replace) {
        continue;
      }
      if (replace) {
        await qr.query(
          `DELETE FROM ${quoteIdent(childTable)}
           WHERE ${quoteIdent("parent")} = $1 AND ${quoteIdent("parentfield")} = $2`,
          [parentName, cf.fieldname],
        );
      }
      const rows = (data[cf.fieldname] as Array<Record<string, unknown>>) ?? [];
      let idx = 0;
      for (const row of rows) {
        idx += 1;
        const built = this.buildRow(childDt, row);
        const now = new Date().toISOString();
        const cols = [
          "name",
          "parent",
          "parenttype",
          "parentfield",
          "idx",
          "owner",
          "creation",
          "modified",
          "modified_by",
          "docstatus",
          ...built.cols,
        ];
        const vals = [
          `${parentName}-${cf.fieldname}-${idx}`,
          parentName,
          dt.name,
          cf.fieldname,
          idx,
          parentName,
          now,
          now,
          parentName,
          0,
          ...built.vals,
        ];
        const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
        await qr.query(
          `INSERT INTO ${quoteIdent(childTable)} (${cols.map(quoteIdent).join(", ")})
           VALUES (${placeholders})`,
          vals,
        );
      }
    }
  }

  async create(
    dt: LoadedDocType,
    ctx: UserContext,
    data: Record<string, unknown>,
  ): Promise<FatDocument> {
    await this.hooks.applyBeforeSave({ doctype: dt.name, data, user: ctx.name, isNew: true });
    this.validation.validate(dt, data, true);
    await this.validateLinks(dt, data);

    const name = await this.naming.generateName(dt, data);
    const now = new Date().toISOString();
    const { cols, vals } = this.buildRow(dt, data);

    const allCols = ["name", "owner", "creation", "modified", "modified_by", "docstatus", "idx", ...cols];
    const allVals = [name, ctx.name, now, now, ctx.name, 0, 0, ...vals];
    const placeholders = allVals.map((_, i) => `$${i + 1}`).join(", ");

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `INSERT INTO ${quoteIdent(tableNameFor(dt.name))} (${allCols.map(quoteIdent).join(", ")})
         VALUES (${placeholders})`,
        allVals,
      );
      await this.writeChildren(qr, dt, name, data, false);
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException(`${dt.name} '${name}' already exists`);
      }
      throw err;
    } finally {
      await qr.release();
    }

    const doc = await this.get(dt, name);
    this.hooks.emit("after_insert", { doctype: dt.name, doc, user: ctx.name });
    return doc;
  }

  async update(
    dt: LoadedDocType,
    ctx: UserContext,
    name: string,
    data: Record<string, unknown>,
  ): Promise<FatDocument> {
    const existing = await this.get(dt, name);
    if ((existing.docstatus ?? 0) === 1 && !dt.is_submittable) {
      // no-op guard; submittable handled below
    }
    if ((existing.docstatus ?? 0) === 1) {
      throw new BadRequestException(`Cannot edit a submitted ${dt.name}`);
    }

    await this.hooks.applyBeforeSave({ doctype: dt.name, data, user: ctx.name, isNew: false });
    this.validation.validate(dt, data, false);
    await this.validateLinks(dt, data);

    const now = new Date().toISOString();
    const { cols, vals } = this.buildRow(dt, data);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const setCols = ["modified", "modified_by", ...cols];
      const setVals = [now, ctx.name, ...vals];
      const setSql = setCols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
      setVals.push(name);
      await qr.query(
        `UPDATE ${quoteIdent(tableNameFor(dt.name))} SET ${setSql}
         WHERE ${quoteIdent("name")} = $${setVals.length}`,
        setVals,
      );
      await this.writeChildren(qr, dt, name, data, true);
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }

    const doc = await this.get(dt, name);
    this.hooks.emit("after_update", { doctype: dt.name, doc, user: ctx.name });
    return doc;
  }

  async remove(dt: LoadedDocType, ctx: UserContext, name: string): Promise<void> {
    const doc = await this.get(dt, name);
    await this.assertNoInboundLinks(dt, name);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      for (const cf of this.childFields(dt)) {
        const childName = cf.options;
        if (!childName || !this.registry.has(childName)) continue;
        await qr.query(
          `DELETE FROM ${quoteIdent(tableNameFor(childName))}
           WHERE ${quoteIdent("parent")} = $1 AND ${quoteIdent("parentfield")} = $2`,
          [name, cf.fieldname],
        );
      }
      await qr.query(
        `DELETE FROM ${quoteIdent(tableNameFor(dt.name))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      );
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
    this.hooks.emit("after_delete", { doctype: dt.name, doc, user: ctx.name });
  }

  /** Block deletes when other documents Link to this record (Frappe behaviour). */
  private async assertNoInboundLinks(dt: LoadedDocType, name: string): Promise<void> {
    for (const other of this.registry.list()) {
      for (const f of other.fields) {
        if ((f.fieldtype as FieldType) !== FieldType.Link) continue;
        if (f.options !== dt.name) continue;
        const rows = await this.dataSource.query(
          `SELECT ${quoteIdent("name")} FROM ${quoteIdent(tableNameFor(other.name))}
           WHERE ${quoteIdent(f.fieldname)} = $1 LIMIT 1`,
          [name],
        );
        if (rows.length > 0) {
          throw new ConflictException(
            `Cannot delete ${dt.name} ${name}: linked with ${other.name} ${rows[0].name}`,
          );
        }
      }
    }
  }

  // ---- submit / cancel ----

  async setDocStatus(
    dt: LoadedDocType,
    ctx: UserContext,
    name: string,
    docstatus: 1 | 2,
  ): Promise<FatDocument> {
    if (!dt.is_submittable) {
      throw new BadRequestException(`${dt.name} is not submittable`);
    }
    const doc = await this.get(dt, name);
    const current = doc.docstatus ?? 0;
    if (docstatus === 1 && current !== 0) {
      throw new BadRequestException(`${dt.name} ${name} is not in draft`);
    }
    if (docstatus === 2 && current !== 1) {
      throw new BadRequestException(`${dt.name} ${name} is not submitted`);
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(dt.name))}
       SET ${quoteIdent("docstatus")} = $1, ${quoteIdent("modified")} = $2, ${quoteIdent("modified_by")} = $3
       WHERE ${quoteIdent("name")} = $4`,
      [docstatus, new Date().toISOString(), ctx.name, name],
    );
    const updated = await this.get(dt, name);
    this.hooks.emit(docstatus === 1 ? "on_submit" : "on_cancel", {
      doctype: dt.name,
      doc: updated,
      user: ctx.name,
    });
    return updated;
  }
}
