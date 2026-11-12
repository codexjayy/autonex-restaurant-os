import {
  DietaryType,
  PrismaClient,
  SelectionType,
  StaffRole,
  SubscriptionBillingCycle,
  SubscriptionInvoiceStatus,
  SubscriptionStatus,
  SupportCaseCategory,
  SupportCasePriority,
  SupportCaseStatus,
  TenantStatus,
} from '@prisma/client';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(secret, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encryptQrToken(rawToken: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

async function main(): Promise<void> {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!migrationUrl) {
    throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required to run seed.');
  }
  const qrSecret = process.env.QR_SIGNING_SECRET ?? 'dev_only_replace_with_64_char_random_hex_qr_signing_secret_003';

  const prisma = new PrismaClient({ datasources: { db: { url: migrationUrl } } });

  try {
    const adminPhone = process.env.SUPER_ADMIN_PHONE ?? '+919999999999';
    const adminEmail = process.env.SUPER_ADMIN_EMAIL ?? 'admin@autonex.in';
    const adminName = process.env.SUPER_ADMIN_NAME ?? 'Platform Admin';
    const adminPassword = process.env.SUPER_ADMIN_PASSWORD ?? 'ChangeMe123!';

    const superAdmin = await prisma.user.upsert({
      where: { phone: adminPhone },
      update: { name: adminName, email: adminEmail, isSuperAdmin: true, isActive: true },
      create: {
        phone: adminPhone,
        email: adminEmail,
        name: adminName,
        passwordHash: hashSecret(adminPassword),
        isSuperAdmin: true,
        isActive: true,
      },
    });

    const tenant = await prisma.tenant.upsert({
      where: { slug: 'spice-junction' },
      update: {},
      create: {
        name: 'Spice Junction Family Restaurant',
        slug: 'spice-junction',
        status: TenantStatus.ACTIVE,
        approvedAt: new Date(),
        approvedByUserId: superAdmin.id,
      },
    });

    const existingOutlet = await prisma.outlet.findFirst({
      where: { tenantId: tenant.id, name: 'Spice Junction - Navrangpura' },
    });

    const outlet =
      existingOutlet ??
      (await prisma.outlet.create({
        data: {
          tenantId: tenant.id,
          name: 'Spice Junction - Navrangpura',
          contactPhone: '+919876543210',
          address: 'CG Road, Navrangpura, Ahmedabad, Gujarat 380009',
          timezone: 'Asia/Kolkata',
          gstRateBps: 500,
          isActive: true,
        },
      }));

    const demoStaff: Array<{ phone: string; email?: string; name: string; role: StaffRole; pin: string }> = [
      { phone: '+919876543210', email: 'owner@spicejunction.in', name: 'Rajesh Patel', role: StaffRole.OWNER, pin: '1111' },
      { phone: '+919876543211', name: 'Meena Shah', role: StaffRole.MANAGER, pin: '2222' },
      { phone: '+919876543212', name: 'Karan Joshi', role: StaffRole.WAITER, pin: '3333' },
      { phone: '+919876543213', name: 'Vikram Thakor', role: StaffRole.KITCHEN, pin: '4444' },
    ];

    for (const member of demoStaff) {
      const user = await prisma.user.upsert({
        where: { phone: member.phone },
        update: { name: member.name, email: member.email ?? null },
        create: {
          phone: member.phone,
          email: member.email ?? null,
          name: member.name,
          passwordHash: member.role === StaffRole.OWNER ? hashSecret('OwnerPass123!') : null,
          isSuperAdmin: false,
        },
      });

      await prisma.membership.upsert({
        where: {
          tenantId_outletId_userId: {
            tenantId: tenant.id,
            outletId: outlet.id,
            userId: user.id,
          },
        },
        update: { role: member.role, isActive: true },
        create: {
          tenantId: tenant.id,
          outletId: outlet.id,
          userId: user.id,
          role: member.role,
          staffPinHash: hashSecret(member.pin),
          isActive: true,
        },
      });
    }

    // Phase 2 Seed: Demo Indian Categories, Items, Modifiers & Tables + QRs
    const categoryNames = ['Starters', 'Main Course', 'Breads & Rice', 'Beverages'];
    const categoriesMap = new Map<string, string>();
    for (let idx = 0; idx < categoryNames.length; idx++) {
      const name = categoryNames[idx]!;
      const cat = await prisma.category.upsert({
        where: {
          tenantId_outletId_name: { tenantId: tenant.id, outletId: outlet.id, name },
        },
        update: { sortOrder: idx + 1 },
        create: {
          tenantId: tenant.id,
          outletId: outlet.id,
          name,
          sortOrder: idx + 1,
        },
      });
      categoriesMap.set(name, cat.id);
    }

    const existingItems = await prisma.menuItem.count({
      where: { tenantId: tenant.id, outletId: outlet.id },
    });

    if (existingItems === 0) {
      const paneerTikka = await prisma.menuItem.create({
        data: {
          tenantId: tenant.id,
          outletId: outlet.id,
          categoryId: categoriesMap.get('Starters')!,
          name: 'Paneer Tikka',
          description: 'Charcoal-grilled cottage cheese cubes marinated in curd & spices',
          dietaryType: DietaryType.VEG,
          basePricePaise: 26000,
          sortOrder: 1,
        },
      });

      await prisma.modifierGroup.create({
        data: {
          tenantId: tenant.id,
          menuItemId: paneerTikka.id,
          name: 'Spice & Prep',
          selectionType: SelectionType.MULTI,
          isRequired: false,
          minSelect: 0,
          maxSelect: 2,
          options: {
            create: [
              { tenantId: tenant.id, name: 'Less Spicy', priceDeltaPaise: 0, sortOrder: 1 },
              { tenantId: tenant.id, name: 'No Onion-Garlic (Jain)', priceDeltaPaise: 0, sortOrder: 2 },
              { tenantId: tenant.id, name: 'Extra Cheese Dip', priceDeltaPaise: 4000, sortOrder: 3 },
            ],
          },
        },
      });

      const dalTadka = await prisma.menuItem.create({
        data: {
          tenantId: tenant.id,
          outletId: outlet.id,
          categoryId: categoriesMap.get('Main Course')!,
          name: 'Dal Tadka',
          description: 'Yellow lentils tempered with desi ghee, cumin & garlic',
          dietaryType: DietaryType.VEG,
          basePricePaise: 18000,
          sortOrder: 1,
        },
      });

      await prisma.modifierGroup.create({
        data: {
          tenantId: tenant.id,
          menuItemId: dalTadka.id,
          name: 'Portion Size',
          selectionType: SelectionType.SINGLE,
          isRequired: true,
          minSelect: 1,
          maxSelect: 1,
          options: {
            create: [
              { tenantId: tenant.id, name: 'Half', priceDeltaPaise: 0, isDefault: true, sortOrder: 1 },
              { tenantId: tenant.id, name: 'Full', priceDeltaPaise: 8000, sortOrder: 2 },
            ],
          },
        },
      });

      await prisma.menuItem.createMany({
        data: [
          {
            tenantId: tenant.id,
            outletId: outlet.id,
            categoryId: categoriesMap.get('Main Course')!,
            name: 'Butter Chicken',
            description: 'Tandoori chicken simmered in rich tomato-butter gravy',
            dietaryType: DietaryType.NON_VEG,
            basePricePaise: 32000,
            sortOrder: 2,
          },
          {
            tenantId: tenant.id,
            outletId: outlet.id,
            categoryId: categoriesMap.get('Breads & Rice')!,
            name: 'Butter Naan',
            description: 'Soft tandoori flatbread brushed with butter',
            dietaryType: DietaryType.VEG,
            basePricePaise: 5500,
            sortOrder: 1,
          },
          {
            tenantId: tenant.id,
            outletId: outlet.id,
            categoryId: categoriesMap.get('Beverages')!,
            name: 'Masala Chaas',
            description: 'Chilled spiced buttermilk with roasted cumin & coriander',
            dietaryType: DietaryType.VEG,
            basePricePaise: 4500,
            sortOrder: 1,
          },
        ],
      });
    }

    for (let n = 1; n <= 6; n++) {
      const tableNumber = `T${n}`;
      const table = await prisma.restaurantTable.upsert({
        where: {
          tenantId_outletId_tableNumber: {
            tenantId: tenant.id,
            outletId: outlet.id,
            tableNumber,
          },
        },
        update: {},
        create: {
          tenantId: tenant.id,
          outletId: outlet.id,
          tableNumber,
          label: `Table ${n}`,
          capacity: n <= 4 ? 4 : 6,
          isActive: true,
        },
      });

      const activeQr = await prisma.tableQrToken.findFirst({
        where: { tableId: table.id, isActive: true, revokedAt: null },
      });

      if (!activeQr) {
        const rawToken = randomBytes(32).toString('base64url');
        await prisma.tableQrToken.create({
          data: {
            tenantId: tenant.id,
            outletId: outlet.id,
            tableId: table.id,
            tokenHash: sha256Hex(rawToken),
            tokenEnc: encryptQrToken(rawToken, qrSecret),
            qrVersion: 1,
            isActive: true,
          },
        });
      }
    }

    console.log('Seeded Phase 1 + Phase 2 Super Admin, Spice Junction outlet, menu, modifiers & 6 table QRs.');

    // Phase 7: Seed SaaS Plans, active subscription for Spice Junction & sample support ticket
    const starterPlan = await prisma.plan.upsert({
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

    const growthPlan = await prisma.plan.upsert({
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

    const periodStart = new Date();
    const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
    const sub = await prisma.subscription.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: {
        tenantId: tenant.id,
        planId: growthPlan.id,
        status: SubscriptionStatus.ACTIVE,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        startedAt: periodStart,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        autoRenew: true,
      },
    });

    const existingSubInv = await prisma.subscriptionInvoice.findFirst({
      where: { tenantId: tenant.id },
    });
    if (!existingSubInv) {
      await prisma.subscriptionInvoice.create({
        data: {
          tenantId: tenant.id,
          subscriptionId: sub.id,
          planId: growthPlan.id,
          invoiceNumber: 'SUB-202611-00001',
          billingCycle: SubscriptionBillingCycle.MONTHLY,
          amountPaise: growthPlan.monthlyPricePaise,
          taxPaise: Math.round(growthPlan.monthlyPricePaise * 0.18),
          totalPaise: Math.round(growthPlan.monthlyPricePaise * 1.18),
          status: SubscriptionInvoiceStatus.PAID,
          periodStart,
          periodEnd,
          paidAt: periodStart,
          paymentRef: 'SEED-UPI-GROWTH-001',
          notes: `Seeded subscription (${starterPlan.code} -> ${growthPlan.code})`,
        },
      });
    }

    const ownerUser = await prisma.user.findFirst({
      where: { phone: '+919876543210' },
    });
    if (ownerUser) {
      const existingCase = await prisma.supportCase.findFirst({
        where: { tenantId: tenant.id },
      });
      if (!existingCase) {
        await prisma.supportCase.create({
          data: {
            caseNumber: 'SUP-202611-0001',
            tenantId: tenant.id,
            outletId: outlet.id,
            createdByUserId: ownerUser.id,
            assignedToUserId: superAdmin.id,
            category: SupportCaseCategory.HARDWARE_QR,
            priority: SupportCasePriority.LOW,
            status: SupportCaseStatus.OPEN,
            subject: 'Need laminated acrylic QR stands for T1-T6',
            description: 'We printed our A4 QR cards and would like advice on tent stand sizing for 4-seater tables.',
          },
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
