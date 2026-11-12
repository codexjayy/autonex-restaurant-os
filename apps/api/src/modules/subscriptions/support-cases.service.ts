import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ErrorCode,
  formatSupportCaseNumber,
  SupportCaseCategory,
  SupportCaseDto,
  SupportCasePriority,
  SupportCaseStatus,
} from '@autonex/shared';
import {
  SupportCaseCategory as PrismaSupportCaseCategory,
  SupportCasePriority as PrismaSupportCasePriority,
  SupportCaseStatus as PrismaSupportCaseStatus,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AddSupportNoteDto,
  CreateSupportCaseDto,
  UpdateSupportCaseDto,
} from './dto/subscriptions.dto';

@Injectable()
export class SupportCasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private mapCaseDto(
    row: {
      id: string;
      caseNumber: string;
      tenantId: string;
      outletId: string | null;
      category: string;
      priority: string;
      status: string;
      subject: string;
      description: string;
      resolutionNotes: string | null;
      resolvedAt: Date | null;
      closedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
      tenant?: { name: string } | null;
      notes?: Array<{
        id: string;
        authorUserId: string;
        authorRole: string;
        body: string;
        isInternal: boolean;
        createdAt: Date;
        authorUser?: { name: string } | null;
      }>;
    },
    includeInternalNotes: boolean,
  ): SupportCaseDto {
    return {
      id: row.id,
      caseNumber: row.caseNumber,
      tenantId: row.tenantId,
      tenantName: row.tenant?.name,
      outletId: row.outletId,
      category: row.category as SupportCaseCategory,
      priority: row.priority as SupportCasePriority,
      status: row.status as SupportCaseStatus,
      subject: row.subject,
      description: row.description,
      resolutionNotes: row.resolutionNotes,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      notes: row.notes
        ?.filter((note) => includeInternalNotes || !note.isInternal)
        .map((note) => ({
          id: note.id,
          authorUserId: note.authorUserId,
          authorRole: note.authorRole,
          authorName: note.authorUser?.name,
          body: note.body,
          isInternal: note.isInternal,
          createdAt: note.createdAt.toISOString(),
        })),
    };
  }

  async listTenantSupportCases(principal: AuthenticatedPrincipal): Promise<SupportCaseDto[]> {
    const ctx = requireOutletContext(principal);
    const cases = await this.prisma.runInTenantTx(
      (tx) =>
        tx.supportCase.findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: { createdAt: 'desc' },
          include: {
            notes: {
              where: { isInternal: false },
              orderBy: { createdAt: 'asc' },
              include: { authorUser: { select: { name: true } } },
            },
          },
        }),
      ctx.tenantId,
    );

    return cases.map((c) => this.mapCaseDto(c, false));
  }

  async getTenantSupportCase(
    principal: AuthenticatedPrincipal,
    caseId: string,
  ): Promise<SupportCaseDto> {
    const ctx = requireOutletContext(principal);
    const found = await this.prisma.runInTenantTx(
      (tx) =>
        tx.supportCase.findFirst({
          where: { id: caseId, tenantId: ctx.tenantId },
          include: {
            notes: {
              where: { isInternal: false },
              orderBy: { createdAt: 'asc' },
              include: { authorUser: { select: { name: true } } },
            },
          },
        }),
      ctx.tenantId,
    );

    if (!found) {
      throw new NotFoundException({
        code: ErrorCode.SUPPORT_CASE_NOT_FOUND,
        message: 'Support case not found.',
      });
    }

    return this.mapCaseDto(found, false);
  }

  async createTenantSupportCase(
    principal: AuthenticatedPrincipal,
    dto: CreateSupportCaseDto,
  ): Promise<SupportCaseDto> {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;
    const existingCount = await this.prisma.runAsSystemAdmin((db) => db.supportCase.count());

    const created = await this.prisma.runInTenantTx(async (tx) => {
      if (dto.outletId) {
        const outlet = await tx.outlet.findFirst({
          where: { id: dto.outletId, tenantId: ctx.tenantId },
          select: { id: true },
        });
        if (!outlet) {
          throw new BadRequestException({
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Specified outlet does not belong to your restaurant.',
          });
        }
      }

      const caseNumber = formatSupportCaseNumber(existingCount + 1);

      const row = await tx.supportCase.create({
        data: {
          caseNumber,
          tenantId: ctx.tenantId,
          outletId: dto.outletId ?? ctx.outletId ?? null,
          createdByUserId: ctx.userId,
          category: (dto.category ?? SupportCaseCategory.TECHNICAL) as PrismaSupportCaseCategory,
          priority: (dto.priority ?? SupportCasePriority.MEDIUM) as PrismaSupportCasePriority,
          status: PrismaSupportCaseStatus.OPEN,
          subject: dto.subject.trim(),
          description: dto.description.trim(),
        },
        include: {
          notes: {
            where: { isInternal: false },
            orderBy: { createdAt: 'asc' },
            include: { authorUser: { select: { name: true } } },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'SUPPORT_CASE_CREATED',
          entityType: 'SupportCase',
          entityId: row.id,
          afterJson: {
            caseNumber: row.caseNumber,
            category: row.category,
            priority: row.priority,
            subject: row.subject,
          },
          ipAddress,
        },
      });

      return row;
    }, ctx.tenantId);

    return this.mapCaseDto(created, false);
  }

  async addTenantSupportNote(
    principal: AuthenticatedPrincipal,
    caseId: string,
    dto: AddSupportNoteDto,
  ) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.supportCase.findFirst({
        where: { id: caseId, tenantId: ctx.tenantId },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.SUPPORT_CASE_NOT_FOUND,
          message: 'Support case not found.',
        });
      }

      const note = await tx.supportCaseNote.create({
        data: {
          tenantId: ctx.tenantId,
          supportCaseId: existing.id,
          authorUserId: ctx.userId,
          authorRole: ctx.role,
          body: dto.body.trim(),
          isInternal: false, // Tenants can never author or view internal notes
        },
        include: { authorUser: { select: { name: true } } },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'SUPPORT_CASE_NOTE_ADDED',
          entityType: 'SupportCaseNote',
          entityId: note.id,
          afterJson: {
            caseId: existing.id,
            caseNumber: existing.caseNumber,
            isInternal: false,
          },
          ipAddress,
        },
      });

      return {
        id: note.id,
        authorUserId: note.authorUserId,
        authorRole: note.authorRole,
        authorName: note.authorUser?.name,
        body: note.body,
        isInternal: false,
        createdAt: note.createdAt.toISOString(),
      };
    }, ctx.tenantId);
  }

  // ============================================================================
  // SUPER ADMIN METHODS
  // ============================================================================

  async listAdminSupportCases(filters: {
    status?: string;
    priority?: string;
    tenantId?: string;
    limit?: number;
  }): Promise<SupportCaseDto[]> {
    const cases = await this.prisma.runAsSystemAdmin((db) =>
      db.supportCase.findMany({
        where: {
          ...(filters.status ? { status: filters.status as PrismaSupportCaseStatus } : {}),
          ...(filters.priority ? { priority: filters.priority as PrismaSupportCasePriority } : {}),
          ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: Math.min(Math.max(filters.limit ?? 100, 1), 250),
        include: {
          tenant: { select: { name: true } },
          notes: {
            orderBy: { createdAt: 'asc' },
            include: { authorUser: { select: { name: true } } },
          },
        },
      }),
    );

    return cases.map((c) => this.mapCaseDto(c, true));
  }

  async getAdminSupportCase(caseId: string): Promise<SupportCaseDto> {
    const found = await this.prisma.runAsSystemAdmin((db) =>
      db.supportCase.findUnique({
        where: { id: caseId },
        include: {
          tenant: { select: { name: true } },
          notes: {
            orderBy: { createdAt: 'asc' },
            include: { authorUser: { select: { name: true } } },
          },
        },
      }),
    );

    if (!found) {
      throw new NotFoundException({
        code: ErrorCode.SUPPORT_CASE_NOT_FOUND,
        message: 'Support case not found.',
      });
    }

    return this.mapCaseDto(found, true);
  }

  async updateAdminSupportCase(
    principal: AuthenticatedPrincipal,
    caseId: string,
    dto: UpdateSupportCaseDto,
  ): Promise<SupportCaseDto> {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const updated = await this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const existing = await tx.supportCase.findUnique({
          where: { id: caseId },
        });
        if (!existing) {
          throw new NotFoundException({
            code: ErrorCode.SUPPORT_CASE_NOT_FOUND,
            message: 'Support case not found.',
          });
        }

        const now = new Date();
        const nextStatus = (dto.status ?? existing.status) as PrismaSupportCaseStatus;
        const resolvedAt =
          nextStatus === PrismaSupportCaseStatus.RESOLVED && !existing.resolvedAt
            ? now
            : existing.resolvedAt;
        const closedAt =
          nextStatus === PrismaSupportCaseStatus.CLOSED && !existing.closedAt
            ? now
            : existing.closedAt;

        const saved = await tx.supportCase.update({
          where: { id: caseId },
          data: {
            status: nextStatus,
            priority: (dto.priority ?? existing.priority) as PrismaSupportCasePriority,
            assignedToUserId:
              dto.assignedToUserId !== undefined ? dto.assignedToUserId : existing.assignedToUserId,
            resolutionNotes:
              dto.resolutionNotes !== undefined
                ? dto.resolutionNotes.trim() || null
                : existing.resolutionNotes,
            resolvedAt,
            closedAt,
          },
          include: {
            tenant: { select: { name: true } },
            notes: {
              orderBy: { createdAt: 'asc' },
              include: { authorUser: { select: { name: true } } },
            },
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: existing.tenantId,
            actorUserId: principal.userId,
            actorRole: principal.role,
            action: 'SUPPORT_CASE_UPDATED',
            entityType: 'SupportCase',
            entityId: existing.id,
            beforeJson: {
              status: existing.status,
              priority: existing.priority,
              assignedToUserId: existing.assignedToUserId,
            },
            afterJson: {
              status: saved.status,
              priority: saved.priority,
              assignedToUserId: saved.assignedToUserId,
              resolutionNotes: saved.resolutionNotes,
            },
            ipAddress,
          },
        });

        return saved;
      }),
    );

    return this.mapCaseDto(updated, true);
  }

  async addAdminSupportNote(
    principal: AuthenticatedPrincipal,
    caseId: string,
    dto: AddSupportNoteDto,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const existing = await tx.supportCase.findUnique({ where: { id: caseId } });
        if (!existing) {
          throw new NotFoundException({
            code: ErrorCode.SUPPORT_CASE_NOT_FOUND,
            message: 'Support case not found.',
          });
        }

        const isInternal = Boolean(dto.isInternal);
        const note = await tx.supportCaseNote.create({
          data: {
            tenantId: existing.tenantId,
            supportCaseId: existing.id,
            authorUserId: principal.userId,
            authorRole: principal.role,
            body: dto.body.trim(),
            isInternal,
          },
          include: { authorUser: { select: { name: true } } },
        });

        if (!isInternal && existing.status === PrismaSupportCaseStatus.OPEN) {
          await tx.supportCase.update({
            where: { id: existing.id },
            data: { status: PrismaSupportCaseStatus.IN_PROGRESS },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId: existing.tenantId,
            actorUserId: principal.userId,
            actorRole: principal.role,
            action: 'SUPPORT_CASE_NOTE_ADDED',
            entityType: 'SupportCaseNote',
            entityId: note.id,
            afterJson: {
              caseId: existing.id,
              caseNumber: existing.caseNumber,
              isInternal,
            },
            ipAddress,
          },
        });

        return {
          id: note.id,
          authorUserId: note.authorUserId,
          authorRole: note.authorRole,
          authorName: note.authorUser?.name,
          body: note.body,
          isInternal: note.isInternal,
          createdAt: note.createdAt.toISOString(),
        };
      }),
    );
  }
}
