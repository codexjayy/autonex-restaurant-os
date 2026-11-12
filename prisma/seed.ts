import { PrismaClient } from '@prisma/client';
import { hashSecret } from '../packages/auth/src/index';
import { PERMISSION_CATALOG, SYSTEM_ROLE_DEFINITIONS } from '../packages/permissions/src/index';

async function main(): Promise<void> {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!migrationUrl) {
    throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required to run seed.');
  }

  const prisma = new PrismaClient({ datasources: { db: { url: migrationUrl } } });

  try {
    // 1. Seed system RBAC permissions & roles
    const permIdByCode = new Map<string, string>();
    for (const perm of PERMISSION_CATALOG) {
      const savedPerm = await prisma.permission.upsert({
        where: { code: perm.code },
        update: { name: perm.name, module: perm.module, description: perm.description },
        create: {
          code: perm.code,
          name: perm.name,
          module: perm.module,
          description: perm.description,
        },
      });
      permIdByCode.set(perm.code, savedPerm.id);
    }

    for (const roleDef of SYSTEM_ROLE_DEFINITIONS) {
      const existingRole = await prisma.role.findFirst({
        where: { tenantId: null, code: roleDef.code },
      });
      const role = existingRole
        ? await prisma.role.update({
            where: { id: existingRole.id },
            data: { name: roleDef.name, description: roleDef.description, isSystem: true },
          })
        : await prisma.role.create({
            data: {
              tenantId: null,
              code: roleDef.code,
              name: roleDef.name,
              description: roleDef.description,
              isSystem: true,
            },
          });

      for (const permCode of roleDef.permissions) {
        const permissionId = permIdByCode.get(permCode);
        if (!permissionId) continue;
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId } },
          update: {},
          create: { roleId: role.id, permissionId },
        });
      }
    }

    // 2. Idempotently ensure initial Super Admin from environment variables
    const adminPhone = process.env.SUPER_ADMIN_PHONE ?? '+919999999999';
    const adminEmail = (process.env.SUPER_ADMIN_EMAIL ?? 'demo@autonex.com').trim().toLowerCase();
    const adminName = process.env.SUPER_ADMIN_NAME ?? 'Platform Admin';
    const adminPassword = process.env.SUPER_ADMIN_PASSWORD ?? 'demo123';
    const isInitialWeakDevPassword = adminPassword === 'demo123' || adminPassword.length < 10;

    if (process.env.NODE_ENV === 'production' && isInitialWeakDevPassword) {
      throw new Error(
        'Refusing to seed weak initial development Super Admin credentials in production. Set a strong SUPER_ADMIN_PASSWORD (min 10 chars).',
      );
    }

    const existingSuperAdmin = await prisma.user.findFirst({
      where: {
        OR: [{ isSuperAdmin: true }, { phone: adminPhone }, { email: adminEmail }],
      },
      orderBy: { createdAt: 'asc' },
    });

    const shouldSyncExisting =
      existingSuperAdmin &&
      (process.env.SUPER_ADMIN_FORCE_SYNC === 'true' ||
        !existingSuperAdmin.passwordChangedAt ||
        existingSuperAdmin.email !== adminEmail);

    if (!existingSuperAdmin) {
      await prisma.user.create({
        data: {
          phone: adminPhone,
          email: adminEmail,
          name: adminName,
          passwordHash: hashSecret(adminPassword),
          isSuperAdmin: true,
          isActive: true,
          passwordChangedAt: isInitialWeakDevPassword ? null : new Date(),
        },
      });
    } else if (shouldSyncExisting) {
      await prisma.user.update({
        where: { id: existingSuperAdmin.id },
        data: {
          name: adminName,
          email: adminEmail,
          phone: adminPhone,
          passwordHash: hashSecret(adminPassword),
          isSuperAdmin: true,
          isActive: true,
          deletedAt: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
          passwordChangedAt: isInitialWeakDevPassword ? null : new Date(),
        },
      });
    }

    // 3. Seed SaaS Subscription Plans (catalog metadata only — no fake restaurants or revenue)
    await prisma.plan.upsert({
      where: { code: 'STARTER' },
      update: {
        name: 'Starter Local Cafe',
        monthlyPricePaise: 99900,
        yearlyPricePaise: 999000,
        maxOutlets: 1,
        maxTables: 15,
        maxStaff: 8,
        trialDays: 14,
        graceDays: 3,
        isActive: true,
        sortOrder: 1,
      },
      create: {
        code: 'STARTER',
        name: 'Starter Local Cafe',
        description: 'Built for small cafes & tiffin centers (up to 15 tables).',
        monthlyPricePaise: 99900,
        yearlyPricePaise: 999000,
        maxOutlets: 1,
        maxTables: 15,
        maxStaff: 8,
        trialDays: 14,
        graceDays: 3,
        featuresJson: ['Permanent Table QRs', 'KDS Real-time Tickets', 'GST Bills & Cash/UPI Tracking'],
        isActive: true,
        sortOrder: 1,
      },
    });

    await prisma.plan.upsert({
      where: { code: 'GROWTH' },
      update: {
        name: 'Growth Family Dining',
        monthlyPricePaise: 199900,
        yearlyPricePaise: 1999000,
        maxOutlets: 1,
        maxTables: 40,
        maxStaff: 20,
        trialDays: 14,
        graceDays: 3,
        isActive: true,
        sortOrder: 2,
      },
      create: {
        code: 'GROWTH',
        name: 'Growth Family Dining',
        description: 'Multi-course family restaurants with Razorpay online pay & Gujarati/Hindi KDS.',
        monthlyPricePaise: 199900,
        yearlyPricePaise: 1999000,
        maxOutlets: 1,
        maxTables: 40,
        maxStaff: 20,
        trialDays: 14,
        graceDays: 3,
        featuresJson: [
          'Everything in Starter',
          'Razorpay Online & Split Payments',
          'PDF Receipts & Waiter Desk',
        ],
        isActive: true,
        sortOrder: 2,
      },
    });

    await prisma.plan.upsert({
      where: { code: 'PRO' },
      update: {
        name: 'Multi-Floor Pro',
        monthlyPricePaise: 349900,
        yearlyPricePaise: 3499000,
        maxOutlets: 3,
        maxTables: 100,
        maxStaff: 50,
        trialDays: 14,
        graceDays: 5,
        isActive: true,
        sortOrder: 3,
      },
      create: {
        code: 'PRO',
        name: 'Multi-Floor Pro',
        description: 'High-volume dining halls, food courts & multi-outlet franchises.',
        monthlyPricePaise: 349900,
        yearlyPricePaise: 3499000,
        maxOutlets: 3,
        maxTables: 100,
        maxStaff: 50,
        trialDays: 14,
        graceDays: 5,
        featuresJson: ['Everything in Growth', 'Priority Phone Support', 'Up to 3 Outlets'],
        isActive: true,
        sortOrder: 3,
      },
    });

    console.log('Seeded system RBAC permissions/roles, Super Admin bootstrap, and SaaS subscription plans (zero dummy restaurants).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
