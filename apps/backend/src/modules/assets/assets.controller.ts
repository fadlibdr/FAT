import { Body, Controller, Post } from "@nestjs/common";
import { AssetDepreciationService } from "./asset-depreciation.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Asset automation endpoints. */
@Controller("api/assets")
export class AssetsController {
  constructor(private readonly depreciation: AssetDepreciationService) {}

  @Post("depreciation/run")
  async runDepreciation(@CurrentUser() user: UserContext, @Body() body: { as_of?: string }) {
    return this.depreciation.run(body?.as_of, user);
  }
}
