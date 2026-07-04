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
import { QueryReportController } from "./doctype/query-report.controller";
import { MetaController } from "./meta/meta.controller";
import { SearchController } from "./meta/search.controller";
import { PrintController } from "./doctype/print.controller";
import { WorkflowService } from "./workflow/workflow.service";
import { WorkflowController } from "./workflow/workflow.controller";
import { VersionListener } from "./audit/version.listener";
import { UploadController } from "./uploads/upload.controller";
import { DoctypeAdminController } from "./admin/doctype-admin.controller";
import { WebhookListener } from "./webhooks/webhook.listener";
import { OpenApiController } from "./openapi/openapi.controller";
import { RealtimeService } from "./realtime/realtime.service";
import { RealtimeController } from "./realtime/realtime.controller";
import { NotificationService } from "./notifications/notification.service";
import { NotificationListener } from "./notifications/notification.listener";
import { ScheduledTasksService } from "./scheduler/scheduled-tasks.service";
import { SchedulerController } from "./scheduler/scheduler.controller";
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
  controllers: [
    DocumentController,
    ReportController,
    QueryReportController,
    MetaController,
    SearchController,
    PrintController,
    WorkflowController,
    UploadController,
    DoctypeAdminController,
    OpenApiController,
    RealtimeController,
    SchedulerController,
  ],
  providers: [
    DoctypeRegistryService,
    SchemaSyncService,
    DoctypeLoaderService,
    NamingService,
    ValidationService,
    HooksService,
    DocumentService,
    PermissionService,
    WorkflowService,
    VersionListener,
    WebhookListener,
    RealtimeService,
    NotificationService,
    NotificationListener,
    ScheduledTasksService,
  ],
  exports: [
    DoctypeRegistryService,
    DoctypeLoaderService,
    DocumentService,
    PermissionService,
    HooksService,
    WorkflowService,
    TypeOrmModule,
  ],
})
export class CoreModule {}
