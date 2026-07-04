import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { existsSync, mkdirSync } from "fs";
import { extname, resolve } from "path";
import { randomBytes } from "crypto";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { DocumentService } from "../doctype/document.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

export const UPLOAD_DIR = resolve(process.cwd(), "data", "files");

function ensureDir() {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
}

interface UploadedMulterFile {
  originalname: string;
  filename: string;
}

@Controller("api/upload")
export class UploadController {
  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (
          _req: unknown,
          _file: unknown,
          cb: (err: Error | null, dest: string) => void,
        ) => {
          ensureDir();
          cb(null, UPLOAD_DIR);
        },
        filename: (
          _req: unknown,
          file: { originalname: string },
          cb: (err: Error | null, name: string) => void,
        ) => {
          cb(null, `${randomBytes(8).toString("hex")}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async upload(
    @CurrentUser() user: UserContext,
    @UploadedFile() file: UploadedMulterFile,
    @Body() body: { ref_doctype?: string; ref_name?: string },
  ) {
    if (!file) throw new BadRequestException("No file uploaded");
    const fileUrl = `/files/${file.filename}`;
    const dt = this.registry.get("File");
    let record: unknown = { file_url: fileUrl, file_name: file.originalname };
    if (dt) {
      record = await this.documents.create(dt, user, {
        file_name: file.originalname,
        file_url: fileUrl,
        ref_doctype: body.ref_doctype ?? null,
        ref_name: body.ref_name ?? null,
      });
    }
    return { data: record };
  }
}
