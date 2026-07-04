import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { promises as fs } from "fs";
import { join } from "path";
import {
  DocTypeSchema,
  type DocTypeDef,
  type DocFieldDef,
  type DocPermDef,
} from "@fat/shared";
import { DocTypeEntity } from "./entities/doctype.entity";
import { DocFieldEntity } from "./entities/docfield.entity";
import { DocPermEntity } from "./entities/docperm.entity";
import { DoctypeRegistryService, LoadedDocType } from "./doctype-registry.service";
import { SchemaSyncService } from "./schema-sync.service";

function bit(v: boolean | number | undefined): number {
  return v ? 1 : 0;
}

/**
 * Loads DocType definitions from module JSON files (or the DB), persists them to
 * the framework metadata tables, registers them in the in-memory registry, and
 * triggers a physical-schema sync.
 */
@Injectable()
export class DoctypeLoaderService {
  private readonly logger = new Logger(DoctypeLoaderService.name);

  constructor(
    @InjectRepository(DocTypeEntity)
    private readonly doctypeRepo: Repository<DocTypeEntity>,
    @InjectRepository(DocFieldEntity)
    private readonly fieldRepo: Repository<DocFieldEntity>,
    @InjectRepository(DocPermEntity)
    private readonly permRepo: Repository<DocPermEntity>,
    private readonly registry: DoctypeRegistryService,
    private readonly schemaSync: SchemaSyncService,
  ) {}

  private toLoaded(def: DocTypeDef): LoadedDocType {
    return {
      name: def.name,
      module: def.module,
      naming_rule: def.naming_rule,
      istable: def.istable,
      is_submittable: def.is_submittable,
      title_field: def.title_field ?? null,
      fields: def.fields,
      perms: def.permissions,
    };
  }

  /** Validate, persist, register, and sync a single DocType definition. */
  async registerDef(raw: unknown, opts: { sync?: boolean } = {}): Promise<LoadedDocType> {
    const def = DocTypeSchema.parse(raw);

    await this.doctypeRepo.save(
      this.doctypeRepo.create({
        name: def.name,
        module: def.module,
        naming_rule: def.naming_rule,
        istable: bit(def.istable),
        is_submittable: bit(def.is_submittable),
        title_field: def.title_field ?? null,
      }),
    );

    // Metadata is code-owned: replace fields/perms wholesale for idempotency.
    await this.fieldRepo.delete({ parent: def.name });
    await this.permRepo.delete({ parent: def.name });

    const fieldEntities = def.fields.map((f: DocFieldDef, idx: number) =>
      this.fieldRepo.create({
        parent: def.name,
        idx,
        fieldname: f.fieldname,
        label: f.label ?? null,
        fieldtype: f.fieldtype,
        options: f.options ?? null,
        options_field: f.options_field ?? null,
        reqd: bit(f.reqd),
        is_unique: bit(f.unique),
        read_only: bit(f.read_only),
        hidden: bit(f.hidden),
        in_list_view: bit(f.in_list_view),
        in_standard_filter: bit(f.in_standard_filter),
        default_value: f.default ?? null,
        description: f.description ?? null,
        permlevel: f.permlevel ?? 0,
      }),
    );
    if (fieldEntities.length) await this.fieldRepo.save(fieldEntities);

    const permEntities = def.permissions.map((p: DocPermDef) =>
      this.permRepo.create({
        parent: def.name,
        role: p.role,
        permlevel: p.permlevel ?? 0,
        can_read: bit(p.read),
        can_write: bit(p.write),
        can_create: bit(p.create),
        can_delete: bit(p.delete),
        can_submit: bit(p.submit),
        can_cancel: bit(p.cancel),
        can_report: bit(p.report),
        if_owner: bit(p.if_owner),
      }),
    );
    if (permEntities.length) await this.permRepo.save(permEntities);

    const loaded = this.toLoaded(def);
    this.registry.register(loaded);
    if (opts.sync !== false) await this.schemaSync.syncDocType(loaded);
    return loaded;
  }

  /** Load every *.doctype.json file in a directory (non-recursive). */
  async registerFromDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return; // module has no doctypes dir
    }
    const files = entries.filter((f) => f.endsWith(".doctype.json")).sort();
    for (const file of files) {
      const content = await fs.readFile(join(dir, file), "utf8");
      await this.registerDef(JSON.parse(content));
      this.logger.log(`Registered DocType from ${file}`);
    }
  }

  /** Build a LoadedDocType from its DB rows (metadata tables). */
  private async buildFromDb(name: string): Promise<LoadedDocType | null> {
    const dt = await this.doctypeRepo.findOne({ where: { name } });
    if (!dt) return null;
    const fields = await this.fieldRepo.find({
      where: { parent: dt.name },
      order: { idx: "ASC" },
    });
    const perms = await this.permRepo.find({ where: { parent: dt.name } });
    return {
      name: dt.name,
      module: dt.module,
      naming_rule: dt.naming_rule,
      istable: dt.istable === 1,
      is_submittable: dt.is_submittable === 1,
      title_field: dt.title_field,
      fields: fields.map((f) => ({
        fieldname: f.fieldname,
        label: f.label ?? undefined,
        fieldtype: f.fieldtype as DocFieldDef["fieldtype"],
        options: f.options ?? undefined,
        options_field: f.options_field ?? undefined,
        reqd: f.reqd === 1,
        unique: f.is_unique === 1,
        read_only: f.read_only === 1,
        hidden: f.hidden === 1,
        in_list_view: f.in_list_view === 1,
        in_standard_filter: f.in_standard_filter === 1,
        default: f.default_value ?? undefined,
        description: f.description ?? undefined,
        permlevel: f.permlevel,
      })),
      perms: perms.map((p) => ({
        role: p.role,
        permlevel: p.permlevel,
        read: p.can_read === 1,
        write: p.can_write === 1,
        create: p.can_create === 1,
        delete: p.can_delete === 1,
        submit: p.can_submit === 1,
        cancel: p.can_cancel === 1,
        report: p.can_report === 1,
      })),
    };
  }

  /** Reload a single DocType's metadata from the DB into the registry. */
  async reloadFromDb(name: string): Promise<void> {
    const loaded = await this.buildFromDb(name);
    if (!loaded) return;
    this.registry.register(loaded);
    await this.schemaSync.syncDocType(loaded);
  }

  /** Rebuild the in-memory registry from the DB and ensure tables exist. */
  async loadAllFromDb(): Promise<void> {
    const doctypes = await this.doctypeRepo.find();
    for (const dt of doctypes) await this.reloadFromDb(dt.name);
    this.logger.log(`Loaded ${doctypes.length} DocTypes from database`);
  }
}
