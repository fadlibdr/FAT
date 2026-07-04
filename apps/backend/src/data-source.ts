import { DataSource, DataSourceOptions } from "typeorm";
import { DocTypeEntity } from "./core/doctype/entities/doctype.entity";
import { DocFieldEntity } from "./core/doctype/entities/docfield.entity";
import { DocPermEntity } from "./core/doctype/entities/docperm.entity";
import { SeriesEntity } from "./core/doctype/entities/series.entity";
import { RoleEntity } from "./core/permissions/entities/role.entity";
import { HasRoleEntity } from "./core/permissions/entities/has-role.entity";
import { UserEntity } from "./auth/entities/user.entity";
import { loadConfig } from "./config";

/**
 * The fixed framework entities. Only these are managed by TypeORM. The dynamic
 * `tab<DocType>` document tables are provisioned by SchemaSyncService via raw
 * DDL and are intentionally NOT TypeORM entities.
 */
export const FRAMEWORK_ENTITIES = [
  DocTypeEntity,
  DocFieldEntity,
  DocPermEntity,
  SeriesEntity,
  RoleEntity,
  HasRoleEntity,
  UserEntity,
];

export function buildDataSourceOptions(): DataSourceOptions {
  const cfg = loadConfig();
  return {
    type: "postgres",
    host: cfg.database.host,
    port: cfg.database.port,
    username: cfg.database.user,
    password: cfg.database.password,
    database: cfg.database.name,
    entities: FRAMEWORK_ENTITIES,
    // The app never auto-syncs on boot. Schema for the fixed tables is created
    // explicitly via the init-schema script; dynamic tables via SchemaSyncService.
    synchronize: false,
    logging: false,
  };
}

/** Standalone DataSource for scripts (init-schema, seed). */
export const AppDataSource = new DataSource(buildDataSourceOptions());
