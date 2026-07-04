import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as argon2 from "argon2";
import { randomBytes } from "crypto";
import { UserEntity } from "./entities/user.entity";
import { PermissionService, UserContext } from "../core/permissions/permission.service";

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly permissions: PermissionService,
  ) {}

  /** Generate a fresh api_key/api_secret for a user; returns the plaintext pair. */
  async generate(userName: string): Promise<{ api_key: string; api_secret: string }> {
    const apiKey = randomBytes(12).toString("hex");
    const apiSecret = randomBytes(16).toString("hex");
    await this.userRepo.update(
      { name: userName },
      { api_key: apiKey, api_secret: await argon2.hash(apiSecret) },
    );
    return { api_key: apiKey, api_secret: apiSecret };
  }

  /** Validate `token <key>:<secret>` and resolve the UserContext, or null. */
  async validate(header: string): Promise<UserContext | null> {
    const match = /^token\s+([^:]+):(.+)$/i.exec(header.trim());
    if (!match) return null;
    const [, key, secret] = match;
    const user = await this.userRepo.findOne({ where: { api_key: key } });
    if (!user || user.enabled !== 1 || !user.api_secret) return null;
    const ok = await argon2.verify(user.api_secret, secret);
    if (!ok) return null;
    return this.permissions.buildContext(user.name);
  }
}
