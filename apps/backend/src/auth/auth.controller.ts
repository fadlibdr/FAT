import { Body, Controller, Get, Post } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";
import { AuthService } from "./auth.service";
import { ApiKeyService } from "./api-key.service";
import { Public } from "./public.decorator";
import { CurrentUser } from "./current-user.decorator";
import type { UserContext } from "../core/permissions/permission.service";

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Get("me")
  me(@CurrentUser() user: UserContext) {
    return this.auth.me(user.name);
  }

  /** (Re)generate an API key/secret for the current user (secret shown once). */
  @Post("api-key")
  generateApiKey(@CurrentUser() user: UserContext) {
    return this.apiKeys.generate(user.name);
  }
}
