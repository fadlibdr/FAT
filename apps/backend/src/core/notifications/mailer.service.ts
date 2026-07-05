import { Injectable, Logger } from "@nestjs/common";

interface Mail {
  to: string;
  subject: string;
  text?: string;
}

/**
 * Email transport for notifications. Uses nodemailer's JSON transport by
 * default (logs the message — no SMTP required); set MAIL_ENABLED=true and swap
 * in real SMTP credentials for production delivery.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly enabled = process.env.MAIL_ENABLED === "true";
  private transporter: { sendMail: (m: Record<string, unknown>) => Promise<{ message?: unknown }> } | null =
    null;

  private ensure() {
    if (this.transporter) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require("nodemailer");
    this.transporter = process.env.SMTP_HOST
      ? nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
        })
      : nodemailer.createTransport({ jsonTransport: true });
  }

  async send(mail: Mail): Promise<void> {
    if (!this.enabled) return;
    try {
      this.ensure();
      const info = await this.transporter!.sendMail({
        from: process.env.MAIL_FROM ?? "fat@example.com",
        to: mail.to,
        subject: mail.subject,
        text: mail.text ?? mail.subject,
      });
      this.logger.log(`Email -> ${mail.to}: ${String(info.message ?? mail.subject)}`);
    } catch (err) {
      this.logger.warn(`Email to ${mail.to} failed: ${(err as Error).message}`);
    }
  }
}
