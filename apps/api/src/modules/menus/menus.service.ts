import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DietaryType, ErrorCode, SelectionType } from '@autonex/shared';
import {
  DietaryType as PrismaDietaryType,
  Prisma,
  SelectionType as PrismaSelectionType,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import {
  CreateMenuItemDto,
  ModifierGroupInputDto,
  UpdateMenuItemDto,
} from './dto/menu-item.dto';

interface NormalizedModifierGroup {
  name: string;
  selectionType: SelectionType;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  options: Array<{
    name: string;
    priceDeltaPaise: number;
    inStock: boolean;
    isDefault: boolean;
    sortOrder: number;
  }>;
}

@Injectable()
export class MenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Server-side integer paise and modifier cardinality validation.
   * Ensures base prices and any modifier adjustments never produce negative prices
   * and min/max selection bounds match the group's selectionType and options count.
   */
  validateAndNormalizePricing(
    basePricePaise: number,
    groups: ModifierGroupInputDto[] = [],
  ): NormalizedModifierGroup[] {
    if (!Number.isInteger(basePricePaise) || basePricePaise < 0) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_PRICE,
        message: 'basePricePaise must be a non-negative integer in paise.',
      });
    }

    return groups.map((group, groupIdx) => {
      if (!group.options || group.options.length === 0) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: `Modifier group "${group.name}" must contain at least one option.`,
        });
      }

      const isRequired = group.isRequired ?? false;
      const selectionType = group.selectionType;
      const minSelect = group.minSelect ?? (isRequired ? 1 : 0);
      const maxSelect =
        group.maxSelect ?? (selectionType === SelectionType.SINGLE ? 1 : group.options.length);

      if (selectionType === SelectionType.SINGLE && maxSelect !== 1) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: `SINGLE modifier group "${group.name}" must have maxSelect = 1.`,
        });
      }

      if (isRequired && minSelect < 1) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: `Required modifier group "${group.name}" must require at least 1 selection.`,
        });
      }

      if (minSelect < 0 || maxSelect < 1 || minSelect > maxSelect || maxSelect > group.options.length) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: `Modifier group "${group.name}" has invalid selection bounds (${minSelect}..${maxSelect} across ${group.options.length} options).`,
        });
      }

      const normalizedOptions = group.options.map((opt, optIdx) => {
        if (!Number.isInteger(opt.priceDeltaPaise)) {
          throw new BadRequestException({
            code: ErrorCode.INVALID_PRICE,
            message: `Option "${opt.name}" priceDeltaPaise must be an integer.`,
          });
        }
        if (basePricePaise + opt.priceDeltaPaise < 0) {
          throw new BadRequestException({
            code: ErrorCode.INVALID_PRICE,
            message: `Option "${opt.name}" discount cannot make total item price negative.`,
          });
        }

        return {
          name: opt.name.trim(),
          priceDeltaPaise: opt.priceDeltaPaise,
          inStock: opt.inStock ?? true,
          isDefault: opt.isDefault ?? false,
          sortOrder: opt.sortOrder ?? optIdx,
        };
      });

      return {
        name: group.name.trim(),
        selectionType,
        isRequired,
        minSelect,
        maxSelect,
        sortOrder: group.sortOrder ?? groupIdx,
        options: normalizedOptions,
      };
    });
  }

  private buildModifierGroupNestedCreate(
    tenantId: string,
    groups: NormalizedModifierGroup[],
  ): Prisma.ModifierGroupCreateWithoutMenuItemInput[] {
    return groups.map((group) => ({
      tenant: { connect: { id: tenantId } },
      name: group.name,
      selectionType: group.selectionType as PrismaSelectionType,
      isRequired: group.isRequired,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      sortOrder: group.sortOrder,
      options: {
        create: group.options.map((opt) => ({
          tenantId,
          name: opt.name,
          priceDeltaPaise: opt.priceDeltaPaise,
          inStock: opt.inStock,
          isDefault: opt.isDefault,
          sortOrder: opt.sortOrder,
        })),
      },
    }));
  }

  async getFullMenu(principal: AuthenticatedPrincipal) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const categories = await tx.category.findMany({
        where: { outletId: ctx.outletId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          menuItems: {
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            include: {
              modifierGroups: {
                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                include: {
                  options: {
                    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                  },
                },
              },
            },
          },
        },
      });

      return { categories };
    }, ctx.tenantId);
  }

  async listCategories(principal: AuthenticatedPrincipal) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      return tx.category.findMany({
        where: { outletId: ctx.outletId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { menuItems: true } } },
      });
    }, ctx.tenantId);
  }

  async createCategory(principal: AuthenticatedPrincipal, dto: CreateCategoryDto) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      try {
        const category = await tx.category.create({
          data: {
            tenantId: ctx.tenantId,
            outletId: ctx.outletId,
            name: dto.name.trim(),
            sortOrder: dto.sortOrder ?? 0,
            isActive: dto.isActive ?? true,
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'CATEGORY_CREATED',
            entityType: 'Category',
            entityId: category.id,
            afterJson: { name: category.name, sortOrder: category.sortOrder },
            ipAddress,
          },
        });

        return category;
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: 'A category with this name already exists.',
          });
        }
        throw err;
      }
    }, ctx.tenantId);
  }

  async updateCategory(
    principal: AuthenticatedPrincipal,
    categoryId: string,
    dto: UpdateCategoryDto,
  ) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.category.findFirst({
        where: { id: categoryId, outletId: ctx.outletId },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Category not found.',
        });
      }

      try {
        return await tx.category.update({
          where: { id: existing.id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: 'A category with this name already exists.',
          });
        }
        throw err;
      }
    }, ctx.tenantId);
  }

  async reorderCategories(principal: AuthenticatedPrincipal, categoryIds: string[]) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const uniqueIds = Array.from(new Set(categoryIds));
      const found = await tx.category.findMany({
        where: { outletId: ctx.outletId, id: { in: uniqueIds } },
        select: { id: true },
      });
      if (found.length !== uniqueIds.length) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'One or more categories do not belong to this outlet.',
        });
      }

      await Promise.all(
        uniqueIds.map((id, index) =>
          tx.category.update({
            where: { id },
            data: { sortOrder: index },
          }),
        ),
      );

      return tx.category.findMany({
        where: { outletId: ctx.outletId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
    }, ctx.tenantId);
  }

  async deleteCategory(principal: AuthenticatedPrincipal, categoryId: string) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.category.findFirst({
        where: { id: categoryId, outletId: ctx.outletId },
        include: { _count: { select: { menuItems: true } } },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Category not found.',
        });
      }

      if (existing._count.menuItems > 0) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Cannot delete a category that still contains menu items.',
        });
      }

      await tx.category.delete({ where: { id: existing.id } });
      return { deleted: true, id: existing.id };
    }, ctx.tenantId);
  }

  async createMenuItem(principal: AuthenticatedPrincipal, dto: CreateMenuItemDto) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;
    const normalizedGroups = this.validateAndNormalizePricing(
      dto.basePricePaise,
      dto.modifierGroups ?? [],
    );

    return this.prisma.runInTenantTx(async (tx) => {
      const category = await tx.category.findFirst({
        where: { id: dto.categoryId, outletId: ctx.outletId },
      });
      if (!category) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Target category not found in this outlet.',
        });
      }

      const item = await tx.menuItem.create({
        data: {
          tenantId: ctx.tenantId,
          outletId: ctx.outletId,
          categoryId: category.id,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          dietaryType: (dto.dietaryType ?? DietaryType.VEG) as PrismaDietaryType,
          basePricePaise: dto.basePricePaise,
          imageUrl: dto.imageUrl && dto.imageUrl.trim() ? dto.imageUrl.trim() : null,
          inStock: dto.inStock ?? true,
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 0,
          ...(normalizedGroups.length > 0
            ? {
                modifierGroups: {
                  create: this.buildModifierGroupNestedCreate(ctx.tenantId, normalizedGroups),
                },
              }
            : {}),
        },
        include: {
          modifierGroups: {
            orderBy: { sortOrder: 'asc' },
            include: { options: { orderBy: { sortOrder: 'asc' } } },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'MENU_ITEM_CREATED',
          entityType: 'MenuItem',
          entityId: item.id,
          afterJson: {
            name: item.name,
            basePricePaise: item.basePricePaise,
            categoryId: item.categoryId,
          },
          ipAddress,
        },
      });

      return item;
    }, ctx.tenantId);
  }

  async updateMenuItem(
    principal: AuthenticatedPrincipal,
    itemId: string,
    dto: UpdateMenuItemDto,
  ) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.menuItem.findFirst({
        where: { id: itemId, outletId: ctx.outletId },
        include: {
          modifierGroups: {
            include: { options: true },
          },
        },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Menu item not found.',
        });
      }

      if (dto.categoryId && dto.categoryId !== existing.categoryId) {
        const category = await tx.category.findFirst({
          where: { id: dto.categoryId, outletId: ctx.outletId },
        });
        if (!category) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: 'Target category not found in this outlet.',
          });
        }
      }

      const effectiveBasePricePaise = dto.basePricePaise ?? existing.basePricePaise;
      const groupsToValidate: ModifierGroupInputDto[] =
        dto.modifierGroups ??
        existing.modifierGroups.map((g) => ({
          name: g.name,
          selectionType: g.selectionType as SelectionType,
          isRequired: g.isRequired,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          sortOrder: g.sortOrder,
          options: g.options.map((o) => ({
            name: o.name,
            priceDeltaPaise: o.priceDeltaPaise,
            inStock: o.inStock,
            isDefault: o.isDefault,
            sortOrder: o.sortOrder,
          })),
        }));

      const normalizedGroups = this.validateAndNormalizePricing(
        effectiveBasePricePaise,
        groupsToValidate,
      );

      if (dto.modifierGroups !== undefined) {
        await tx.modifierGroup.deleteMany({
          where: { menuItemId: existing.id, tenantId: ctx.tenantId },
        });
      }

      const updated = await tx.menuItem.update({
        where: { id: existing.id },
        data: {
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description?.trim() || null }
            : {}),
          ...(dto.dietaryType !== undefined
            ? { dietaryType: dto.dietaryType as PrismaDietaryType }
            : {}),
          ...(dto.basePricePaise !== undefined ? { basePricePaise: dto.basePricePaise } : {}),
          ...(dto.imageUrl !== undefined
            ? { imageUrl: dto.imageUrl && dto.imageUrl.trim() ? dto.imageUrl.trim() : null }
            : {}),
          ...(dto.inStock !== undefined ? { inStock: dto.inStock } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.modifierGroups !== undefined && normalizedGroups.length > 0
            ? {
                modifierGroups: {
                  create: this.buildModifierGroupNestedCreate(ctx.tenantId, normalizedGroups),
                },
              }
            : {}),
        },
        include: {
          modifierGroups: {
            orderBy: { sortOrder: 'asc' },
            include: { options: { orderBy: { sortOrder: 'asc' } } },
          },
        },
      });

      const priceChanged =
        dto.basePricePaise !== undefined && dto.basePricePaise !== existing.basePricePaise;

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: priceChanged ? 'MENU_ITEM_PRICE_UPDATED' : 'MENU_ITEM_UPDATED',
          entityType: 'MenuItem',
          entityId: updated.id,
          beforeJson: {
            name: existing.name,
            basePricePaise: existing.basePricePaise,
            inStock: existing.inStock,
          },
          afterJson: {
            name: updated.name,
            basePricePaise: updated.basePricePaise,
            inStock: updated.inStock,
          },
          ipAddress,
        },
      });

      return updated;
    }, ctx.tenantId);
  }

  async toggleItemStock(principal: AuthenticatedPrincipal, itemId: string, inStock: boolean) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.menuItem.findFirst({
        where: { id: itemId, outletId: ctx.outletId },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Menu item not found.',
        });
      }

      const updated = await tx.menuItem.update({
        where: { id: existing.id },
        data: { inStock },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'MENU_ITEM_STOCK_TOGGLED',
          entityType: 'MenuItem',
          entityId: updated.id,
          beforeJson: { inStock: existing.inStock },
          afterJson: { inStock: updated.inStock },
          ipAddress,
        },
      });

      return updated;
    }, ctx.tenantId);
  }

  async toggleModifierOptionStock(
    principal: AuthenticatedPrincipal,
    optionId: string,
    inStock: boolean,
  ) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const option = await tx.modifierOption.findFirst({
        where: {
          id: optionId,
          modifierGroup: { menuItem: { outletId: ctx.outletId } },
        },
      });
      if (!option) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Modifier option not found.',
        });
      }

      return tx.modifierOption.update({
        where: { id: option.id },
        data: { inStock },
      });
    }, ctx.tenantId);
  }

  async deleteMenuItem(principal: AuthenticatedPrincipal, itemId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.menuItem.findFirst({
        where: { id: itemId, outletId: ctx.outletId },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Menu item not found.',
        });
      }

      try {
        await tx.menuItem.delete({ where: { id: existing.id } });

        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'MENU_ITEM_DELETED',
            entityType: 'MenuItem',
            entityId: existing.id,
            beforeJson: { name: existing.name, basePricePaise: existing.basePricePaise },
            ipAddress,
          },
        });

        return { deleted: true, archived: false, id: existing.id };
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2003') {
          await tx.menuItem.update({
            where: { id: existing.id },
            data: { isActive: false, inStock: false },
          });

          await tx.auditLog.create({
            data: {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              actorRole: ctx.role,
              action: 'MENU_ITEM_ARCHIVED',
              entityType: 'MenuItem',
              entityId: existing.id,
              beforeJson: { name: existing.name, isActive: existing.isActive },
              afterJson: { isActive: false, inStock: false },
              ipAddress,
            },
          });

          return { deleted: false, archived: true, id: existing.id };
        }
        throw err;
      }
    }, ctx.tenantId);
  }
}
