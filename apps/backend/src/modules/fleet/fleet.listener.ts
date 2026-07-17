import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Fleet running-cost tracking. Pure event-bus listener, no cross-module imports:
 *
 *  1. before_save on a Vehicle Log derives fuel_cost = fuel_qty × fuel_rate.
 *  2. before_submit gates the odometer to be monotonic (>= the vehicle's current
 *     reading) — you cannot log a reading that goes backwards.
 *  3. on_submit rolls the log's fuel/service cost and odometer onto the Vehicle;
 *     on_cancel unwinds the cost rollup.
 *  4. Preventive maintenance: a log flagged `is_service` must carry a positive
 *     service cost, and submitting it re-arms the vehicle's next-service odometer
 *     to `odometer + service_interval` (a fresh service resets the due point).
 */
@Injectable()
export class FleetListener {
  private readonly logger = new Logger(FleetListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Vehicle Log")
  onLogSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    const qty = Number(d.fuel_qty ?? 0);
    const rate = Number(d.fuel_rate ?? 0);
    if (qty && rate) d.fuel_cost = Math.round((qty * rate + Number.EPSILON) * 100) / 100;
  }

  private async vehicle(name: string): Promise<{ odo: number; interval: number } | undefined> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("last_odometer")} AS odo, ${quoteIdent("service_interval")} AS interval
         FROM ${quoteIdent(tableNameFor("Vehicle"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    return row ? { odo: Number(row.odo ?? 0), interval: Number(row.interval ?? 0) } : undefined;
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Vehicle Log", { suppressErrors: false })
  async gateOdometer(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    // A service log must record what the service cost.
    if (Number(doc.is_service ?? 0) === 1 && Number(doc.service_cost ?? 0) <= 0) {
      throw new BadRequestException(
        `Vehicle Log ${doc.name}: a service log requires a positive service cost`,
      );
    }
    const v = await this.vehicle(String(doc.vehicle ?? ""));
    if (!v) return;
    const odo = Number(doc.odometer ?? 0);
    if (odo < v.odo) {
      throw new BadRequestException(
        `Vehicle Log ${doc.name}: odometer ${odo} is below the vehicle's current reading ${v.odo}`,
      );
    }
  }

  @OnEvent("doc.on_submit:Vehicle Log")
  async onLogSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const fuel = Number(doc.fuel_cost ?? 0);
    const service = Number(doc.service_cost ?? 0);
    const odo = Number(doc.odometer ?? 0);
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Vehicle"))}
       SET ${quoteIdent("total_fuel_cost")} = coalesce(${quoteIdent("total_fuel_cost")}, 0) + $1,
           ${quoteIdent("total_service_cost")} = coalesce(${quoteIdent("total_service_cost")}, 0) + $2,
           ${quoteIdent("last_odometer")} = greatest(coalesce(${quoteIdent("last_odometer")}, 0), $3)
       WHERE ${quoteIdent("name")} = $4`,
      [fuel, service, odo, String(doc.vehicle ?? "")],
    );
    // A performed service re-arms the next-service odometer from this reading.
    if (Number(doc.is_service ?? 0) === 1) {
      const v = await this.vehicle(String(doc.vehicle ?? ""));
      if (v && v.interval > 0) {
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Vehicle"))}
           SET ${quoteIdent("next_service_odometer")} = $1 WHERE ${quoteIdent("name")} = $2`,
          [odo + v.interval, String(doc.vehicle ?? "")],
        );
        this.logger.log(`Vehicle ${doc.vehicle}: serviced at ${odo}, next service due at ${odo + v.interval}`);
      }
    }
    this.logger.log(`Vehicle Log ${doc.name}: +fuel ${fuel} +service ${service}, odo ${odo}`);
  }

  @OnEvent("doc.on_cancel:Vehicle Log")
  async onLogCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const fuel = Number(doc.fuel_cost ?? 0);
    const service = Number(doc.service_cost ?? 0);
    // Unwind the cost rollup; last_odometer is left as-is (readings don't roll back).
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Vehicle"))}
       SET ${quoteIdent("total_fuel_cost")} = coalesce(${quoteIdent("total_fuel_cost")}, 0) - $1,
           ${quoteIdent("total_service_cost")} = coalesce(${quoteIdent("total_service_cost")}, 0) - $2
       WHERE ${quoteIdent("name")} = $3`,
      [fuel, service, String(doc.vehicle ?? "")],
    );
  }
}
