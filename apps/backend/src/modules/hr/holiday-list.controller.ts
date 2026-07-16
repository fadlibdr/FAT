import { Body, Controller, Param, Post } from "@nestjs/common";
import { HolidayListService } from "./holiday-list.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Holiday List automation endpoints. */
@Controller("api/hr/holiday-list")
export class HolidayListController {
  constructor(private readonly holidays: HolidayListService) {}

  @Post(":name/populate-weekly-offs")
  populate(@CurrentUser() user: UserContext, @Param("name") name: string) {
    return this.holidays.populateWeeklyOffs(name, user);
  }

  @Post(":name/working-days")
  workingDays(@Param("name") name: string, @Body() body: { from_date: string; to_date: string }) {
    return this.holidays.workingDays(name, body?.from_date, body?.to_date);
  }
}
