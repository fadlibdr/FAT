import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { WorkflowService } from "./workflow.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

@Controller("api/workflow/:doctype/:name")
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Get("actions")
  actions(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
  ) {
    return this.workflow.getActions(doctype, name, user);
  }

  @Post("action")
  apply(
    @CurrentUser() user: UserContext,
    @Param("doctype") doctype: string,
    @Param("name") name: string,
    @Body() body: { action: string },
  ) {
    return this.workflow.applyAction(doctype, name, body.action, user);
  }
}
