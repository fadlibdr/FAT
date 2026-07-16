import { Controller, Param, Post } from "@nestjs/common";
import { RecruitmentService } from "./recruitment.service";

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
}
