import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DietaryType, ErrorCode, SelectionType, StaffRole, TenantStatus } from '@autonex/shared';
import sharp from 'sharp';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../src/common/decorators/current-user.decorator';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { MediaService } from '../src/modules/menus/media.service';
import { MenusService } from '../src/modules/menus/menus.service';

describe('MenusService & MediaService (Phase 2)', () => {
  const principal: AuthenticatedPrincipal = {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    outletId: '33333333-3333-4333-8333-333333333333',
    role: StaffRole.OWNER,
    isSuperAdmin: false,
    tenantStatus: TenantStatus.ACTIVE,
  };

  function createMockMenusService() {
    const auditLogs: Array<Record<string, unknown>> = [];
    const mockTx = {
      category: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
      },
      menuItem: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      modifierGroup: {
        deleteMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          auditLogs.push(args.data);
          return args.data;
        }),
      },
    };

    const mockPrisma = {
      runInTenantTx: jest.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    } as unknown as PrismaService;

    const mockTenantContext = {
      get: jest.fn(() => ({ ipAddress: '127.0.0.1' })),
    } as unknown as TenantContextService;

    const service = new MenusService(mockPrisma, mockTenantContext);
    return { service, mockTx, mockPrisma, auditLogs };
  }

  describe('Server-side Price & Modifier Validation', () => {
    it('rejects negative or fractional basePricePaise', () => {
      const { service } = createMockMenusService();

      expect(() => service.validateAndNormalizePricing(-100, [])).toThrow(BadRequestException);
      expect(() => service.validateAndNormalizePricing(199.5, [])).toThrow(BadRequestException);

      try {
        service.validateAndNormalizePricing(-50, []);
      } catch (err) {
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: ErrorCode.INVALID_PRICE,
        });
      }
    });

    it('rejects modifier option whose discount makes final price negative', () => {
      const { service } = createMockMenusService();

      expect(() =>
        service.validateAndNormalizePricing(5000, [
          {
            name: 'Portion Size',
            selectionType: SelectionType.SINGLE,
            options: [{ name: 'Mini Discount', priceDeltaPaise: -6000 }],
          },
        ]),
      ).toThrow(BadRequestException);
    });

    it('rejects SINGLE modifier group with maxSelect > 1 or empty options', () => {
      const { service } = createMockMenusService();

      expect(() =>
        service.validateAndNormalizePricing(15000, [
          {
            name: 'Spice Level',
            selectionType: SelectionType.SINGLE,
            maxSelect: 2,
            options: [
              { name: 'Mild', priceDeltaPaise: 0 },
              { name: 'Spicy', priceDeltaPaise: 0 },
            ],
          },
        ]),
      ).toThrow(BadRequestException);

      expect(() =>
        service.validateAndNormalizePricing(15000, [
          {
            name: 'Empty Group',
            selectionType: SelectionType.MULTI,
            options: [],
          },
        ]),
      ).toThrow(BadRequestException);
    });

    it('normalizes required SINGLE and MULTI modifier bounds properly', () => {
      const { service } = createMockMenusService();
      const result = service.validateAndNormalizePricing(24000, [
        {
          name: 'Spice Level',
          selectionType: SelectionType.SINGLE,
          isRequired: true,
          options: [
            { name: 'Medium', priceDeltaPaise: 0 },
            { name: 'Jain (No Onion/Garlic)', priceDeltaPaise: 0 },
          ],
        },
        {
          name: 'Add-ons',
          selectionType: SelectionType.MULTI,
          options: [
            { name: 'Extra Butter', priceDeltaPaise: 2500 },
            { name: 'Extra Cheese', priceDeltaPaise: 4000 },
          ],
        },
      ]);

      expect(result[0]?.minSelect).toBe(1);
      expect(result[0]?.maxSelect).toBe(1);
      expect(result[1]?.minSelect).toBe(0);
      expect(result[1]?.maxSelect).toBe(2);
    });
  });

  describe('Category & Menu Item CRUD + Stock Toggle', () => {
    it('blocks deleting a category that still contains menu items', async () => {
      const { service, mockTx } = createMockMenusService();
      mockTx.category.findFirst.mockResolvedValue({
        id: '44444444-4444-4444-8444-444444444444',
        _count: { menuItems: 2 },
      });

      await expect(
        service.deleteCategory(principal, '44444444-4444-4444-8444-444444444444'),
      ).rejects.toThrow(ConflictException);
    });

    it('creates a menu item with tenant-scoped nested modifiers and audit log', async () => {
      const { service, mockTx, auditLogs } = createMockMenusService();
      const catId = '55555555-5555-4555-8555-555555555555';
      mockTx.category.findFirst.mockResolvedValue({ id: catId, outletId: principal.outletId });
      mockTx.menuItem.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: '66666666-6666-4666-8666-666666666666',
        ...args.data,
        modifierGroups: [],
      }));

      await service.createMenuItem(principal, {
        categoryId: catId,
        name: 'Butter Naan',
        dietaryType: DietaryType.VEG,
        basePricePaise: 5500,
        modifierGroups: [
          {
            name: 'Toppings',
            selectionType: SelectionType.SINGLE,
            options: [{ name: 'Garlic Butter', priceDeltaPaise: 1500 }],
          },
        ],
      });

      const createCall = mockTx.menuItem.create.mock.calls[0]?.[0] as {
        data: {
          tenantId: string;
          modifierGroups?: {
            create: Array<{
              tenant: { connect: { id: string } };
              options: { create: Array<{ tenantId: string }> };
            }>;
          };
        };
      };

      expect(createCall.data.tenantId).toBe(principal.tenantId);
      expect(createCall.data.modifierGroups?.create[0]?.tenant.connect.id).toBe(principal.tenantId);
      expect(createCall.data.modifierGroups?.create[0]?.options.create[0]?.tenantId).toBe(
        principal.tenantId,
      );
      expect(auditLogs[0]?.action).toBe('MENU_ITEM_CREATED');
    });

    it('updates item price and records MENU_ITEM_PRICE_UPDATED audit log', async () => {
      const { service, mockTx, auditLogs } = createMockMenusService();
      const itemId = '77777777-7777-4777-8777-777777777777';

      mockTx.menuItem.findFirst.mockResolvedValue({
        id: itemId,
        categoryId: 'cat-1',
        name: 'Masala Dosa',
        basePricePaise: 11000,
        inStock: true,
        modifierGroups: [
          {
            name: 'Cheese',
            selectionType: SelectionType.SINGLE,
            isRequired: false,
            minSelect: 0,
            maxSelect: 1,
            sortOrder: 0,
            options: [
              { name: 'No Cheese', priceDeltaPaise: 0, inStock: true, isDefault: true, sortOrder: 0 },
            ],
          },
        ],
      });

      mockTx.menuItem.update.mockResolvedValue({
        id: itemId,
        name: 'Masala Dosa',
        basePricePaise: 12500,
        inStock: true,
        modifierGroups: [],
      });

      const updated = await service.updateMenuItem(principal, itemId, {
        basePricePaise: 12500,
      });

      expect(updated.basePricePaise).toBe(12500);
      expect(auditLogs[0]?.action).toBe('MENU_ITEM_PRICE_UPDATED');
      expect(auditLogs[0]?.beforeJson).toMatchObject({ basePricePaise: 11000 });
      expect(auditLogs[0]?.afterJson).toMatchObject({ basePricePaise: 12500 });
    });

    it('toggles inStock status instantly and throws NotFound for unknown item', async () => {
      const { service, mockTx, auditLogs } = createMockMenusService();
      const itemId = '88888888-8888-4888-8888-888888888888';

      mockTx.menuItem.findFirst.mockResolvedValueOnce(null);
      await expect(service.toggleItemStock(principal, itemId, false)).rejects.toThrow(
        NotFoundException,
      );

      mockTx.menuItem.findFirst.mockResolvedValueOnce({ id: itemId, inStock: true });
      mockTx.menuItem.update.mockResolvedValueOnce({ id: itemId, inStock: false });

      const toggled = await service.toggleItemStock(principal, itemId, false);
      expect(toggled.inStock).toBe(false);
      expect(auditLogs[0]?.action).toBe('MENU_ITEM_STOCK_TOGGLED');
    });
  });

  describe('MediaService Upload & WebP Processing', () => {
    let tempUploadDir: string;

    beforeEach(() => {
      tempUploadDir = mkdtempSync(path.join(tmpdir(), 'autonex-media-test-'));
    });

    afterEach(() => {
      rmSync(tempUploadDir, { recursive: true, force: true });
    });

    function createMediaService(): MediaService {
      const mockConfig = {
        get: jest.fn((key: string) => {
          const map: Record<string, string> = {
            S3_STORAGE_DRIVER: 'local',
            CDN_BASE_URL: 'http://localhost:4000/uploads',
            LOCAL_UPLOAD_DIR: tempUploadDir,
            S3_BUCKET: 'autonex-media',
          };
          return map[key];
        }),
      } as unknown as ConfigService;
      return new MediaService(mockConfig);
    }

    it('rejects unsupported MIME types and spoofed image bytes', async () => {
      const media = createMediaService();

      await expect(
        media.uploadMenuItemImage(principal.tenantId!, {
          mimetype: 'application/pdf',
          size: 100,
          buffer: Buffer.from('%PDF-1.4'),
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        media.uploadMenuItemImage(principal.tenantId!, {
          mimetype: 'image/jpeg',
          size: 32,
          buffer: Buffer.from('not-actually-a-jpeg-file'),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('resizes oversized PNG into <=800px WebP and writes safely under upload dir', async () => {
      const media = createMediaService();
      const rawPng = await sharp({
        create: {
          width: 1600,
          height: 1200,
          channels: 3,
          background: { r: 234, g: 88, b: 12 },
        },
      })
        .png()
        .toBuffer();

      const result = await media.uploadMenuItemImage(principal.tenantId!, {
        mimetype: 'image/png',
        size: rawPng.length,
        buffer: rawPng,
      });

      expect(result.contentType).toBe('image/webp');
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
      expect(result.imageUrl).toBe(`http://localhost:4000/uploads/${result.key}`);
      expect(existsSync(path.join(tempUploadDir, result.key))).toBe(true);
    });
  });
});

