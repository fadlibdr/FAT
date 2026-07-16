import { Body, Controller, Param, Post } from "@nestjs/common";
import { RecruitmentService } from "./recruitment.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Recruitment actions on Job Applicants. */
@Controller("api/hr/applicant")
export class RecruitmentController {
  constructor(private readonly recruitment: RecruitmentService) {}

  @Post(":name/shortlist")
  shortlist(@Param("name") name: string) {
    return this.recruitment.shortlist(name);
  }

  @Post(":name/reject")
  reject(@Param("name") name: string) {
    return this.recruitment.reject(name);
  }

  @Post(":name/hire")
  hire(@Param("name") name: string) {
    return this.recruitment.hire(name);
  }

  @Post(":name/make-offer")
  makeOffer(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Body() body: { designation?: string; offer_ctc?: number; offer_date?: string; company?: string },
  ) {
    return this.recruitment.makeOffer(name, body ?? {}, user);
  }
}

/** Recruitment actions on Job Offers. */
@Controller("api/hr/offer")
export class JobOfferController {
  constructor(private readonly recruitment: RecruitmentService) {}

  @Post(":name/accept")
  accept(@CurrentUser() user: UserContext, @Param("name") name: string) {
    return this.recruitment.acceptOffer(name, user);
  }

  @Post(":name/reject")
  reject(@Param("name") name: string) {
    return this.recruitment.rejectOffer(name);
  }
}
