import { Controller, ForbiddenException, Post } from "@nestjs/common";
import { ScheduledTasksService } from "./scheduled-tasks.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

@Controller("api/admin/run-scheduled")
export class SchedulerController {
  constructor(private readonly tasks: ScheduledTasksService) {}

  @Post()
  run(@CurrentUser() user: UserContext) {
    if (!user.isSuper) throw new ForbiddenException("System Manager access required");
    return this.tasks.runNow();
  }
}
