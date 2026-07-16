import { Controller, Param, Post } from "@nestjs/common";
import { ProjectsBillingService } from "./projects-billing.service";
import { ProjectService } from "./project.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Projects billing + lifecycle endpoints. */
@Controller("api/projects")
export class ProjectsController {
  constructor(
    private readonly billing: ProjectsBillingService,
    private readonly projects: ProjectService,
  ) {}

  @Post("task/:name/complete")
  async completeTask(@Param("name") name: string) {
    return this.projects.completeTask(name);
  }

  @Post("project/:name/close")
  async closeProject(@Param("name") name: string) {
    return this.projects.closeProject(name);
  }

  @Post("project/:name/reopen")
  async reopenProject(@Param("name") name: string) {
    return this.projects.reopenProject(name);
  }

  @Post("timesheet/:name/approve")
  async approveTimesheet(@Param("name") name: string) {
    return this.billing.setApproval(name, "Approved");
  }

  @Post("timesheet/:name/reject")
  async rejectTimesheet(@Param("name") name: string) {
    return this.billing.setApproval(name, "Rejected");
  }

  @Post("timesheet/:name/make-sales-invoice")
  async billTimesheet(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const salesInvoice = await this.billing.makeSalesInvoice(name, user);
    return { salesInvoice };
  }
}
