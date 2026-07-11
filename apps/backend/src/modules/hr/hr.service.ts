import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

export interface LeaveBalance {
  leave_type: string;
  allocated: number;
  used: number;
  balance: number;
}

/**
 * HR calculations shared by the listener and controller. Leave balance is
 * derived on the fly from submitted documents — allocated (sum of submitted
 * Leave Allocations) minus used (sum of submitted Leave Applications' days) —
 * so there is no separate ledger to keep in sync. All reads go through SQL over
 * the engine's tables; HR imports no other module's services.
 */
@Injectable()
export class HrService {
  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Inclusive whole-day count between two dates (from and to both counted). */
  static leaveDays(from: unknown, to: unknown): number {
    if (!from || !to) return 0;
    const f = new Date(from as string);
    const t = new Date(to as string);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return 0;
    const days = Math.floor((t.getTime() - f.getTime()) / 86_400_000) + 1;
    return days > 0 ? days : 0;
  }

  /** Balance for one leave type (allocated − used) for an employee. */
  async balanceFor(employee: string, leaveType: string): Promise<number> {
    const allocated = await this.sum("Leave Allocation", "new_leaves_allocated", employee, leaveType);
    const used = await this.sum("Leave Application", "total_leave_days", employee, leaveType);
    return allocated - used;
  }

  /** Per-leave-type balances for an employee (union of allocated + used types). */
  async balances(employee: string): Promise<LeaveBalance[]> {
    if (!this.registry.has("Leave Allocation") || !this.registry.has("Leave Application")) return [];
    const alloc = await this.dataSource.query(
      `SELECT ${quoteIdent("leave_type")} AS t, coalesce(sum(${quoteIdent("new_leaves_allocated")}),0) AS s
       FROM ${quoteIdent(tableNameFor("Leave Allocation"))}
       WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("docstatus")} = 1
       GROUP BY ${quoteIdent("leave_type")}`,
      [employee],
    );
    const used = await this.dataSource.query(
      `SELECT ${quoteIdent("leave_type")} AS t, coalesce(sum(${quoteIdent("total_leave_days")}),0) AS s
       FROM ${quoteIdent(tableNameFor("Leave Application"))}
       WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("docstatus")} = 1
       GROUP BY ${quoteIdent("leave_type")}`,
      [employee],
    );
    const map = new Map<string, LeaveBalance>();
    for (const r of alloc) {
      map.set(String(r.t), { leave_type: String(r.t), allocated: Number(r.s), used: 0, balance: Number(r.s) });
    }
    for (const r of used) {
      const key = String(r.t);
      const row = map.get(key) ?? { leave_type: key, allocated: 0, used: 0, balance: 0 };
      row.used = Number(r.s);
      row.balance = row.allocated - row.used;
      map.set(key, row);
    }
    return [...map.values()];
  }

  private async sum(
    doctype: string,
    field: string,
    employee: string,
    leaveType: string,
  ): Promise<number> {
    if (!this.registry.has(doctype)) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent(field)}),0) AS s
         FROM ${quoteIdent(tableNameFor(doctype))}
         WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("leave_type")} = $2
           AND ${quoteIdent("docstatus")} = 1`,
        [employee, leaveType],
      )
    )[0];
    return Number(row?.s ?? 0);
  }
}
