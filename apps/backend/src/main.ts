import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";
import { UPLOAD_DIR } from "./core/uploads/upload.controller";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.enableCors({ origin: true, credentials: true });
  app.useStaticAssets(UPLOAD_DIR, { prefix: "/files" });

  const cfg = loadConfig();
  await app.listen(cfg.backendPort);
  new Logger("Bootstrap").log(`FAT backend listening on :${cfg.backendPort}`);
}

bootstrap();
