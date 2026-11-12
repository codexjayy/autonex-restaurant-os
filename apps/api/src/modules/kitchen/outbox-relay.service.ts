import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DietaryType,
  DiningSessionStatus,
  FloorEventEnvelope,
  KdsEventEnvelope,
  KdsOutboxTopic,
  KdsTicketModifierSnapshot,
  KdsTicketPayload,
  KitchenStatus,
  OrderSource,
  SessionLifecycleStage,
  SessionOutboxTopic,
  mapSessionStatusToStage,
} from '@autonex/shared';
import { Prisma, PrismaClient } from '@prisma/client';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KitchenGateway } from './kitchen.gateway';
import { serializeKdsTicket } from './kitchen.service';

export interface ClaimedOutboxRow {
  id: string;
  tenantId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payloadJson: Prisma.JsonValue;
  retryCount: number;
  createdAt: Date;
}

const MAX_OUTBOX_RETRIES = 10;
const STALE_PROCESSING_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLoggerService(OutboxRelayService.name);
  private pollTimer: NodeJS.Timeout | null = null;
  private reclaimTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kitchenGateway: KitchenGateway,
  ) {}

  onModuleInit(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_OUTBOX_WORKER === 'true' ||
      process.env.SKIP_DB_CONNECT === 'true'
    ) {
      return;
    }

    const pollMs = Math.max(100, Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 250));
    this.pollTimer = setInterval(() => {
      void this.processPendingBatch().catch((err) => {
        this.logger.error(
          `Outbox relay tick failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
          OutboxRelayService.name,
        );
      });
    }, pollMs);
    this.pollTimer.unref?.();

    this.reclaimTimer = setInterval(() => {
      void this.reclaimStuckProcessing().catch((err) => {
        this.logger.error(
          `Outbox stale reclaim failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
          OutboxRelayService.name,
        );
      });
    }, 10_000);
    this.reclaimTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
  }

  /**
   * Claims a batch of due PENDING outbox events atomically using PostgreSQL
   * `SELECT ... FOR UPDATE SKIP LOCKED` so horizontal API/worker replicas never duplicate events.
   */
  async claimPendingBatch(batchSize = DEFAULT_BATCH_SIZE): Promise<ClaimedOutboxRow[]> {
    return this.prisma.runAsSystemAdmin(async (adminDb: PrismaClient) => {
      return adminDb.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ClaimedOutboxRow[]>`
          WITH claimed AS (
            SELECT id
            FROM outbox_events
            WHERE status = 'PENDING'
              AND available_at <= now()
            ORDER BY available_at ASC, created_at ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE outbox_events oe
          SET status = 'PROCESSING'
          FROM claimed
          WHERE oe.id = claimed.id
          RETURNING
            oe.id,
            oe.tenant_id AS "tenantId",
            oe.topic,
            oe.aggregate_type AS "aggregateType",
            oe.aggregate_id AS "aggregateId",
            oe.payload_json AS "payloadJson",
            oe.retry_count AS "retryCount",
            oe.created_at AS "createdAt"
        `;
        return rows;
      });
    });
  }

  async reclaimStuckProcessing(staleAfterMs = STALE_PROCESSING_MS): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    return this.prisma.runAsSystemAdmin(async (adminDb: PrismaClient) => {
      const updated = await adminDb.$executeRaw`
        UPDATE outbox_events
        SET status = 'PENDING',
            available_at = now(),
            last_error = COALESCE(last_error, 'Reclaimed after interrupted worker lease')
        WHERE status = 'PROCESSING'
          AND available_at <= ${cutoff}
      `;
      return Number(updated);
    });
  }

  private async resolveTicketPayload(row: ClaimedOutboxRow): Promise<KdsTicketPayload | null> {
    const payload = (row.payloadJson ?? {}) as Record<string, unknown>;
    if (payload.ticket && typeof payload.ticket === 'object') {
      return payload.ticket as KdsTicketPayload;
    }

    // Fallback hydration if an outbox row only stored minimal Order metadata
    if (row.aggregateType === 'Order') {
      const order = await this.prisma.runAsSystemAdmin((adminDb) =>
        adminDb.order.findFirst({
          where: { id: row.aggregateId, tenantId: row.tenantId },
          include: {
            session: {
              select: {
                id: true,
                table: { select: { id: true, tableNumber: true, label: true } },
              },
            },
            acknowledgedByMembership: {
              select: {
                id: true,
                user: { select: { name: true } },
              },
            },
            items: { orderBy: { createdAt: 'asc' } },
          },
        }),
      );
      if (order) {
        return serializeKdsTicket(order);
      }

      if (payload.orderId && payload.outletId && payload.tableId) {
        const createdIso =
          typeof payload.createdAt === 'string'
            ? payload.createdAt
            : row.createdAt.toISOString();
        return {
          id: String(payload.orderId),
          tenantId: row.tenantId,
          outletId: String(payload.outletId),
          sessionId: String(payload.sessionId ?? ''),
          tableId: String(payload.tableId),
          tableNumber: String(payload.tableNumber ?? ''),
          tableLabel: (payload.tableLabel as string | null) ?? null,
          roundNumber: Number(payload.roundNumber ?? 1),
          kotNumber: Number(payload.kotNumber ?? 0),
          isAddOn: Boolean(payload.isAddOn),
          source: (payload.source as OrderSource) ?? OrderSource.CUSTOMER_QR,
          kitchenStatus: (payload.kitchenStatus as KitchenStatus) ?? KitchenStatus.NEW,
          subtotalPaise: Number(payload.subtotalPaise ?? 0),
          notes: (payload.notes as string | null) ?? null,
          acknowledgedAt: null,
          acknowledgedByMembershipId: null,
          acknowledgedByName: null,
          acceptedAt: null,
          readyAt: null,
          servedAt: null,
          createdAt: createdIso,
          updatedAt: createdIso,
          items: Array.isArray(payload.items)
            ? (payload.items as Array<Record<string, unknown>>).map((item, idx) => ({
                id: String(item.id ?? `${row.aggregateId}-${idx}`),
                menuItemId: String(item.menuItemId ?? ''),
                itemNameSnapshot: String(item.itemNameSnapshot ?? 'Dish'),
                dietaryTypeSnapshot: (item.dietaryTypeSnapshot as DietaryType) ?? DietaryType.VEG,
                quantity: Number(item.quantity ?? 1),
                modifiersSnapshotJson:
                  (item.modifiersSnapshotJson as KdsTicketModifierSnapshot[]) ?? [],
                prepNotes: (item.prepNotes as string | null) ?? null,
                status: String(item.status ?? 'ACTIVE'),
              }))
            : [],
        };
      }
    }

    return null;
  }

  private async markSent(outboxId: string): Promise<void> {
    await this.prisma.runAsSystemAdmin((adminDb) =>
      adminDb.outboxEvent.update({
        where: { id: outboxId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          lastError: null,
        },
      }),
    );
  }

  private async markFailedOrRetry(
    outboxId: string,
    currentRetryCount: number,
    err: unknown,
  ): Promise<void> {
    const nextRetry = currentRetryCount + 1;
    const exhausted = nextRetry >= MAX_OUTBOX_RETRIES;
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(currentRetryCount, 6));
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 480);

    await this.prisma.runAsSystemAdmin((adminDb) =>
      adminDb.outboxEvent.update({
        where: { id: outboxId },
        data: {
          status: exhausted ? 'FAILED' : 'PENDING',
          retryCount: nextRetry,
          availableAt: exhausted ? new Date() : new Date(Date.now() + delayMs),
          lastError: message,
        },
      }),
    );
  }

  async processPendingBatch(batchSize = DEFAULT_BATCH_SIZE): Promise<{
    claimed: number;
    dispatched: number;
    failed: number;
  }> {
    if (this.isProcessing) {
      return { claimed: 0, dispatched: 0, failed: 0 };
    }
    this.isProcessing = true;

    let dispatched = 0;
    let failed = 0;

    try {
      const claimedRows = await this.claimPendingBatch(batchSize);
      for (const row of claimedRows) {
        try {
          if (
            row.topic === 'order.created' ||
            row.topic === 'kot.acknowledged' ||
            row.topic === 'kot.updated'
          ) {
            const ticket = await this.resolveTicketPayload(row);
            if (!ticket) {
              throw new Error(`Missing KDS ticket payload for outbox event ${row.id}`);
            }

            const envelope: KdsEventEnvelope = {
              eventId: row.id,
              topic: row.topic as KdsOutboxTopic,
              tenantId: row.tenantId,
              outletId: ticket.outletId,
              aggregateId: row.aggregateId,
              createdAt:
                row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
              ticket,
            };

            this.kitchenGateway.emitKdsEvent(envelope);
          } else if (row.topic === 'session.updated' || row.topic === 'session.closed') {
            const payload = (row.payloadJson ?? {}) as Record<string, unknown>;
            const outletId = typeof payload.outletId === 'string' ? payload.outletId : '';
            const tableId = typeof payload.tableId === 'string' ? payload.tableId : '';
            if (!outletId || !tableId) {
              throw new Error(`Missing floor session metadata for outbox event ${row.id}`);
            }

            const status = (payload.status as DiningSessionStatus) ?? DiningSessionStatus.ACTIVE;
            const envelope: FloorEventEnvelope = {
              eventId: row.id,
              topic: row.topic as SessionOutboxTopic,
              tenantId: row.tenantId,
              outletId,
              sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : row.aggregateId,
              tableId,
              status,
              lifecycleStage:
                (payload.lifecycleStage as SessionLifecycleStage) ??
                mapSessionStatusToStage(status),
              createdAt:
                row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
            };

            this.kitchenGateway.emitFloorEvent(envelope);
          } else if (
            row.topic === 'bill.generated' ||
            row.topic === 'bill.updated' ||
            row.topic === 'payment.succeeded' ||
            row.topic === 'payment.failed' ||
            row.topic === 'refund.processed'
          ) {
            const payload = (row.payloadJson ?? {}) as Record<string, unknown>;
            const outletId = typeof payload.outletId === 'string' ? payload.outletId : '';
            if (!outletId) {
              throw new Error(`Missing outletId metadata for billing outbox event ${row.id}`);
            }

            this.kitchenGateway.emitBillingEvent({
              eventId: row.id,
              topic: row.topic,
              tenantId: row.tenantId,
              outletId,
              aggregateType: row.aggregateType,
              aggregateId: row.aggregateId,
              payload,
              createdAt:
                row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
            });
          }

          await this.markSent(row.id);
          dispatched += 1;
        } catch (err) {
          failed += 1;
          await this.markFailedOrRetry(row.id, row.retryCount, err);
        }
      }

      return {
        claimed: claimedRows.length,
        dispatched,
        failed,
      };
    } finally {
      this.isProcessing = false;
    }
  }
}

