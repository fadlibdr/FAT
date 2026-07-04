import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.enableCors({ origin: true, credentials: true });

  const cfg = loadConfig();
  await app.listen(cfg.backendPort);
  new Logger("Bootstrap").log(`FAT backend listening on :${cfg.backendPort}`);
}

bootstrap();
