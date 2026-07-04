import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserEntity } from "./entities/user.entity";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./jwt.strategy";
import { ApiKeyService } from "./api-key.service";
import { CoreModule } from "../core/core.module";
import { loadConfig } from "../config";

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity]),
    PassportModule,
    JwtModule.register({ secret: loadConfig().jwt.secret }),
    CoreModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, ApiKeyService],
  exports: [AuthService, ApiKeyService],
})
export class AuthModule {}
