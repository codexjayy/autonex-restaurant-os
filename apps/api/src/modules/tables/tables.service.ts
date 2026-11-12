import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiningSessionStatus, ErrorCode } from '@autonex/shared';
import type { Prisma } from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  decryptQrToken,
  encryptQrToken,
  generateQrToken,
  sha256Hex,
} from '../../common/security/crypto.util';
import { CreateTableDto, UpdateTableDto } from './dto/table.dto';
import { QrPdfService } from './qr-pdf.service';

export interface ResolvedQrTable {
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  outlet_id: string;
  outlet_name: string;
  outlet_address: string | null;
  outlet_logo_url: string | null;
  table_id: string;
  table_number: string;
  table_label: string | null;
  qr_version: number;
  require_waiter_approval: boolean;
  table_pin_enabled: boolean;
}

const RAW_QR_TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;

@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly qrPdfService: QrPdfService,
  ) {}

  private getQrSecret(): string {
    return this.configService.get<string>('QR_SIGNING_SECRET') ?? '';
  }

  private getAppUrl(): string {
    return (this.configService.get<string>('APP_URL') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
  }

  private serializeTableWithQr<
    T extends {
      id: string;
      tableNumber: string;
      label: string | null;
      capacity: number;
      status: string;
      isActive: boolean;
      createdAt: Date;
      updatedAt: Date;
      qrTokens: Array<{
        id: string;
        qrVersion: number;
        tokenEnc: string;
        isActive: boolean;
        createdAt: Date;
      }>;
    },
  >(table: T) {
    const activeToken = table.qrTokens[0];
    let activeQr: {
      id: string;
      qrVersion: number;
      qrUrl: string;
      createdAt: Date;
    } | null = null;

    if (activeToken) {
      const rawToken = decryptQrToken(activeToken.tokenEnc, this.getQrSecret());
      activeQr = {
        id: activeToken.id,
        qrVersion: activeToken.qrVersion,
        qrUrl: this.qrPdfService.buildQrUrl(this.getAppUrl(), rawToken),
        createdAt: activeToken.createdAt,
      };
    }

    return {
      id: table.id,
      tableNumber: table.tableNumber,
      label: table.label,
      capacity: table.capacity,
      status: table.status,
      isActive: table.isActive,
      createdAt: table.createdAt,
      updatedAt: table.updatedAt,
      activeQr,
    };
  }

  private async issueQrTokenTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    outletId: string,
    tableId: string,
    qrVersion: number,
  ) {
    const rawToken = generateQrToken();
    const tokenHash = sha256Hex(rawToken);
    const tokenEnc = encryptQrToken(rawToken, this.getQrSecret());

    return tx.tableQrToken.create({
      data: {
        tenantId,
        outletId,
        tableId,
        tokenHash,
        tokenEnc,
        qrVersion,
        isActive: true,
      },
    });
  }

  async listTables(principal: AuthenticatedPrincipal) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const tables = await tx.restaurantTable.findMany({
        where: { outletId: ctx.outletId },
        orderBy: { tableNumber: 'asc' },
        include: {
          qrTokens: {
            where: { isActive: true, revokedAt: null },
            orderBy: { qrVersion: 'desc' },
            take: 1,
          },
        },
      });

      return tables.map((t) => this.serializeTableWithQr(t));
    }, ctx.tenantId);
  }

  async createTable(principal: AuthenticatedPrincipal, dto: CreateTableDto) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      let table;
      try {
        table = await tx.restaurantTable.create({
          data: {
            tenantId: ctx.tenantId,
            outletId: ctx.outletId,
            tableNumber: dto.tableNumber.trim(),
            label: dto.label?.trim() || null,
            capacity: dto.capacity ?? 4,
            isActive: dto.isActive ?? true,
          },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: `Table "${dto.tableNumber.trim()}" already exists in this outlet.`,
          });
        }
        throw err;
      }

      const qrToken = await this.issueQrTokenTx(tx, ctx.tenantId, ctx.outletId, table.id, 1);

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'TABLE_CREATED',
          entityType: 'RestaurantTable',
          entityId: table.id,
          afterJson: {
            tableNumber: table.tableNumber,
            capacity: table.capacity,
            qrVersion: qrToken.qrVersion,
          },
          ipAddress,
        },
      });

      return this.serializeTableWithQr({
        ...table,
        qrTokens: [qrToken],
      });
    }, ctx.tenantId);
  }

  async updateTable(principal: AuthenticatedPrincipal, tableId: string, dto: UpdateTableDto) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.restaurantTable.findFirst({
        where: { id: tableId, outletId: ctx.outletId },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Table not found.',
        });
      }

      let updated;
      try {
        updated = await tx.restaurantTable.update({
          where: { id: existing.id },
          data: {
            ...(dto.tableNumber !== undefined ? { tableNumber: dto.tableNumber.trim() } : {}),
            ...(dto.label !== undefined ? { label: dto.label?.trim() || null } : {}),
            ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          include: {
            qrTokens: {
              where: { isActive: true, revokedAt: null },
              orderBy: { qrVersion: 'desc' },
              take: 1,
            },
          },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: `Table "${dto.tableNumber?.trim()}" already exists in this outlet.`,
          });
        }
        throw err;
      }

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'TABLE_UPDATED',
          entityType: 'RestaurantTable',
          entityId: updated.id,
          beforeJson: {
            tableNumber: existing.tableNumber,
            capacity: existing.capacity,
            isActive: existing.isActive,
          },
          afterJson: {
            tableNumber: updated.tableNumber,
            capacity: updated.capacity,
            isActive: updated.isActive,
          },
          ipAddress,
        },
      });

      return this.serializeTableWithQr(updated);
    }, ctx.tenantId);
  }

  async rotateQrToken(principal: AuthenticatedPrincipal, tableId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const table = await tx.restaurantTable.findFirst({
        where: { id: tableId, outletId: ctx.outletId },
      });
      if (!table) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Table not found.',
        });
      }

      const maxAgg = await tx.tableQrToken.aggregate({
        where: { tableId: table.id },
        _max: { qrVersion: true },
      });
      const nextVersion = (maxAgg._max.qrVersion ?? 0) + 1;

      await tx.tableQrToken.updateMany({
        where: { tableId: table.id, isActive: true, revokedAt: null },
        data: { isActive: false, revokedAt: new Date() },
      });

      const nextQr = await this.issueQrTokenTx(
        tx,
        ctx.tenantId,
        ctx.outletId,
        table.id,
        nextVersion,
      );

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'TABLE_QR_ROTATED',
          entityType: 'TableQrToken',
          entityId: nextQr.id,
          afterJson: {
            tableId: table.id,
            tableNumber: table.tableNumber,
            qrVersion: nextVersion,
          },
          ipAddress,
        },
      });

      return this.serializeTableWithQr({
        ...table,
        qrTokens: [nextQr],
      });
    }, ctx.tenantId);
  }

  async revokeQrToken(principal: AuthenticatedPrincipal, tableId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const table = await tx.restaurantTable.findFirst({
        where: { id: tableId, outletId: ctx.outletId },
      });
      if (!table) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Table not found.',
        });
      }

      const result = await tx.tableQrToken.updateMany({
        where: { tableId: table.id, isActive: true, revokedAt: null },
        data: { isActive: false, revokedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'TABLE_QR_REVOKED',
          entityType: 'RestaurantTable',
          entityId: table.id,
          afterJson: { revokedCount: result.count },
          ipAddress,
        },
      });

      return { revoked: true, tableId: table.id, revokedCount: result.count };
    }, ctx.tenantId);
  }

  async deleteTable(principal: AuthenticatedPrincipal, tableId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const table = await tx.restaurantTable.findFirst({
        where: { id: tableId, outletId: ctx.outletId },
      });
      if (!table) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Table not found.',
        });
      }

      await tx.restaurantTable.delete({ where: { id: table.id } });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'TABLE_DELETED',
          entityType: 'RestaurantTable',
          entityId: table.id,
          beforeJson: { tableNumber: table.tableNumber },
          ipAddress,
        },
      });

      return { deleted: true, id: table.id };
    }, ctx.tenantId);
  }

  async getSingleTableQrPdf(principal: AuthenticatedPrincipal, tableId: string) {
    const ctx = requireOutletContext(principal);

    const card = await this.prisma.runInTenantTx(async (tx) => {
      const outlet = await tx.outlet.findFirst({
        where: { id: ctx.outletId },
        select: { name: true },
      });
      const table = await tx.restaurantTable.findFirst({
        where: { id: tableId, outletId: ctx.outletId },
        include: {
          qrTokens: {
            where: { isActive: true, revokedAt: null },
            orderBy: { qrVersion: 'desc' },
            take: 1,
          },
        },
      });

      if (!outlet || !table) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Table not found.',
        });
      }

      const activeToken = table.qrTokens[0];
      if (!activeToken) {
        throw new BadRequestException({
          code: ErrorCode.INVALID_QR_TOKEN,
          message: 'This table has no active QR code. Generate/rotate one first.',
        });
      }

      const rawToken = decryptQrToken(activeToken.tokenEnc, this.getQrSecret());
      return {
        outletName: outlet.name,
        tableNumber: table.tableNumber,
        label: table.label,
        qrVersion: activeToken.qrVersion,
        qrUrl: this.qrPdfService.buildQrUrl(this.getAppUrl(), rawToken),
      };
    }, ctx.tenantId);

    const buffer = await this.qrPdfService.buildSingleTableQrPdf(card);
    const safeNum = card.tableNumber.replace(/[^a-zA-Z0-9_-]+/g, '-');
    return {
      filename: `autonex-table-${safeNum}-qr.pdf`,
      buffer,
    };
  }

  async getBulkTableQrPdf(principal: AuthenticatedPrincipal) {
    const ctx = requireOutletContext(principal);

    const cards = await this.prisma.runInTenantTx(async (tx) => {
      const outlet = await tx.outlet.findFirst({
        where: { id: ctx.outletId },
        select: { name: true },
      });
      if (!outlet) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Outlet not found.',
        });
      }

      const tables = await tx.restaurantTable.findMany({
        where: { outletId: ctx.outletId, isActive: true },
        orderBy: { tableNumber: 'asc' },
        include: {
          qrTokens: {
            where: { isActive: true, revokedAt: null },
            orderBy: { qrVersion: 'desc' },
            take: 1,
          },
        },
      });

      const secret = this.getQrSecret();
      const appUrl = this.getAppUrl();

      return tables
        .filter((t) => t.qrTokens.length > 0)
        .map((t) => {
          const activeToken = t.qrTokens[0]!;
          const rawToken = decryptQrToken(activeToken.tokenEnc, secret);
          return {
            outletName: outlet.name,
            tableNumber: t.tableNumber,
            label: t.label,
            qrVersion: activeToken.qrVersion,
            qrUrl: this.qrPdfService.buildQrUrl(appUrl, rawToken),
          };
        });
    }, ctx.tenantId);

    if (cards.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_QR_TOKEN,
        message: 'No active tables with active QR tokens found.',
      });
    }

    const buffer = await this.qrPdfService.buildBulkTableQrPdf(cards);
    return {
      filename: 'autonex-all-table-qr-codes.pdf',
      buffer,
    };
  }

  /**
   * Validates opaque QR token format, hashes via SHA-256, and invokes
   * SECURITY DEFINER `resolve_qr_token_hash()` (enforces active, non-revoked, valid tenant).
   */
  async verifyQrTokenAndGetTable(rawToken: string): Promise<ResolvedQrTable> {
    if (!RAW_QR_TOKEN_REGEX.test(rawToken)) {
      throw new NotFoundException({
        code: ErrorCode.INVALID_QR_TOKEN,
        message: 'Invalid or expired table QR code.',
      });
    }

    const tokenHash = sha256Hex(rawToken);
    const rows = await this.prisma.appClient.$queryRaw<ResolvedQrTable[]>`
      SELECT * FROM resolve_qr_token_hash(${tokenHash})
    `;

    const resolved = rows[0];
    if (!resolved) {
      throw new NotFoundException({
        code: ErrorCode.INVALID_QR_TOKEN,
        message: 'This QR code is invalid, revoked, or unavailable.',
      });
    }
    return resolved;
  }

  /**
   * Public read-only QR resolution:
   * - Validates opaque token via verifyQrTokenAndGetTable()
   * - Reads active menu categories/items AND checks current active session metadata under strict RLS
   * - NEVER creates a dining session on QR scan alone
   */
  async resolvePublicQr(rawToken: string) {
    const resolved = await this.verifyQrTokenAndGetTable(rawToken);

    const { menuCategories, activeSession } = await this.prisma.runInTenantTx(async (tx) => {
      const [categories, session] = await Promise.all([
        tx.category.findMany({
          where: { outletId: resolved.outlet_id, isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            sortOrder: true,
            menuItems: {
              where: { isActive: true },
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
              select: {
                id: true,
                name: true,
                description: true,
                dietaryType: true,
                basePricePaise: true,
                imageUrl: true,
                inStock: true,
                sortOrder: true,
                modifierGroups: {
                  orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                  select: {
                    id: true,
                    name: true,
                    selectionType: true,
                    isRequired: true,
                    minSelect: true,
                    maxSelect: true,
                    sortOrder: true,
                    options: {
                      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                      select: {
                        id: true,
                        name: true,
                        priceDeltaPaise: true,
                        inStock: true,
                        isDefault: true,
                        sortOrder: true,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        tx.diningSession.findFirst({
          where: {
            tableId: resolved.table_id,
            status: { not: DiningSessionStatus.CLOSED },
          },
          select: {
            id: true,
            status: true,
            openedAt: true,
          },
        }),
      ]);

      return { menuCategories: categories, activeSession: session };
    }, resolved.tenant_id);

    const orderingBlocked =
      resolved.tenant_status === 'LOCKED' || resolved.tenant_status === 'SUSPENDED';

    return {
      restaurant: {
        name: resolved.tenant_name,
        outletName: resolved.outlet_name,
        address: resolved.outlet_address,
        logoUrl: resolved.outlet_logo_url,
      },
      table: {
        id: resolved.table_id,
        tableNumber: resolved.table_number,
        label: resolved.table_label,
        qrVersion: resolved.qr_version,
      },
      tenantStatus: resolved.tenant_status,
      orderingBlocked,
      sessionPolicy: {
        sessionCreatedOnScan: false,
        hasActiveSession: Boolean(activeSession),
        activeSessionStatus: activeSession?.status ?? null,
        requireWaiterApproval: resolved.require_waiter_approval,
        tablePinEnabled: resolved.table_pin_enabled,
        orderingBlocked,
      },
      categories: menuCategories.filter((cat) => cat.menuItems.length > 0),
    };
  }
}
