import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../doctype/schema-sync.service";
import { NotificationService } from "../notifications/notification.service";

/**
 * Cron-scheduled background tasks. `checkOverdueInvoices` runs hourly and also
 * exposed via `runNow()` (POST /api/admin/run-scheduled) for on-demand runs.
 */
@Injectable()
export class ScheduledTasksService {
  private readonly logger = new Logger(ScheduledTasksService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: DoctypeRegistryService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async scheduled(): Promise<void> {
    const n = await this.checkOverdueInvoices();
    this.logger.log(`Scheduled sweep: ${n} overdue invoice notification(s)`);
  }

  async runNow(): Promise<{ processed: number }> {
    return { processed: await this.checkOverdueInvoices() };
  }

  /** Notify owners of Unpaid Sales Invoices whose due date has passed. */
  async checkOverdueInvoices(): Promise<number> {
    if (!this.registry.has("Sales Invoice")) return 0;
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("owner")} AS owner
       FROM ${quoteIdent(tableNameFor("Sales Invoice"))}
       WHERE ${quoteIdent("status")} = 'Unpaid'
         AND ${quoteIdent("due_date")} IS NOT NULL
         AND ${quoteIdent("due_date")} < current_date`,
    );
    for (const r of rows) {
      await this.notifications.notify({
        user: r.owner,
        subject: `Invoice ${r.name} is overdue`,
        message: `Sales Invoice ${r.name} is unpaid and past its due date.`,
        ref_doctype: "Sales Invoice",
        ref_name: r.name,
      });
    }
    return rows.length;
  }
}
