import { Injectable, Logger } from "@nestjs/common";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { DocumentService } from "../doctype/document.service";
import { systemContext } from "../permissions/system-context";

export interface NewNotification {
  user: string;
  subject: string;
  message?: string;
  ref_doctype?: string;
  ref_name?: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
  ) {}

  async notify(n: NewNotification): Promise<void> {
    const dt = this.registry.get("Notification");
    if (!dt) return;
    try {
      await this.documents.create(dt, systemContext(n.user), {
        user: n.user,
        subject: n.subject,
        message: n.message ?? null,
        is_read: 0,
        ref_doctype: n.ref_doctype ?? null,
        ref_name: n.ref_name ?? null,
      });
    } catch (err) {
      this.logger.warn(`Notification failed: ${(err as Error).message}`);
    }
  }
}
