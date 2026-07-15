import { Body, Controller, Param, Post } from "@nestjs/common";
import { CrmService } from "./crm.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** CRM conversion endpoints. */
@Controller("api/crm")
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Post("opportunity/:name/close")
  async closeOpportunity(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Body() body: { outcome: "Won" | "Lost"; reason?: string },
  ) {
    return this.crm.closeOpportunity(name, body?.outcome, body?.reason ?? "", user);
  }

  @Post("lead/:name/make-opportunity")
  async makeOpportunity(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const opportunity = await this.crm.makeOpportunity(name, user);
    return { opportunity };
  }

  @Post("opportunity/:name/make-quotation")
  async makeQuotation(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const quotation = await this.crm.makeQuotation(name, user);
    return { quotation };
  }
}
