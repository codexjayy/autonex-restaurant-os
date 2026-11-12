import {
  Controller,
  MessageEvent,
  Query,
  Req,
  Sse,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SkipThrottle } from '@nestjs/throttler';
import { ErrorCode, SYSTEM_ROLE_SUPER_ADMIN } from '@autonex/shared';
import type { Request } from 'express';
import { filter, interval, map, merge, Observable, of } from 'rxjs';
import { Public } from '../decorators/public.decorator';
import type { AccessJwtPayload } from '../guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformRealtimeEvent, RealtimeEventsService } from './realtime-events.service';

@Controller('events')
export class RealtimeEventsController {
  constructor(
    private readonly realtimeEvents: RealtimeEventsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @SkipThrottle()
  @Sse('stream')
  async stream(
    @Query('token') queryToken: string | undefined,
    @Req() req: Request,
  ): Promise<Observable<MessageEvent>> {
    const authHeader = req.header('authorization');
    const bearerToken =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : undefined;
    const rawToken = (bearerToken || queryToken || '').trim();

    if (!rawToken) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Access token required for realtime event stream.',
      });
    }

    let payload: AccessJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessJwtPayload>(rawToken, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired access token.',
      });
    }

    const isSuperAdmin = Boolean(payload.isSuperAdmin && payload.role === SYSTEM_ROLE_SUPER_ADMIN);
    if (isSuperAdmin) {
      const liveAdmin = await this.prisma.runAsSystemAdmin((db) =>
        db.user.findUnique({
          where: { id: payload.sub },
          select: {
            isSuperAdmin: true,
            isActive: true,
            deletedAt: true,
            passwordChangedAt: true,
          },
        }),
      );
      if (
        !liveAdmin ||
        liveAdmin.deletedAt ||
        !liveAdmin.isActive ||
        !liveAdmin.isSuperAdmin ||
        (liveAdmin.passwordChangedAt &&
          typeof payload.iat === 'number' &&
          Math.floor(liveAdmin.passwordChangedAt.getTime() / 1000) > payload.iat)
      ) {
        throw new UnauthorizedException({
          code: ErrorCode.UNAUTHORIZED,
          message: 'Super Admin session is no longer active.',
        });
      }
    } else if (!payload.tenantId) {
      throw new UnauthorizedException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required for restaurant event stream.',
      });
    }

    const connected$ = of<MessageEvent>({
      type: 'connected',
      data: {
        scope: isSuperAdmin ? 'super-admin' : 'tenant',
        tenantId: payload.tenantId ?? null,
        outletId: payload.outletId ?? null,
        connectedAt: new Date().toISOString(),
      },
    });

    const heartbeat$ = interval(25_000).pipe(
      map(
        (): MessageEvent => ({
          type: 'ping',
          data: { ts: new Date().toISOString() },
        }),
      ),
    );

    const events$ = this.realtimeEvents.events$.pipe(
      filter((event: PlatformRealtimeEvent) => {
        if (isSuperAdmin) return true;
        if (event.tenantId !== payload.tenantId) return false;
        if (!event.tenantWide && event.outletId && payload.outletId && event.outletId !== payload.outletId) {
          return false;
        }
        return true;
      }),
      map(
        (event: PlatformRealtimeEvent): MessageEvent => ({
          id: event.id,
          type: event.type,
          data: event,
        }),
      ),
    );

    return merge(connected$, heartbeat$, events$);
  }
}

