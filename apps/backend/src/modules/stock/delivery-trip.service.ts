import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * A Delivery Trip dispatches an own-fleet driver + vehicle along a route of
 * stops, one per submitted Delivery Note. Distinct from a Shipment (a carrier
 * consignment): a trip carries a dispatch lifecycle — Scheduled on submit, then
 * In Transit (dispatch) and Completed (which marks every stop delivered). A
 * before_submit gate keeps a note from riding on two trips. Pure use of the
 * generic DocumentService over sibling tables; no cross-module service imports.
 */
@Injectable()
export class DeliveryTripService {
  private readonly logger = new Logger(DeliveryTripService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Build a draft Delivery Trip from a set of submitted Delivery Notes, one stop
   * per note (pulling the note's customer), assigning the given driver + vehicle.
   */
  async makeFromDeliveryNotes(
    notes: string[],
    driver: string,
    vehicle: string,
    ctx?: UserContext,
  ): Promise<string> {
    const dnDt = this.registry.get("Delivery Note");
    const tripDt = this.registry.get("Delivery Trip");
    if (!dnDt || !tripDt) throw new BadRequestException("Delivery Note / Delivery Trip not registered");
    const context = ctx ?? systemContext();
    const unique = [...new Set((notes ?? []).filter(Boolean).map(String))];
    if (unique.length === 0) throw new BadRequestException("At least one Delivery Note is required");

    const stops: Array<Record<string, unknown>> = [];
    let seq = 0;
    for (const dn of unique) {
      const note = await this.documents.get(dnDt, dn);
      if ((note.docstatus ?? 0) !== 1) throw new BadRequestException(`Delivery Note ${dn} must be submitted`);
      if (Boolean(note.is_return)) throw new BadRequestException(`Delivery Note ${dn} is a return`);
      stops.push({ delivery_note: dn, customer: note.customer ?? null, sequence: ++seq, delivered: 0 });
    }
    const trip = await this.documents.create(tripDt, context, {
      driver: driver || null,
      vehicle: vehicle || null,
      trip_date: new Date().toISOString().slice(0, 10),
      status: "Draft",
      stops,
    });
    this.logger.log(`Delivery Trip ${trip.name}: ${stops.length} stop(s), driver ${driver || "—"}`);
    return String(trip.name);
  }

  @OnEvent("doc.on_submit:Delivery Trip")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    // A freshly submitted trip is Scheduled until dispatched.
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Delivery Trip"))}
       SET ${quoteIdent("status")} = 'Scheduled'
       WHERE ${quoteIdent("name")} = $1 AND ${quoteIdent("status")} IN ('Draft', '')`,
      [String(payload.doc.name)],
    );
  }

  @OnEvent("doc.on_cancel:Delivery Trip")
  async onCancel(payload: DocEventPayload): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Delivery Trip"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }

  /** Dispatch a scheduled trip: mark it In Transit. */
  async dispatch(trip: string): Promise<{ trip: string; status: string }> {
    const row = await this.tripRow(trip);
    if (Number(row.docstatus ?? 0) !== 1) throw new BadRequestException(`Delivery Trip ${trip} must be submitted to dispatch`);
    if (String(row.status) !== "Scheduled") {
      throw new BadRequestException(`Delivery Trip ${trip} must be Scheduled to dispatch (is ${row.status})`);
    }
    await this.setStatus(trip, "In Transit");
    this.logger.log(`Delivery Trip ${trip} dispatched (In Transit)`);
    return { trip, status: "In Transit" };
  }

  /** Complete an in-transit trip: mark it Completed and every stop delivered. */
  async complete(trip: string): Promise<{ trip: string; status: string; stops: number }> {
    const row = await this.tripRow(trip);
    if (Number(row.docstatus ?? 0) !== 1) throw new BadRequestException(`Delivery Trip ${trip} must be submitted to complete`);
    if (String(row.status) !== "In Transit") {
      throw new BadRequestException(`Delivery Trip ${trip} must be In Transit to complete (is ${row.status})`);
    }
    const res = await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Delivery Trip Stop"))}
       SET ${quoteIdent("delivered")} = 1 WHERE ${quoteIdent("parent")} = $1`,
      [trip],
    );
    await this.setStatus(trip, "Completed");
    const stops = Array.isArray(res) ? Number(res[1] ?? 0) : 0;
    this.logger.log(`Delivery Trip ${trip} completed`);
    return { trip, status: "Completed", stops };
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Delivery Trip", { suppressErrors: false })
  async gateTrip(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const rows = (doc.stops as Array<Record<string, unknown>>) ?? [];
    if (rows.length === 0) throw new BadRequestException("Delivery Trip needs at least one stop");
    const dnDt = this.registry.get("Delivery Note");
    for (const row of rows) {
      const dn = String(row.delivery_note ?? "");
      if (!dn) continue;
      if (dnDt) {
        const note = await this.documents.get(dnDt, dn);
        if ((note.docstatus ?? 0) !== 1) {
          throw new BadRequestException(`Delivery Trip ${doc.name}: Delivery Note ${dn} is not submitted`);
        }
        if (Boolean(note.is_return)) {
          throw new BadRequestException(`Delivery Trip ${doc.name}: Delivery Note ${dn} is a return`);
        }
      }
      const clash = (
        await this.dataSource.query(
          `SELECT t.${quoteIdent("name")} AS name
           FROM ${quoteIdent(tableNameFor("Delivery Trip Stop"))} s
           JOIN ${quoteIdent(tableNameFor("Delivery Trip"))} t ON t.${quoteIdent("name")} = s.${quoteIdent("parent")}
           WHERE s.${quoteIdent("delivery_note")} = $1 AND t.${quoteIdent("docstatus")} = 1
             AND t.${quoteIdent("name")} <> $2
           LIMIT 1`,
          [dn, String(doc.name)],
        )
      )[0];
      if (clash) {
        throw new BadRequestException(
          `Delivery Trip ${doc.name}: Delivery Note ${dn} is already on trip ${clash.name}`,
        );
      }
    }
  }

  private async tripRow(trip: string): Promise<Record<string, unknown>> {
    if (!this.registry.has("Delivery Trip")) throw new BadRequestException("Delivery Trip not registered");
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("docstatus")} AS docstatus, ${quoteIdent("status")} AS status
         FROM ${quoteIdent(tableNameFor("Delivery Trip"))} WHERE ${quoteIdent("name")} = $1`,
        [trip],
      )
    )[0];
    if (!row) throw new BadRequestException(`Delivery Trip ${trip} not found`);
    return row;
  }

  private async setStatus(trip: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Delivery Trip"))}
       SET ${quoteIdent("status")} = $1 WHERE ${quoteIdent("name")} = $2`,
      [status, trip],
    );
  }
}
