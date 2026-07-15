import { Controller, Param, Post } from "@nestjs/common";
import { ProjectsBillingService } from "./projects-billing.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Projects billing endpoints. */
@Controller("api/projects")
export class ProjectsController {
  constructor(private readonly billing: ProjectsBillingService) {}

  @Post("timesheet/:name/make-sales-invoice")
  async billTimesheet(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const salesInvoice = await this.billing.makeSalesInvoice(name, user);
    return { salesInvoice };
  }
}
