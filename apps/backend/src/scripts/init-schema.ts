import "reflect-metadata";
import { AppDataSource } from "../data-source";
import { loadConfig } from "../config";

/**
 * Creates/updates the FIXED framework tables (tabDocType, tabDocField,
 * tabDocPerm, tabSeries, tabRole, tabHasRole, tabUser). The dynamic tab<DocType>
 * document tables are provisioned separately by SchemaSyncService when DocTypes
 * are registered (during app boot / seed).
 */
async function main() {
  const cfg = loadConfig();
  // eslint-disable-next-line no-console
  console.log(
    `Connecting to postgres://${cfg.database.user}@${cfg.database.host}:${cfg.database.port}/${cfg.database.name}`,
  );
  await AppDataSource.initialize();
  await AppDataSource.synchronize(); // additive schema for framework entities
  // eslint-disable-next-line no-console
  console.log("Framework schema is ready.");
  await AppDataSource.destroy();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("init-schema failed:", err);
  process.exit(1);
});
