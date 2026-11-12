import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '@autonex/shared';
import { ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@autonex/shared';
import { PaymentProvider, PaymentStatus } from '@prisma/client';
import type { EnvConfig } from '../../common/config/env.validation';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentsService } from './payments.service';
import { RazorpayClientService } from './razorpay-client.service';

const STALE_TIMEOUT_FAIL_MINUTES = 15;
const RECONCILE_INTERVAL_MS = 60_000;

@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLoggerService(ReconciliationService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<EnvConfig, true>,
    private readonly razorpayClient: RazorpayClientService,
    private readonly paymentsService: PaymentsService,
  ) {}

  onModuleInit(): void {
    const nodeEnv = this.configService.get('NODE_ENV', { infer: true });
    if (nodeEnv === 'test') return;

    this.timer = setInterval(() => {
      void this.reconcileStaleAttempts().catch((err) => {
        this.logger.error(
          `Payment reconciliation loop error: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
          ReconciliationService.name,
        );
      });
    }, RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async reconcileStaleAttempts(outletFilterId?: string): Promise<{
    scanned: number;
    capturedCount: number;
    failedCount: number;
    stillPendingCount: number;
  }> {
    if (this.running) {
      return { scanned: 0, capturedCount: 0, failedCount: 0, stillPendingCount: 0 };
    }
    this.running = true;

    let scanned = 0;
    let capturedCount = 0;
    let failedCount = 0;
    let stillPendingCount = 0;

    try {
      const staleMinutes = Number(
        this.configService.get('PAYMENT_RECONCILE_STALE_MINUTES', { infer: true }) ?? 2,
      );
      const staleBefore = new Date(Date.now() - staleMinutes * 60_000);
      const expiryBefore = new Date(Date.now() - STALE_TIMEOUT_FAIL_MINUTES * 60_000);

      const candidates = await this.prisma.runAsSystemAdmin((adminDb) =>
        adminDb.paymentAttempt.findMany({
          where: {
            provider: PaymentProvider.RAZORPAY,
            status: { in: [PaymentStatus.INITIATED, PaymentStatus.PENDING] },
            createdAt: { lte: staleBefore },
            ...(outletFilterId ? { outletId: outletFilterId } : {}),
          },
          take: 50,
          orderBy: { createdAt: 'asc' },
        }),
      );

      scanned = candidates.length;

      for (const attempt of candidates) {
        const snapshots = attempt.gatewayOrderId
          ? await this.razorpayClient.fetchOrderPayments(attempt.gatewayOrderId)
          : [];

        const capturedSnap = snapshots.find((s) => s.status === 'captured');
        const allFailed =
          snapshots.length > 0 && snapshots.every((s) => s.status === 'failed');

        if (capturedSnap) {
          await this.prisma.runInTenantTx(async (tx) => {
            await tx.paymentAttempt.update({
              where: { id: attempt.id },
              data: {
                reconcileAttempts: attempt.reconcileAttempts + 1,
                lastReconciledAt: new Date(),
              },
            });
            await this.paymentsService.applyPaymentSuccessTx(tx, {
              tenantId: attempt.tenantId,
              outletId: attempt.outletId,
              attemptId: attempt.id,
              gatewayPaymentId: capturedSnap.id,
              receiptRef: capturedSnap.id,
              confirmedByMembershipId: null,
              actorUserId: attempt.tenantId,
              actorRole: 'RECONCILER',
              ipAddress: null,
            });
          }, attempt.tenantId);
          capturedCount += 1;
        } else if (allFailed || attempt.createdAt <= expiryBefore) {
          const reason =
            snapshots.find((s) => s.error_description)?.error_description ||
            'Payment timed out or abandoned before completion';

          await this.prisma.runInTenantTx(async (tx) => {
            await tx.paymentAttempt.update({
              where: { id: attempt.id },
              data: {
                reconcileAttempts: attempt.reconcileAttempts + 1,
                lastReconciledAt: new Date(),
              },
            });
            await this.paymentsService.applyPaymentFailureTx(tx, {
              tenantId: attempt.tenantId,
              outletId: attempt.outletId,
              attemptId: attempt.id,
              failureReason: reason,
              actorUserId: attempt.tenantId,
              actorRole: 'RECONCILER',
              ipAddress: null,
            });
          }, attempt.tenantId);
          failedCount += 1;
        } else {
          await this.prisma.runInTenantTx(
            (tx) =>
              tx.paymentAttempt.update({
                where: { id: attempt.id },
                data: {
                  reconcileAttempts: attempt.reconcileAttempts + 1,
                  lastReconciledAt: new Date(),
                },
              }),
            attempt.tenantId,
          );
          stillPendingCount += 1;
        }
      }

      return { scanned, capturedCount, failedCount, stillPendingCount };
    } finally {
      this.running = false;
    }
  }

  async runManualReconcile(principal: AuthenticatedPrincipal) {
    const ctx = requireOutletContext(principal);
    if (
      ![StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER].includes(
        ctx.role as StaffRole,
      )
    ) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can run payment reconciliation.',
      });
    }
    return this.reconcileStaleAttempts(ctx.outletId);
  }
}

