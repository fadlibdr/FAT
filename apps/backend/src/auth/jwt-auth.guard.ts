import { ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { ApiKeyService } from "./api-key.service";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // API-key auth: `Authorization: token <key>:<secret>`.
    const req = context.switchToHttp().getRequest();
    const auth: string | undefined = req.headers?.authorization;
    if (auth && /^token\s+/i.test(auth)) {
      const ctx = await this.apiKeys.validate(auth);
      if (!ctx) throw new UnauthorizedException("Invalid API key");
      req.user = ctx;
      return true;
    }

    // Otherwise fall back to JWT bearer auth.
    return (await super.canActivate(context)) as boolean;
  }
}
