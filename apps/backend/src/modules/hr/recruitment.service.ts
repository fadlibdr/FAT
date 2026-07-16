import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Recruitment lifecycle for Job Applicants against a Job Opening. Applicants move
 * Open -> Shortlisted -> Hired/Rejected; hiring is capped at the opening's
 * vacancies and closes the opening once it is filled. Pure SQL over the engine's
 * tables — HR imports no other module's services.
 */
@Injectable()
export class RecruitmentService {
  private readonly logger = new Logger(RecruitmentService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async applicant(name: string): Promise<Record<string, unknown>> {
    if (!this.registry.has("Job Applicant")) throw new BadRequestException("Job Applicant not registered");
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("job_opening")} AS job_opening,
                coalesce(${quoteIdent("status")}, 'Open') AS status
         FROM ${quoteIdent(tableNameFor("Job Applicant"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (!row) throw new BadRequestException(`Job Applicant ${name} not found`);
    return row;
  }

  private async setApplicantStatus(name: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Job Applicant"))} SET ${quoteIdent("status")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [status, name],
    );
  }

  /** Shortlist an applicant (from Open). */
  async shortlist(name: string): Promise<{ applicant: string; status: string }> {
    const app = await this.applicant(name);
    if (String(app.status) !== "Open") {
      throw new BadRequestException(`Applicant ${name} is ${app.status}, only an Open applicant can be shortlisted`);
    }
    await this.setApplicantStatus(name, "Shortlisted");
    return { applicant: name, status: "Shortlisted" };
  }

  /** Reject an applicant (unless already hired). */
  async reject(name: string): Promise<{ applicant: string; status: string }> {
    const app = await this.applicant(name);
    if (String(app.status) === "Hired") {
      throw new BadRequestException(`Applicant ${name} is already Hired and cannot be rejected`);
    }
    await this.setApplicantStatus(name, "Rejected");
    return { applicant: name, status: "Rejected" };
  }

  /**
   * Hire an applicant: only an Open/Shortlisted applicant against an Open opening
   * with a remaining vacancy. Increments the opening's filled count and closes it
   * once filled.
   */
  async hire(name: string): Promise<{ applicant: string; job_opening: string; filled: number; opening_status: string }> {
    const openingDt = this.registry.get("Job Opening");
    if (!openingDt) throw new BadRequestException("Job Opening not registered");
    const app = await this.applicant(name);
    const status = String(app.status);
    if (status === "Hired") throw new BadRequestException(`Applicant ${name} is already Hired`);
    if (status === "Rejected") throw new BadRequestException(`Applicant ${name} is Rejected and cannot be hired`);
    const openingName = String(app.job_opening ?? "");

    const opening = (
      await this.dataSource.query(
        `SELECT coalesce(${quoteIdent("vacancies")}, 0) AS vacancies,
                coalesce(${quoteIdent("filled")}, 0) AS filled,
                coalesce(${quoteIdent("status")}, 'Open') AS status
         FROM ${quoteIdent(tableNameFor("Job Opening"))} WHERE ${quoteIdent("name")} = $1`,
        [openingName],
      )
    )[0];
    if (!opening) throw new BadRequestException(`Job Opening ${openingName} not found`);
    if (String(opening.status) !== "Open") {
      throw new BadRequestException(`Job Opening ${openingName} is Closed`);
    }
    const vacancies = Number(opening.vacancies);
    const filled = Number(opening.filled);
    if (filled >= vacancies) {
      throw new BadRequestException(`Job Opening ${openingName} has no remaining vacancies (${filled}/${vacancies})`);
    }

    await this.setApplicantStatus(name, "Hired");
    const newFilled = filled + 1;
    const openingStatus = newFilled >= vacancies ? "Closed" : "Open";
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Job Opening"))}
       SET ${quoteIdent("filled")} = $1, ${quoteIdent("status")} = $2
       WHERE ${quoteIdent("name")} = $3`,
      [newFilled, openingStatus, openingName],
    );
    this.logger.log(`Applicant ${name} hired into ${openingName} (${newFilled}/${vacancies}, ${openingStatus})`);
    return { applicant: name, job_opening: openingName, filled: newFilled, opening_status: openingStatus };
  }
}
