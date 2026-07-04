import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { FieldType, CHILD_STANDARD_COLUMNS } from "@fat/shared";
import { hasColumn, pgTypeFor } from "../field-types/field-type.registry";
import type { LoadedDocType } from "./doctype-registry.service";

/** Physical table name for a DocType, Frappe-style: `tab<Name>`. */
export function tableNameFor(doctype: string): string {
  return `tab${doctype}`;
}

/** Quote a Postgres identifier safely (fieldnames are validated snake_case, but
 * DocType names may contain spaces — always quote and escape). */
export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

interface ColumnDef {
  name: string;
  type: string;
}

/**
 * Reconciles a DocType's metadata into a physical Postgres table.
 *
 * Safety rules (flagged risk — runtime DDL):
 *  - Additive only: creates the table or ADDs missing columns.
 *  - Never drops or renames columns automatically (no data loss).
 *  - Runs inside a transaction via a QueryRunner.
 *  - Idempotent: safe to run on every boot.
 */
@Injectable()
export class SchemaSyncService {
  private readonly logger = new Logger(SchemaSyncService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private standardColumns(dt: LoadedDocType): ColumnDef[] {
    const cols: ColumnDef[] = [
      { name: "name", type: "varchar(140)" },
      { name: "owner", type: "varchar(140)" },
      { name: "creation", type: "timestamptz" },
      { name: "modified", type: "timestamptz" },
      { name: "modified_by", type: "varchar(140)" },
      { name: "docstatus", type: "smallint" },
      { name: "idx", type: "integer" },
    ];
    if (dt.istable) {
      for (const c of CHILD_STANDARD_COLUMNS) {
        cols.push({ name: c, type: "varchar(140)" });
      }
    }
    return cols;
  }

  private dataColumns(dt: LoadedDocType): ColumnDef[] {
    const cols: ColumnDef[] = [];
    for (const f of dt.fields) {
      const ft = f.fieldtype as FieldType;
      if (!hasColumn(ft)) continue;
      const type = pgTypeFor(ft);
      if (!type) continue;
      cols.push({ name: f.fieldname, type });
    }
    return cols;
  }

  /** Column names that already exist on the table, or null if the table is absent. */
  private async existingColumns(table: string): Promise<Set<string> | null> {
    const rows: Array<{ column_name: string }> = await this.dataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1`,
      [table],
    );
    if (rows.length === 0) {
      const tbl: Array<{ c: number }> = await this.dataSource.query(
        `SELECT count(*)::int AS c FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = $1`,
        [table],
      );
      if (tbl[0].c === 0) return null;
    }
    return new Set(rows.map((r) => r.column_name));
  }

  async syncDocType(dt: LoadedDocType): Promise<void> {
    const table = tableNameFor(dt.name);
    const desired = [...this.standardColumns(dt), ...this.dataColumns(dt)];
    const existing = await this.existingColumns(table);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      if (existing === null) {
        const colSql = desired
          .map((c) => `${quoteIdent(c.name)} ${c.type}`)
          .join(", ");
        await qr.query(
          `CREATE TABLE ${quoteIdent(table)} (${colSql}, PRIMARY KEY (${quoteIdent("name")}))`,
        );
        this.logger.log(`Created table ${table} (${desired.length} columns)`);
      } else {
        for (const c of desired) {
          if (!existing.has(c.name)) {
            await qr.query(
              `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(c.name)} ${c.type}`,
            );
            this.logger.log(`Added column ${table}.${c.name} ${c.type}`);
          }
        }
      }

      // Helpful indexes (best-effort, additive).
      if (dt.istable) {
        await qr.query(
          `CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${table}_parent`)}
           ON ${quoteIdent(table)} (${quoteIdent("parent")})`,
        );
      }
      for (const f of dt.fields) {
        const ft = f.fieldtype as FieldType;
        if (!hasColumn(ft)) continue;
        if (f.unique) {
          await qr.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`uq_${table}_${f.fieldname}`)}
             ON ${quoteIdent(table)} (${quoteIdent(f.fieldname)})`,
          );
        } else if (f.in_standard_filter || ft === FieldType.Link) {
          await qr.query(
            `CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${table}_${f.fieldname}`)}
             ON ${quoteIdent(table)} (${quoteIdent(f.fieldname)})`,
          );
        }
      }

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      this.logger.error(`Schema sync failed for ${dt.name}: ${(err as Error).message}`);
      throw err;
    } finally {
      await qr.release();
    }
  }
}
