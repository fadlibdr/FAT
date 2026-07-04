import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { loadConfig } from "../config";
import { PermissionService, UserContext } from "../core/permissions/permission.service";

interface JwtPayload {
  sub: string; // user name (email)
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly permissions: PermissionService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: loadConfig().jwt.secret,
    });
  }

  /** Resolves roles fresh each request so permission changes take effect. */
  async validate(payload: JwtPayload): Promise<UserContext> {
    return this.permissions.buildContext(payload.sub);
  }
}
