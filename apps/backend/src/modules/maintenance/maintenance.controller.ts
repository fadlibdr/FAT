import { Controller, Param, Post } from "@nestjs/common";
import { MaintenanceService } from "./maintenance.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Maintenance scheduling endpoints. */
@Controller("api/maintenance")
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post("schedule/:name/make-visit")
  async makeVisit(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const maintenanceVisit = await this.maintenance.makeVisit(name, user);
    return { maintenanceVisit };
  }

  @Post("warranty-claim/:name/make-visit")
  async makeVisitFromClaim(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const maintenanceVisit = await this.maintenance.makeVisitFromClaim(name, user);
    return { maintenanceVisit };
  }
}
