import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '@autonex/auth';

function loadRootEnv() {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
  ];
  for (const file of candidates) {
    try {
      const content = readFileSync(file, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!(key in process.env)) {
          process.env[key] = val;
        }
      }
      break;
    } catch {
      // Ignore missing .env candidates
    }
  }
}

function normalizePhone(phone: string): string {
  const cleaned = phone.trim().replace(/[\s()-]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  if (/^\d{10,15}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

async function main() {
  loadRootEnv();

  const dbUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be configured.');
  }

  const email = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const rawPhone = (process.env.SUPER_ADMIN_PHONE || '').trim();
  const phone = normalizePhone(rawPhone || '+919999999999');
  const name = (process.env.SUPER_ADMIN_NAME || 'Platform Admin').trim();
  const password = process.env.SUPER_ADMIN_PASSWORD || '';
  const syncPassword = process.argv.includes('--sync');

  const isProd = process.env.NODE_ENV === 'production';
  const minLength = isProd ? 10 : 6;

  if (!email || !password || password.length < minLength) {
    throw new Error(
      `SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (min ${minLength} chars) must be set in environment.`,
    );
  }
  if (isProd && password === 'demo123') {
    throw new Error('Development default password cannot be used in production.');
  }

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ isSuperAdmin: true }, { email }, { phone }],
      },
      orderBy: { createdAt: 'asc' },
    });

    const passwordHash = await hashPassword(password);

    const isInitialWeakDevPassword = password === 'demo123' || password.length < 10;

    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          name,
          email,
          phone,
          isSuperAdmin: true,
          isActive: true,
          deletedAt: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
          ...(syncPassword || !existing.passwordHash
            ? {
                passwordHash,
                passwordChangedAt: isInitialWeakDevPassword ? null : new Date(),
              }
            : {}),
        },
      });
      await prisma.auditLog.create({
        data: {
          tenantId: null,
          actorUserId: existing.id,
          actorRole: 'SUPER_ADMIN',
          action: syncPassword ? 'SUPER_ADMIN_CREDENTIALS_SYNCED' : 'SUPER_ADMIN_VERIFIED',
          entityType: 'User',
          entityId: existing.id,
          afterJson: { email, phone, syncPassword },
        },
      });
      console.log(
        `Super Admin already exists (${email}). Lockout cleared${syncPassword ? ' and password synchronized with Argon2id' : ''}.`,
      );
      return;
    }

    const created = await prisma.user.create({
      data: {
        name,
        email,
        phone,
        passwordHash,
        isSuperAdmin: true,
        isActive: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: null,
        actorUserId: created.id,
        actorRole: 'SUPER_ADMIN',
        action: 'SUPER_ADMIN_CLI_INITIALIZED',
        entityType: 'User',
        entityId: created.id,
        afterJson: { email, phone },
      },
    });
    console.log(`Initialized first Super Admin account (${email}) with Argon2id hash.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

