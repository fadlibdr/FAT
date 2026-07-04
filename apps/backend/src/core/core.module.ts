import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DocTypeEntity } from "./doctype/entities/doctype.entity";
import { DocFieldEntity } from "./doctype/entities/docfield.entity";
import { DocPermEntity } from "./doctype/entities/docperm.entity";
import { SeriesEntity } from "./doctype/entities/series.entity";
import { RoleEntity } from "./permissions/entities/role.entity";
import { HasRoleEntity } from "./permissions/entities/has-role.entity";
import { DoctypeRegistryService } from "./doctype/doctype-registry.service";
import { SchemaSyncService } from "./doctype/schema-sync.service";
import { DoctypeLoaderService } from "./doctype/doctype-loader.service";
import { NamingService } from "./doctype/naming.service";
import { ValidationService } from "./doctype/validation.service";
import { HooksService } from "./doctype/hooks.service";
import { DocumentService } from "./doctype/document.service";
import { DocumentController } from "./doctype/document.controller";
import { ReportController } from "./doctype/report.controller";
import { MetaController } from "./meta/meta.controller";
import { PermissionService } from "./permissions/permission.service";

/**
 * The engine. Provides the DocType metadata registry, runtime schema sync,
 * generic document CRUD, validation, naming, permissions, and the generic
 * REST controllers. Business modules import this module to register DocTypes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DocTypeEntity,
      DocFieldEntity,
      DocPermEntity,
      SeriesEntity,
      RoleEntity,
      HasRoleEntity,
    ]),
  ],
  controllers: [DocumentController, ReportController, MetaController],
  providers: [
    DoctypeRegistryService,
    SchemaSyncService,
    DoctypeLoaderService,
    NamingService,
    ValidationService,
    HooksService,
    DocumentService,
    PermissionService,
  ],
  exports: [
    DoctypeRegistryService,
    DoctypeLoaderService,
    DocumentService,
    PermissionService,
    HooksService,
    TypeOrmModule,
  ],
})
export class CoreModule {}
