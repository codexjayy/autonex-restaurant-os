import type { AccessJwtPayload, AuthenticatedPrincipal } from '@autonex/types';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET') ?? 'test_access_secret_min_32_characters_long_001',
    });
  }

  validate(payload: AccessJwtPayload): AuthenticatedPrincipal {
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      outletId: payload.outletId,
      membershipId: payload.membershipId,
      role: payload.role,
      isSuperAdmin: Boolean(payload.isSuperAdmin),
      tenantStatus: payload.tenantStatus,
    };
  }
}

