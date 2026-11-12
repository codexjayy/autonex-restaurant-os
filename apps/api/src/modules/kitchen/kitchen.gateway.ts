import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  FloorEventEnvelope,
  KdsEventEnvelope,
  StaffRole,
  TenantStatus,
  kdsKitchenRoom,
  kdsStaffRoom,
} from '@autonex/shared';
import type { Server, Socket } from 'socket.io';
import type { AccessJwtPayload } from '../../common/guards/jwt-auth.guard';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';

const ALLOWED_KDS_WS_ROLES = new Set<string>([
  StaffRole.OWNER,
  StaffRole.MANAGER,
  StaffRole.CASHIER,
  StaffRole.KITCHEN,
  StaffRole.WAITER,
]);

interface AuthenticatedSocketData {
  userId?: string;
  tenantId?: string;
  outletId?: string;
  role?: string;
}

@WebSocketGateway({
  namespace: '/kds',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class KitchenGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new StructuredLoggerService(KitchenGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private extractToken(client: Socket): string | null {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim().length > 0) {
      return authToken.replace(/^Bearer\s+/i, '').trim();
    }
    const headerAuth = client.handshake.headers?.authorization;
    if (typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')) {
      return headerAuth.slice('Bearer '.length).trim();
    }
    return null;
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      client.emit('kds:error', { code: 'UNAUTHORIZED', message: 'Missing access token' });
      client.disconnect(true);
      return;
    }

    let payload: AccessJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessJwtPayload>(token, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      client.emit('kds:error', { code: 'UNAUTHORIZED', message: 'Invalid or expired access token' });
      client.disconnect(true);
      return;
    }

    if (!payload.tenantId || !payload.outletId || !ALLOWED_KDS_WS_ROLES.has(payload.role)) {
      client.emit('kds:error', {
        code: 'FORBIDDEN',
        message: 'Your role or outlet selection does not allow live kitchen display access.',
      });
      client.disconnect(true);
      return;
    }

    if (payload.tenantStatus === TenantStatus.PENDING_APPROVAL) {
      client.emit('kds:error', {
        code: 'TENANT_NOT_APPROVED',
        message:
          'Restaurant verification is pending approval. Live KDS unlocks automatically once approved.',
      });
      client.disconnect(true);
      return;
    }

    if (payload.tenantStatus === TenantStatus.REJECTED) {
      client.emit('kds:error', {
        code: 'TENANT_REJECTED',
        message: 'Restaurant registration was rejected. Kitchen display access is disabled.',
      });
      client.disconnect(true);
      return;
    }

    if (payload.tenantStatus === TenantStatus.SUSPENDED) {
      client.emit('kds:error', {
        code: 'TENANT_SUSPENDED',
        message: 'Restaurant access is currently suspended. Contact AutoNex support.',
      });
      client.disconnect(true);
      return;
    }

    const socketData = client.data as AuthenticatedSocketData;
    socketData.userId = payload.sub;
    socketData.tenantId = payload.tenantId;
    socketData.outletId = payload.outletId;
    socketData.role = payload.role;

    // Room membership is derived strictly from the signed JWT — client input is never trusted.
    await client.join(kdsStaffRoom(payload.tenantId, payload.outletId));
    await client.join(kdsKitchenRoom(payload.tenantId, payload.outletId));

    client.emit('kds:connected', {
      tenantId: payload.tenantId,
      outletId: payload.outletId,
      role: payload.role,
      connectedAt: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket): void {
    const socketData = client.data as AuthenticatedSocketData;
    if (socketData?.tenantId) {
      this.logger.log(
        `KDS client disconnected user=${socketData.userId} tenant=${socketData.tenantId}`,
        KitchenGateway.name,
      );
    }
  }

  @SubscribeMessage('kds:ping')
  handlePing(@ConnectedSocket() client: Socket) {
    const socketData = client.data as AuthenticatedSocketData;
    return {
      ok: Boolean(socketData?.tenantId),
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Emits a committed outbox event strictly to authenticated rooms belonging to the owning tenant & outlet.
   */
  emitKdsEvent(envelope: KdsEventEnvelope): void {
    if (!this.server) return;
    const room = kdsKitchenRoom(envelope.tenantId, envelope.outletId);
    this.server.to(room).emit('kds.event', envelope);
  }

  /**
   * Emits a committed session/floor lifecycle event to authenticated front-of-house staff.
   */
  emitFloorEvent(envelope: FloorEventEnvelope): void {
    if (!this.server) return;
    const room = kdsStaffRoom(envelope.tenantId, envelope.outletId);
    this.server.to(room).emit('floor.event', envelope);
  }

  /**
   * Emits a committed billing/payment outbox event to authenticated front-of-house/cashier staff.
   */
  emitBillingEvent(
    envelope: Record<string, unknown> & { tenantId: string; outletId: string },
  ): void {
    if (!this.server) return;
    const room = kdsStaffRoom(envelope.tenantId, envelope.outletId);
    this.server.to(room).emit('billing.event', envelope);
  }
}

