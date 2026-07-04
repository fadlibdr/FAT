import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { UserContext } from "../core/permissions/permission.service";

/** Injects the authenticated UserContext (name + roles) built by JwtStrategy. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserContext => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as UserContext;
  },
);
