import { Injectable, NotFoundException } from "@nestjs/common";
import type { DocFieldDef, DocPermDef } from "@fat/shared";

/** A DocType as held in the in-memory registry. */
export interface LoadedDocType {
  name: string;
  module: string;
  naming_rule: string;
  istable: boolean;
  is_submittable: boolean;
  title_field: string | null;
  fields: DocFieldDef[];
  perms: DocPermDef[];
}

/**
 * In-memory cache of all DocType metadata. Populated by DoctypeLoaderService at
 * boot and refreshed whenever a DocType is created/changed.
 *
 * NOTE (flagged risk): this cache is per-process. Multi-instance deployments
 * will need a pub/sub invalidation channel; the `invalidate` hook below is the
 * seam where that would plug in.
 */
@Injectable()
export class DoctypeRegistryService {
  private readonly byName = new Map<string, LoadedDocType>();
  private readonly listeners: Array<(name: string) => void> = [];

  register(dt: LoadedDocType): void {
    this.byName.set(dt.name, dt);
    this.invalidate(dt.name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): LoadedDocType | undefined {
    return this.byName.get(name);
  }

  getOrThrow(name: string): LoadedDocType {
    const dt = this.byName.get(name);
    if (!dt) throw new NotFoundException(`Unknown DocType: ${name}`);
    return dt;
  }

  list(): LoadedDocType[] {
    return [...this.byName.values()];
  }

  clear(): void {
    this.byName.clear();
  }

  /** Register a listener notified when a DocType's metadata changes. */
  onInvalidate(fn: (name: string) => void): void {
    this.listeners.push(fn);
  }

  private invalidate(name: string): void {
    for (const fn of this.listeners) fn(name);
  }
}
