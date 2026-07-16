import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import type { UserContext } from "../../core/permissions/permission.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** JS getUTCDay indices for each weekly-off setting. */
const WEEKLY_OFF_DAYS: Record<string, number[]> = {
  None: [],
  Saturday: [6],
  Sunday: [0],
  "Saturday & Sunday": [6, 0],
};

/**
 * Holiday List: a dated calendar of non-working days. Weekly-offs can be
 * auto-populated for the configured weekend, and the working-day count for any
 * range is the calendar days minus the list's holidays. Pure SQL / generic CRUD,
 * no cross-module service imports.
 */
@Injectable()
export class HolidayListService {
  private readonly logger = new Logger(HolidayListService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private static isoDay(value: unknown): string {
    return new Date(value as string).toISOString().slice(0, 10);
  }

  /** Keep total_holidays in step with the grid on every save. */
  @OnEvent("doc.before_save:Holiday List")
  onSave(payload: BeforeSavePayload): void {
    const rows = (payload.data.holidays as unknown[]) ?? [];
    payload.data.total_holidays = Array.isArray(rows) ? rows.length : 0;
  }

  /** Insert a Holiday for each weekly-off weekday between the list's dates. */
  async populateWeeklyOffs(name: string, ctx?: UserContext): Promise<{ holiday_list: string; added: number; total: number }> {
    const dt = this.registry.get("Holiday List");
    if (!dt) throw new BadRequestException("Holiday List not registered");
    const list = await this.documents.get(dt, name);
    const days = WEEKLY_OFF_DAYS[String(list.weekly_off ?? "None")] ?? [];
    if (days.length === 0) throw new BadRequestException(`Holiday List ${name} has no weekly off configured`);
    if (!list.from_date || !list.to_date) throw new BadRequestException("From and To dates are required");
    const from = new Date(HolidayListService.isoDay(list.from_date));
    const to = new Date(HolidayListService.isoDay(list.to_date));
    if (from > to) throw new BadRequestException("From Date cannot be after To Date");

    const existing = (list.holidays as Array<Record<string, unknown>>) ?? [];
    const seen = new Set(existing.map((h) => HolidayListService.isoDay(h.holiday_date)));
    const holidays = [...existing];
    let added = 0;
    for (let d = from.getTime(); d <= to.getTime(); d += 86_400_000) {
      const day = new Date(d);
      if (!days.includes(day.getUTCDay())) continue;
      const iso = day.toISOString().slice(0, 10);
      if (seen.has(iso)) continue;
      seen.add(iso);
      holidays.push({ holiday_date: iso, description: "Weekly Off" });
      added += 1;
    }
    await this.documents.update(dt, ctx ?? systemContext(), name, { holidays });
    this.logger.log(`Holiday List ${name}: added ${added} weekly-off holiday(s)`);
    return { holiday_list: name, added, total: holidays.length };
  }

  /** Working days in [from, to] = calendar days minus the list's holidays in range. */
  async workingDays(name: string, fromDate: string, toDate: string): Promise<{ total_days: number; holidays: number; working_days: number }> {
    if (!fromDate || !toDate) throw new BadRequestException("From and To dates are required");
    if (new Date(fromDate) > new Date(toDate)) throw new BadRequestException("From Date cannot be after To Date");
    const from = new Date(HolidayListService.isoDay(fromDate));
    const to = new Date(HolidayListService.isoDay(toDate));
    const totalDays = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;

    let holidays = 0;
    if (this.registry.has("Holiday")) {
      const row = (
        await this.dataSource.query(
          `SELECT count(*) AS c FROM ${quoteIdent(tableNameFor("Holiday"))}
           WHERE ${quoteIdent("parent")} = $1
             AND ${quoteIdent("holiday_date")} >= $2 AND ${quoteIdent("holiday_date")} <= $3`,
          [name, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
        )
      )[0];
      holidays = Number(row?.c ?? 0);
    }
    return { total_days: totalDays, holidays, working_days: totalDays - holidays };
  }
}
