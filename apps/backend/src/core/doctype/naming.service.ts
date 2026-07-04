import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { randomBytes } from "crypto";
import type { LoadedDocType } from "./doctype-registry.service";

/**
 * Assigns the `name` (primary key) of a new document per the DocType's
 * naming_rule: `hash`, `prompt`, `field:<fieldname>`, or `series:<pattern>`.
 */
@Injectable()
export class NamingService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async generateName(
    dt: LoadedDocType,
    data: Record<string, unknown>,
  ): Promise<string> {
    const rule = dt.naming_rule || "hash";

    if (rule === "hash") {
      return randomBytes(6).toString("hex"); // 12-char id
    }

    if (rule === "prompt") {
      const provided = data["name"];
      if (!provided || String(provided).trim() === "") {
        throw new BadRequestException(`${dt.name} requires an explicit name`);
      }
      return String(provided).trim();
    }

    if (rule.startsWith("field:")) {
      const fieldname = rule.slice("field:".length);
      const value = data[fieldname];
      if (value === undefined || value === null || String(value).trim() === "") {
        throw new BadRequestException(
          `Cannot name ${dt.name}: field '${fieldname}' is empty`,
        );
      }
      return String(value).trim();
    }

    if (rule.startsWith("series:")) {
      return this.nextFromSeries(rule.slice("series:".length));
    }

    // Unknown rule: fall back to hash.
    return randomBytes(6).toString("hex");
  }

  /**
   * Resolve a series pattern such as `CUST-.#####` to the next value
   * (e.g. `CUST-00001`). The counter is incremented atomically.
   */
  private async nextFromSeries(pattern: string): Promise<string> {
    const hashMatch = pattern.match(/#+/);
    const padding = hashMatch ? hashMatch[0].length : 5;
    const prefix = pattern.replace(/\.?#+/, "");

    const rows: Array<{ current: number }> = await this.dataSource.query(
      `INSERT INTO "tabSeries" ("name", "current") VALUES ($1, 1)
       ON CONFLICT ("name") DO UPDATE SET "current" = "tabSeries"."current" + 1
       RETURNING "current"`,
      [prefix],
    );
    const next = rows[0].current;
    return `${prefix}${String(next).padStart(padding, "0")}`;
  }
}
