import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as argon2 from "argon2";
import { UserEntity } from "./entities/user.entity";
import { loadConfig } from "../config";
import { PermissionService } from "../core/permissions/permission.service";

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  user: { name: string; email: string; full_name: string | null; roles: string[] };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly jwt: JwtService,
    private readonly permissions: PermissionService,
  ) {}

  static hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async validateUser(email: string, password: string): Promise<UserEntity> {
    const user = await this.userRepo.findOne({ where: { email } });
    if (!user || user.enabled !== 1) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const ok = await argon2.verify(user.password_hash, password);
    if (!ok) throw new UnauthorizedException("Invalid credentials");
    return user;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.validateUser(email, password);
    const cfg = loadConfig();
    const payload = { sub: user.name, email: user.email };
    const roles = await this.permissions.getRoles(user.name);
    return {
      access_token: this.jwt.sign(payload, { expiresIn: cfg.jwt.accessExpires }),
      refresh_token: this.jwt.sign(payload, { expiresIn: cfg.jwt.refreshExpires }),
      user: {
        name: user.name,
        email: user.email,
        full_name: user.full_name,
        roles,
      },
    };
  }

  async me(userName: string) {
    const user = await this.userRepo.findOne({ where: { name: userName } });
    if (!user) throw new UnauthorizedException();
    const roles = await this.permissions.getRoles(userName);
    return {
      name: user.name,
      email: user.email,
      full_name: user.full_name,
      roles,
    };
  }
}
