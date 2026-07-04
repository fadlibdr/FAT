import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { FatDocument } from "@fat/shared";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { DocumentService } from "../doctype/document.service";
import { systemContext } from "../permissions/system-context";
import { tableNameFor, quoteIdent } from "../doctype/schema-sync.service";
import type { DocEventPayload } from "../doctype/hooks.service";

const SKIP = new Set(["Version", "Comment", "File"]);
const IGNORE_FIELDS = new Set(["modified", "modified_by", "creation", "owner", "idx"]);

/**
 * Writes a `Version` record on every document update: a snapshot of the scalar
 * fields plus the set of fields that changed since the previous version. Gives
 * an audit trail / history without threading old state through the engine.
 */
@Injectable()
export class VersionListener {
  private readonly logger = new Logger(VersionListener.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
  ) {}

  @OnEvent("doc.after_update")
  async onUpdate(payload: DocEventPayload): Promise<void> {
    if (SKIP.has(payload.doctype)) return;
    if (!this.registry.has("Version")) return;
    try {
      await this.record(payload);
    } catch (err) {
      this.logger.warn(`Version failed for ${payload.doctype} ${payload.doc.name}: ${(err as Error).message}`);
    }
  }

  private snapshot(doc: FatDocument): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc)) {
      if (IGNORE_FIELDS.has(k)) continue;
      if (Array.isArray(v)) continue; // skip child tables
      out[k] = v;
    }
    return out;
  }

  private async record(payload: DocEventPayload): Promise<void> {
    const snap = this.snapshot(payload.doc);

    const prev = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("data")} AS data FROM ${quoteIdent(tableNameFor("Version"))}
         WHERE ${quoteIdent("ref_doctype")} = $1 AND ${quoteIdent("ref_name")} = $2
         ORDER BY ${quoteIdent("creation")} DESC LIMIT 1`,
        [payload.doctype, payload.doc.name],
      )
    )[0];

    const changed: string[] = [];
    const prevSnap = prev ? (JSON.parse(prev.data).snapshot ?? {}) : {};
    for (const key of Object.keys(snap)) {
      if (String(prevSnap[key] ?? "") !== String(snap[key] ?? "")) changed.push(key);
    }

    const versionDt = this.registry.getOrThrow("Version");
    await this.documents.create(versionDt, systemContext(payload.user), {
      ref_doctype: payload.doctype,
      ref_name: payload.doc.name,
      data: JSON.stringify({ changed, snapshot: snap }),
    });
  }
}
