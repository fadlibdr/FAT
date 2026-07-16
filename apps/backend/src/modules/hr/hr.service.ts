import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import type { UserContext } from "../../core/permissions/permission.service";
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
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Foreclose (early-settle) a disbursed employee loan. The remaining principal
   * (loan amount − principal already repaid) is collected in one payment —
   * Dr the disbursed-from account (cash in) / Cr the loan asset — and the loan is
   * marked fully repaid and Closed. Only a Disbursed loan with a positive balance
   * can be foreclosed. Reuses the generic DocumentService; HR imports no other
   * module's services.
   */
  async forecloseLoan(
    loanName: string,
    settlementDate?: string,
    ctx?: UserContext,
  ): Promise<{ outstanding: number; status: string }> {
    const loanDt = this.registry.get("Loan");
    const glDt = this.registry.get("GL Entry");
    if (!loanDt) throw new BadRequestException("Loan not registered");
    const context = ctx ?? systemContext();
    const loan = await this.documents.get(loanDt, loanName);
    if (String(loan.status) !== "Disbursed") {
      throw new BadRequestException(`Loan ${loanName} is ${loan.status}, not Disbursed — cannot foreclose`);
    }
    const outstanding = Math.round((Number(loan.loan_amount ?? 0) - Number(loan.repaid_principal ?? 0)) * 100) / 100;
    if (outstanding <= 0) {
      throw new BadRequestException(`Loan ${loanName} has no outstanding principal to foreclose`);
    }
    const loanAccount = String(loan.loan_account || "Employee Loan");
    const cash = String(loan.disbursed_from || "Cash");
    const postingDate = settlementDate ?? new Date().toISOString().slice(0, 10);
    if (glDt) {
      await this.documents.create(glDt, context, {
        posting_date: postingDate, voucher_type: "Loan Foreclosure", voucher_no: loanName,
        account: cash, debit: outstanding, credit: 0, against: String(loan.employee ?? ""),
      });
      await this.documents.create(glDt, context, {
        posting_date: postingDate, voucher_type: "Loan Foreclosure", voucher_no: loanName,
        account: loanAccount, debit: 0, credit: outstanding, against: String(loan.employee ?? ""),
      });
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Loan"))}
       SET ${quoteIdent("repaid_principal")} = ${quoteIdent("loan_amount")}, ${quoteIdent("status")} = 'Closed'
       WHERE ${quoteIdent("name")} = $1`,
      [loanName],
    );
    return { outstanding, status: "Closed" };
  }

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

  /** UTC YYYY-MM-DD for a date value (Date columns deserialize as Date objects). */
  private isoDay(value: unknown): string {
    const d = value instanceof Date ? value : new Date(String(value));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  /**
   * Approve an Attendance Request (regularization): create one Attendance record
   * per day in the requested range with the requested status, linked back to the
   * request, then mark it Approved. Refuses a non-Draft request, an inverted date
   * range, or any day that already has an Attendance for the employee.
   */
  async approveAttendanceRequest(name: string, ctx?: UserContext): Promise<{ request: string; created: string[] }> {
    const reqDt = this.registry.get("Attendance Request");
    const attDt = this.registry.get("Attendance");
    if (!reqDt || !attDt) throw new BadRequestException("Attendance Request / Attendance not registered");
    const context = ctx ?? systemContext();
    const req = await this.documents.get(reqDt, name);
    if (String(req.request_status ?? "Draft") !== "Draft") {
      throw new BadRequestException(`Attendance Request ${name} is not Draft (is ${req.request_status})`);
    }
    const employee = String(req.employee ?? "");
    const from = this.isoDay(req.from_date);
    const to = this.isoDay(req.to_date);
    if (to < from) throw new BadRequestException("To Date cannot be before From Date");
    const status = String(req.attendance_status ?? "Present");

    // Enumerate days in the inclusive range and refuse any that already have attendance.
    const days: string[] = [];
    for (let d = new Date(from + "T00:00:00Z"); this.isoDay(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(this.isoDay(d));
    }
    for (const day of days) {
      const clash = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("name")} AS n FROM ${quoteIdent(tableNameFor("Attendance"))}
           WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("attendance_date")} = $2 LIMIT 1`,
          [employee, day],
        )
      )[0];
      if (clash) {
        throw new BadRequestException(`Attendance already exists for ${employee} on ${day} (${clash.n})`);
      }
    }

    const created: string[] = [];
    for (const day of days) {
      const att = await this.documents.create(attDt, context, {
        employee,
        attendance_date: day,
        status,
        attendance_request: name,
      });
      created.push(String(att.name));
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Attendance Request"))} SET ${quoteIdent("request_status")} = 'Approved'
       WHERE ${quoteIdent("name")} = $1`,
      [name],
    );
    return { request: name, created };
  }

  /** Reject a Draft Attendance Request. */
  async rejectAttendanceRequest(name: string): Promise<{ request: string; request_status: string }> {
    const reqDt = this.registry.get("Attendance Request");
    if (!reqDt) throw new BadRequestException("Attendance Request not registered");
    const req = await this.documents.get(reqDt, name);
    if (String(req.request_status ?? "Draft") !== "Draft") {
      throw new BadRequestException(`Attendance Request ${name} is not Draft (is ${req.request_status})`);
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Attendance Request"))} SET ${quoteIdent("request_status")} = 'Rejected'
       WHERE ${quoteIdent("name")} = $1`,
      [name],
    );
    return { request: name, request_status: "Rejected" };
  }
}
