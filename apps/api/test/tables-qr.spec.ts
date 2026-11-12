import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode, StaffRole, TenantStatus } from '@autonex/shared';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../src/common/decorators/current-user.decorator';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  decryptQrToken,
  encryptQrToken,
  generateQrToken,
  sha256Hex,
} from '../src/common/security/crypto.util';
import { QrPdfService } from '../src/modules/tables/qr-pdf.service';
import { TablesService } from '../src/modules/tables/tables.service';

describe('Table QR Security, Resolution & Bulk PDF (Phase 2)', () => {
  const secret = 'test_qr_signing_secret_min_32_characters_long_003';
  const appUrl = 'http://localhost:3000';
  const principal: AuthenticatedPrincipal = {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    outletId: '33333333-3333-4333-8333-333333333333',
    role: StaffRole.OWNER,
    isSuperAdmin: false,
    tenantStatus: TenantStatus.ACTIVE,
  };

  function createTablesHarness() {
    let createdQrData: Record<string, unknown> | null = null;
    const mockTx = {
      restaurantTable: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      tableQrToken: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          createdQrData = args.data;
          return {
            id: 'qr-id-1',
            createdAt: new Date(),
            ...args.data,
          };
        }),
        aggregate: jest.fn(async () => ({ _max: { qrVersion: 1 } })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      outlet: {
        findFirst: jest.fn(async () => ({ id: principal.outletId, name: 'Gujju Spice Kitchen' })),
      },
      category: {
        findMany: jest.fn(),
      },
      diningSession: {
        findFirst: jest.fn(async () => null),
      },
      auditLog: {
        create: jest.fn(async () => ({})),
      },
    };

    const mockPrisma = {
      runInTenantTx: jest.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
      appClient: {
        $queryRaw: jest.fn(),
      },
    } as unknown as PrismaService;

    const mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'QR_SIGNING_SECRET') return secret;
        if (key === 'APP_URL') return appUrl;
        return undefined;
      }),
    } as unknown as ConfigService;

    const mockContext = {
      get: jest.fn(() => ({ ipAddress: '127.0.0.1' })),
    } as unknown as TenantContextService;

    const qrPdfService = new QrPdfService();
    const tablesService = new TablesService(mockPrisma, mockConfig, mockContext, qrPdfService);

    return {
      tablesService,
      qrPdfService,
      mockTx,
      mockPrisma,
      getCreatedQrData: () => createdQrData,
    };
  }

  it('generates cryptographically random opaque QR tokens with AES-256-GCM encryption', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const token = generateQrToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(100);

    const sampleToken = generateQrToken();
    const enc1 = encryptQrToken(sampleToken, secret);
    const enc2 = encryptQrToken(sampleToken, secret);

    // Random IV ensures repeated encryption never produces identical ciphertext
    expect(enc1).not.toBe(enc2);
    expect(decryptQrToken(enc1, secret)).toBe(sampleToken);
    expect(decryptQrToken(enc2, secret)).toBe(sampleToken);

    // Wrong secret or tampered tag must fail authentication
    expect(() => decryptQrToken(enc1, 'wrong_secret_min_32_characters_long_999')).toThrow();
  });

  it('creates table with URL-only opaque token hash & zero menu data inside QR payload', async () => {
    const { tablesService, mockTx, getCreatedQrData } = createTablesHarness();
    mockTx.restaurantTable.create.mockResolvedValue({
      id: 'table-id-1',
      tableNumber: 'T1',
      label: 'Window',
      capacity: 4,
      status: 'AVAILABLE',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const created = await tablesService.createTable(principal, {
      tableNumber: 'T1',
      label: 'Window',
      capacity: 4,
    });

    expect(created.activeQr).not.toBeNull();
    const qrUrl = created.activeQr!.qrUrl;
    expect(qrUrl.startsWith(`${appUrl}/t/`)).toBe(true);

    // Extract token and verify QR URL contains NO table number, tenant id, or menu data
    const rawToken = qrUrl.slice(`${appUrl}/t/`.length);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(qrUrl).not.toContain('T1');
    expect(qrUrl).not.toContain(principal.tenantId!);

    const qrData = getCreatedQrData() as { tokenHash: string; tokenEnc: string; qrVersion: number };
    expect(qrData.qrVersion).toBe(1);
    expect(qrData.tokenHash).toBe(sha256Hex(rawToken));
    expect(qrData.tokenEnc).not.toContain(rawToken);
    expect(decryptQrToken(qrData.tokenEnc, secret)).toBe(rawToken);
  });

  it('rejects duplicate table numbers cleanly with ConflictException', async () => {
    const { tablesService, mockTx } = createTablesHarness();
    mockTx.restaurantTable.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      tablesService.createTable(principal, { tableNumber: 'T1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('rotates QR token by revoking previous tokens and bumping qrVersion', async () => {
    const { tablesService, mockTx, getCreatedQrData } = createTablesHarness();
    const oldToken = generateQrToken();

    mockTx.restaurantTable.findFirst.mockResolvedValue({
      id: 'table-id-1',
      tableNumber: 'T1',
      label: null,
      capacity: 4,
      status: 'AVAILABLE',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockTx.tableQrToken.aggregate.mockResolvedValue({ _max: { qrVersion: 2 } });

    const rotated = await tablesService.rotateQrToken(principal, 'table-id-1');

    expect(mockTx.tableQrToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tableId: 'table-id-1', isActive: true, revokedAt: null },
        data: expect.objectContaining({ isActive: false }),
      }),
    );

    const qrData = getCreatedQrData() as { tokenHash: string; qrVersion: number };
    expect(qrData.qrVersion).toBe(3);
    expect(qrData.tokenHash).not.toBe(sha256Hex(oldToken));
    expect(rotated.activeQr?.qrVersion).toBe(3);
  });

  it('rejects malformed or revoked tokens cleanly on public resolution', async () => {
    const { tablesService, mockPrisma } = createTablesHarness();

    // Malformed token fails immediately without DB query
    await expect(tablesService.resolvePublicQr('bad')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.appClient.$queryRaw).not.toHaveBeenCalled();

    // Valid-looking token revoked or unknown triggers INVALID_QR_TOKEN
    (mockPrisma.appClient.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
    try {
      await tablesService.resolvePublicQr(generateQrToken());
      fail('Expected NotFoundException');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        code: ErrorCode.INVALID_QR_TOKEN,
      });
    }
  });

  it('QR resolution reflects menu & price updates without regenerating QR and never creates a dining session', async () => {
    const { tablesService, mockPrisma, mockTx } = createTablesHarness();
    const permanentToken = generateQrToken();

    (mockPrisma.appClient.$queryRaw as jest.Mock).mockResolvedValue([
      {
        tenant_id: principal.tenantId,
        tenant_name: 'Gujju Spice',
        tenant_status: 'ACTIVE',
        outlet_id: principal.outletId,
        outlet_name: 'Gujju Spice Kitchen',
        outlet_address: 'C.G. Road, Ahmedabad',
        outlet_logo_url: null,
        table_id: 'table-id-1',
        table_number: 'T1',
        table_label: 'Window',
        qr_version: 1,
        require_waiter_approval: true,
        table_pin_enabled: false,
      },
    ]);

    mockTx.category.findMany
      .mockResolvedValueOnce([
        {
          id: 'cat-1',
          name: 'Curries',
          sortOrder: 0,
          menuItems: [
            {
              id: 'item-1',
              name: 'Paneer Tikka Masala',
              description: null,
              dietaryType: 'VEG',
              basePricePaise: 24000,
              imageUrl: null,
              inStock: true,
              sortOrder: 0,
              modifierGroups: [],
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'cat-1',
          name: 'Curries',
          sortOrder: 0,
          menuItems: [
            {
              id: 'item-1',
              name: 'Paneer Tikka Masala',
              description: null,
              dietaryType: 'VEG',
              basePricePaise: 26500, // Price updated without regenerating QR
              imageUrl: null,
              inStock: true,
              sortOrder: 0,
              modifierGroups: [],
            },
          ],
        },
      ]);

    const firstScan = await tablesService.resolvePublicQr(permanentToken);
    const secondScan = await tablesService.resolvePublicQr(permanentToken);

    expect(firstScan.sessionPolicy.sessionCreatedOnScan).toBe(false);
    expect(firstScan.categories[0]?.menuItems[0]?.basePricePaise).toBe(24000);
    expect(secondScan.categories[0]?.menuItems[0]?.basePricePaise).toBe(26500);
    expect(secondScan.table.tableNumber).toBe('T1');
  });

  it('generates valid single-table and multi-page bulk QR PDFs', async () => {
    const { tablesService, mockTx } = createTablesHarness();

    const tables = Array.from({ length: 8 }, (_, idx) => {
      const token = generateQrToken();
      return {
        id: `table-${idx + 1}`,
        tableNumber: `T${idx + 1}`,
        label: idx === 0 ? 'AC Hall' : null,
        qrTokens: [
          {
            qrVersion: 1,
            tokenEnc: encryptQrToken(token, secret),
          },
        ],
      };
    });

    mockTx.restaurantTable.findFirst.mockResolvedValue(tables[0]);
    mockTx.restaurantTable.findMany.mockResolvedValue(tables);

    const singlePdf = await tablesService.getSingleTableQrPdf(principal, 'table-1');
    expect(singlePdf.filename).toBe('autonex-table-T1-qr.pdf');
    expect(singlePdf.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(singlePdf.buffer.length).toBeGreaterThan(1000);

    const bulkPdf = await tablesService.getBulkTableQrPdf(principal);
    expect(bulkPdf.filename).toBe('autonex-all-table-qr-codes.pdf');
    expect(bulkPdf.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(bulkPdf.buffer.length).toBeGreaterThan(singlePdf.buffer.length);
  }, 20000);
});
