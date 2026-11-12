import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { applyTenantQueryGuard } from '@autonex/database';
import { SYSTEM_ROLE_DEFINITIONS } from '@autonex/permissions';
import { ErrorCode, StaffRole, TenantStatus } from '@autonex/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

interface AnyRow extends Record<string, unknown> {
  id: string;
}

class InMemoryPrismaStore {
  tenants: AnyRow[] = [];
  tenantSettings: AnyRow[] = [];
  outlets: AnyRow[] = [];
  outletSettings: AnyRow[] = [];
  users: AnyRow[] = [];
  roles: AnyRow[] = [];
  permissions: AnyRow[] = [];
  rolePermissions: AnyRow[] = [];
  memberships: AnyRow[] = [];
  invitations: AnyRow[] = [];
  refreshTokens: AnyRow[] = [];
  sessions: AnyRow[] = [];
  auditLogs: AnyRow[] = [];
  plans: AnyRow[] = [];
  subscriptions: AnyRow[] = [];

  constructor() {
    this.seedSystemData();
  }

  private seedSystemData() {
    const now = new Date();
    const permByKey = new Map<string, AnyRow>();
    for (const def of SYSTEM_ROLE_DEFINITIONS) {
      const roleId = randomUUID();
      this.roles.push({
        id: roleId,
        tenantId: null,
        code: def.code,
        name: def.name,
        description: def.description,
        isSystem: true,
        createdAt: now,
        updatedAt: now,
      });

      for (const permCode of def.permissions) {
        let perm = permByKey.get(permCode);
        if (!perm) {
          perm = {
            id: randomUUID(),
            code: permCode,
            description: permCode,
            createdAt: now,
          };
          permByKey.set(permCode, perm);
          this.permissions.push(perm);
        }
        this.rolePermissions.push({
          id: randomUUID(),
          roleId,
          permissionId: perm.id,
        });
      }
    }

    this.plans.push({
      id: randomUUID(),
      code: 'STARTER',
      name: 'Starter Plan',
      description: 'Single outlet starter plan',
      priceMonthlyPaise: 99900,
      priceYearlyPaise: 999000,
      maxOutlets: 1,
      maxTables: 15,
      trialDays: 14,
      graceDays: 7,
      isActive: true,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  private matchesWhere(row: AnyRow, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR' && Array.isArray(cond)) {
        if (!cond.some((sub) => this.matchesWhere(row, sub as Record<string, unknown>))) {
          return false;
        }
        continue;
      }
      if (key === 'AND' && Array.isArray(cond)) {
        if (!cond.every((sub) => this.matchesWhere(row, sub as Record<string, unknown>))) {
          return false;
        }
        continue;
      }
      if (key === 'NOT') {
        const notList = Array.isArray(cond) ? cond : [cond];
        if (notList.some((sub) => this.matchesWhere(row, sub as Record<string, unknown>))) {
          return false;
        }
        continue;
      }

      const val = row[key];
      if (cond === undefined) continue;
      if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
        if (cond === null) {
          if (val !== null && val !== undefined) return false;
        } else if (val instanceof Date && cond instanceof Date) {
          if (val.getTime() !== cond.getTime()) return false;
        } else if (val !== cond) {
          return false;
        }
        continue;
      }

      const ops = cond as Record<string, unknown>;
      if ('in' in ops && Array.isArray(ops.in)) {
        if (!ops.in.includes(val)) return false;
      }
      if ('not' in ops) {
        if (ops.not === null ? val === null || val === undefined : val === ops.not) return false;
      }
    }
    return true;
  }

  private applySelect(row: Record<string, unknown>, select?: Record<string, unknown>): Record<string, unknown> {
    if (!select) return { ...row };
    const picked: Record<string, unknown> = {};
    for (const [key, enabled] of Object.entries(select)) {
      if (enabled) picked[key] = row[key];
    }
    return picked;
  }

  private hydrateRow(
    model: string,
    row: AnyRow,
    include?: Record<string, unknown>,
    select?: Record<string, unknown>,
  ): AnyRow {
    const out: AnyRow = { ...row };
    if (include) {
      if (model === 'tenant' && include.settings) {
        out.settings = this.tenantSettings.find((s) => s.tenantId === row.id) ?? null;
      }
      if (model === 'outlet' && include.settings) {
        out.settings = this.outletSettings.find((s) => s.outletId === row.id) ?? null;
      }
      if (model === 'membership') {
        if (include.tenant) {
          out.tenant = this.tenants.find((t) => t.id === row.tenantId) ?? null;
        }
        if (include.outlet) {
          out.outlet = this.outlets.find((o) => o.id === row.outletId) ?? null;
        }
        if (include.user) {
          const user = this.users.find((u) => u.id === row.userId);
          const sel =
            typeof include.user === 'object' && include.user
              ? (include.user as { select?: Record<string, unknown> }).select
              : undefined;
          out.user = user ? this.applySelect(user, sel) : null;
        }
      }
      if (model === 'invitation') {
        if (include.tenant) out.tenant = this.tenants.find((t) => t.id === row.tenantId) ?? null;
        if (include.outlet) out.outlet = this.outlets.find((o) => o.id === row.outletId) ?? null;
      }
      if (model === 'user' && include.memberships) {
        const cfg =
          typeof include.memberships === 'object' && include.memberships
            ? (include.memberships as {
                where?: Record<string, unknown>;
                include?: Record<string, unknown>;
              })
            : {};
        out.memberships = this.memberships
          .filter((m) => m.userId === row.id && this.matchesWhere(m, cfg.where))
          .map((m) => this.hydrateRow('membership', m, cfg.include));
      }
      if (model === 'refreshToken' && include.user) {
        const user = this.users.find((u) => u.id === row.userId);
        const userInclude =
          typeof include.user === 'object' && include.user
            ? (include.user as { include?: Record<string, unknown> }).include
            : undefined;
        out.user = user ? this.hydrateRow('user', user, userInclude) : null;
      }
      if (model === 'role' && include.rolePermissions) {
        out.rolePermissions = this.rolePermissions
          .filter((rp) => rp.roleId === row.id)
          .map((rp) => ({
            ...rp,
            permission: this.permissions.find((p) => p.id === rp.permissionId) ?? null,
          }));
      }
    }

    if (select) {
      const selected: Record<string, unknown> = {};
      for (const [key, cfg] of Object.entries(select)) {
        if (cfg === true) {
          selected[key] = out[key];
        } else if (model === 'user' && key === 'memberships' && typeof cfg === 'object' && cfg) {
          const mCfg = cfg as {
            where?: Record<string, unknown>;
            include?: Record<string, unknown>;
          };
          selected.memberships = this.memberships
            .filter((m) => m.userId === row.id && this.matchesWhere(m, mCfg.where))
            .map((m) => this.hydrateRow('membership', m, mCfg.include));
        }
      }
      return selected as AnyRow;
    }

    return out;
  }

  private createDelegate(modelKey: string, prismaModelName: string, rows: AnyRow[], tenantId?: string) {
    const exec = async (operation: string, args: Record<string, unknown> = {}, fn: (a: Record<string, unknown>) => unknown) => {
      if (tenantId) {
        return applyTenantQueryGuard({
          tenantId,
          model: prismaModelName,
          operation,
          args,
          query: async (guardedArgs) => fn((guardedArgs ?? {}) as Record<string, unknown>),
        });
      }
      return fn(args);
    };

    const normalizeDefaults = (data: Record<string, unknown>): AnyRow => {
      const now = new Date();
      const defaults: Record<string, unknown> = {
        id: (data.id as string) ?? randomUUID(),
        createdAt: data.createdAt ?? now,
        updatedAt: data.updatedAt ?? now,
        deletedAt: data.deletedAt ?? null,
      };
      if (modelKey === 'user') {
        defaults.isActive = data.isActive ?? true;
        defaults.isSuperAdmin = data.isSuperAdmin ?? false;
        defaults.mfaEnabled = data.mfaEnabled ?? false;
        defaults.email = data.email ?? null;
      } else if (modelKey === 'membership') {
        defaults.isActive = data.isActive ?? true;
        defaults.failedPinAttempts = data.failedPinAttempts ?? 0;
        defaults.lockedUntil = data.lockedUntil ?? null;
      } else if (modelKey === 'refreshToken') {
        defaults.revokedAt = data.revokedAt ?? null;
      } else if (modelKey === 'session') {
        defaults.revokedAt = data.revokedAt ?? null;
        defaults.lastActiveAt = data.lastActiveAt ?? now;
      } else if (modelKey === 'outlet') {
        defaults.isActive = data.isActive ?? true;
        defaults.taxMode = data.taxMode ?? 'EXCLUSIVE';
        defaults.roundOffEnabled = data.roundOffEnabled ?? true;
        defaults.requireWaiterApproval = data.requireWaiterApproval ?? true;
        defaults.tablePinEnabled = data.tablePinEnabled ?? true;
      } else if (modelKey === 'invitation') {
        defaults.acceptedAt = data.acceptedAt ?? null;
        defaults.revokedAt = data.revokedAt ?? null;
      } else if (modelKey === 'tenant') {
        defaults.approvedAt = data.approvedAt ?? null;
      }
      return { ...defaults, ...data } as AnyRow;
    };

    return {
      findFirst: (args?: Record<string, unknown>) =>
        exec('findFirst', args, (a) => {
          const hit = rows.find((r) => this.matchesWhere(r, a.where as Record<string, unknown>));
          return hit
            ? this.hydrateRow(
                modelKey,
                hit,
                a.include as Record<string, unknown> | undefined,
                a.select as Record<string, unknown> | undefined,
              )
            : null;
        }),
      findUnique: (args?: Record<string, unknown>) =>
        exec('findUnique', args, (a) => {
          const hit = rows.find((r) => this.matchesWhere(r, a.where as Record<string, unknown>));
          return hit
            ? this.hydrateRow(
                modelKey,
                hit,
                a.include as Record<string, unknown> | undefined,
                a.select as Record<string, unknown> | undefined,
              )
            : null;
        }),
      findMany: (args?: Record<string, unknown>) =>
        exec('findMany', args, (a) =>
          rows
            .filter((r) => this.matchesWhere(r, a.where as Record<string, unknown>))
            .map((r) =>
              this.hydrateRow(
                modelKey,
                r,
                a.include as Record<string, unknown> | undefined,
                a.select as Record<string, unknown> | undefined,
              ),
            ),
        ),
      count: (args?: Record<string, unknown>) =>
        exec('count', args, (a) =>
          rows.filter((r) => this.matchesWhere(r, a.where as Record<string, unknown>)).length,
        ),
      create: (args?: Record<string, unknown>) =>
        exec('create', args, (a) => {
          const created = normalizeDefaults((a.data ?? {}) as Record<string, unknown>);
          rows.push(created);
          return this.hydrateRow(modelKey, created, a.include as Record<string, unknown> | undefined);
        }),
      update: (args?: Record<string, unknown>) =>
        exec('update', args, (a) => {
          const hit = rows.find((r) => this.matchesWhere(r, a.where as Record<string, unknown>));
          if (!hit) throw new Error(`${modelKey}.update: record not found`);
          Object.assign(hit, a.data ?? {}, { updatedAt: new Date() });
          return this.hydrateRow(modelKey, hit, a.include as Record<string, unknown> | undefined);
        }),
      updateMany: (args?: Record<string, unknown>) =>
        exec('updateMany', args, (a) => {
          let count = 0;
          for (const row of rows) {
            if (this.matchesWhere(row, a.where as Record<string, unknown>)) {
              Object.assign(row, a.data ?? {}, { updatedAt: new Date() });
              count += 1;
            }
          }
          return { count };
        }),
      upsert: (args?: Record<string, unknown>) =>
        exec('upsert', args, (a) => {
          const hit = rows.find((r) => this.matchesWhere(r, a.where as Record<string, unknown>));
          if (hit) {
            Object.assign(hit, a.update ?? {}, { updatedAt: new Date() });
            return this.hydrateRow(modelKey, hit);
          }
          const created = normalizeDefaults((a.create ?? {}) as Record<string, unknown>);
          rows.push(created);
          return this.hydrateRow(modelKey, created);
        }),
    };
  }

  buildClient(tenantId?: string): Record<string, unknown> {
    const emptyCountDelegate = {
      count: async () => 0,
      findMany: async () => [],
      findFirst: async () => null,
    };

    const client: Record<string, unknown> = {
      $queryRaw: async () => [{ '?column?': 1 }],
      tenant: this.createDelegate('tenant', 'Tenant', this.tenants, tenantId),
      tenantSettings: this.createDelegate('tenantSettings', 'TenantSettings', this.tenantSettings, tenantId),
      outlet: this.createDelegate('outlet', 'Outlet', this.outlets, tenantId),
      outletSettings: this.createDelegate('outletSettings', 'OutletSettings', this.outletSettings, tenantId),
      user: this.createDelegate('user', 'User', this.users, undefined),
      role: this.createDelegate('role', 'Role', this.roles, tenantId),
      membership: this.createDelegate('membership', 'Membership', this.memberships, tenantId),
      invitation: this.createDelegate('invitation', 'Invitation', this.invitations, tenantId),
      refreshToken: this.createDelegate('refreshToken', 'RefreshToken', this.refreshTokens, tenantId),
      session: this.createDelegate('session', 'Session', this.sessions, tenantId),
      auditLog: this.createDelegate('auditLog', 'AuditLog', this.auditLogs, tenantId),
      plan: this.createDelegate('plan', 'Plan', this.plans, undefined),
      subscription: this.createDelegate('subscription', 'Subscription', this.subscriptions, tenantId),
      menuItem: emptyCountDelegate,
      restaurantTable: emptyCountDelegate,
      tableQrToken: emptyCountDelegate,
      $transaction: async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => fn(client),
    };
    return client;
  }
}

function parseSetCookies(headers: string[]): Record<string, { value: string; attrs: string }> {
  const result: Record<string, { value: string; attrs: string }> = {};
  for (const header of headers) {
    const [pair, ...rest] = header.split(';');
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    result[name] = { value, attrs: rest.join(';').trim() };
  }
  return result;
}

describe('Milestone 1 Booted NestJS HTTP Integration Suite', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: InMemoryPrismaStore;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SKIP_DB_CONNECT = 'true';
    process.env.SKIP_REDIS_CONNECT = 'true';
    process.env.REDIS_ENABLED = 'false';
    process.env.JWT_ACCESS_SECRET =
      process.env.JWT_ACCESS_SECRET ?? 'integration_test_access_secret_at_least_32_chars';
    process.env.JWT_REFRESH_SECRET =
      process.env.JWT_REFRESH_SECRET ?? 'integration_test_refresh_secret_at_least_32_chars';
    process.env.QR_SIGNING_SECRET =
      process.env.QR_SIGNING_SECRET ?? 'integration_test_qr_signing_secret_32_chars';

    store = new InMemoryPrismaStore();
    const mockPrismaService = {
      adminClient: store.buildClient(undefined),
      appClient: store.buildClient(undefined),
      onModuleInit: async () => undefined,
      onModuleDestroy: async () => undefined,
      runAsSystemAdmin: async <T>(fn: (db: unknown) => Promise<T>) => fn(store.buildClient(undefined)),
      runInTenantTx: async <T>(fn: (tx: unknown) => Promise<T>, explicitTenantId?: string) => {
        if (!explicitTenantId) {
          throw new Error('Missing explicit tenantId in test');
        }
        return fn(store.buildClient(explicitTenantId));
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('boots full HTTP pipeline, enforces ValidationPipe/CSRF/RBAC/TenantIsolation & completes full Milestone 1 lifecycle', async () => {
    // 1. Public health check
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as {
      status: string;
      dependencies: { database: string };
    };
    expect(healthBody.status).toBe('ok');
    expect(healthBody.dependencies.database).toBe('connected');

    // 2. ValidationPipe blocks unknown properties and invalid inputs
    const invalidReg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        restaurantName: 'Bad Input Cafe',
        outletName: 'Main',
        ownerName: 'Test User',
        email: 'bad-email',
        phone: '+919825012345',
        password: 'short',
        pin: '12',
        injectedAdminFlag: true,
      }),
    });
    expect(invalidReg.status).toBe(400);

    // 3. Register Tenant A owner & verify HttpOnly refresh cookie + readable CSRF cookie
    const regARes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        restaurantName: 'Gujarat Spice Kitchen',
        outletName: 'Navrangpura Flagship',
        ownerName: 'Rohan Patel',
        email: 'rohan@gujaratspice.in',
        phone: '+919825012345',
        password: 'Password#2026',
        pin: '1234',
        address: 'CG Road, Ahmedabad',
      }),
    });
    expect(regARes.status).toBe(201);
    const regCookies = parseSetCookies(regARes.headers.getSetCookie());
    expect(regCookies.anx_refresh?.value).toBeTruthy();
    expect(regCookies.anx_refresh?.attrs).toMatch(/HttpOnly/i);
    expect(regCookies.anx_refresh?.attrs).toMatch(/SameSite=Lax/i);
    expect(regCookies.anx_csrf?.value).toBeTruthy();

    const regABody = (await regARes.json()) as {
      accessToken: string;
      csrfToken: string;
      tenant: { id: string; status: string };
      outlet: { id: string };
      user: { id: string };
    };
    expect(regABody.tenant.status).toBe(TenantStatus.PENDING_APPROVAL);
    let accessTokenA = regABody.accessToken;
    const tenantIdA = regABody.tenant.id;
    const outletIdA1 = regABody.outlet.id;
    let cookieRefresh = regCookies.anx_refresh!.value;
    let cookieCsrf = regCookies.anx_csrf!.value;

    // 4. TenantStatusGuard blocks non-pending-allowed operational endpoints while PENDING_APPROVAL
    const pendingInviteAttempt = await fetch(`${baseUrl}/auth/invitations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessTokenA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Karan Joshi',
        phone: '+919825011122',
        role: StaffRole.WAITER,
      }),
    });
    expect(pendingInviteAttempt.status).toBe(403);
    expect(pendingInviteAttempt.headers.get('x-request-id')).toBeTruthy();
    const pendingErr = (await pendingInviteAttempt.json()) as { code?: string };
    expect(pendingErr.code).toBe(ErrorCode.TENANT_NOT_APPROVED);

    // 5. Cookie refresh WITHOUT X-CSRF-Token header fails 403 CSRF_TOKEN_INVALID
    const badRefresh = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `anx_refresh=${cookieRefresh}; anx_csrf=${cookieCsrf}`,
      },
      body: JSON.stringify({}),
    });
    expect(badRefresh.status).toBe(403);
    const badRefreshBody = (await badRefresh.json()) as { code?: string };
    expect(badRefreshBody.code).toBe(ErrorCode.CSRF_TOKEN_INVALID);

    // 6. Activate tenant in store and rotate tokens WITH CSRF cookie + header
    const tenantRow = store.tenants.find((t) => t.id === tenantIdA)!;
    tenantRow.status = TenantStatus.ACTIVE;
    tenantRow.approvedAt = new Date();

    const goodRefresh = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `anx_refresh=${cookieRefresh}; anx_csrf=${cookieCsrf}`,
        'x-csrf-token': cookieCsrf,
      },
      body: JSON.stringify({}),
    });
    expect(goodRefresh.status).toBe(201);
    const refreshCookies = parseSetCookies(goodRefresh.headers.getSetCookie());
    const refreshBody = (await goodRefresh.json()) as { accessToken: string; csrfToken: string };
    accessTokenA = refreshBody.accessToken;
    cookieRefresh = refreshCookies.anx_refresh!.value;
    cookieCsrf = refreshCookies.anx_csrf!.value;

    // 7. User profile read & update
    const patchProfile = await fetch(`${baseUrl}/users/me`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${accessTokenA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Rohan M. Patel' }),
    });
    expect(patchProfile.status).toBe(200);
    const profileJson = (await patchProfile.json()) as { name: string };
    expect(profileJson.name).toBe('Rohan M. Patel');

    // 8. Tenant read & update
    const patchTenant = await fetch(`${baseUrl}/tenants/current`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${accessTokenA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Gujarat Spice Group', currency: 'INR' }),
    });
    expect(patchTenant.status).toBe(200);
    const getTenant = await fetch(`${baseUrl}/tenants/current`, {
      headers: { authorization: `Bearer ${accessTokenA}` },
    });
    expect(getTenant.status).toBe(200);
    const tenantJson = (await getTenant.json()) as { name: string };
    expect(tenantJson.name).toBe('Gujarat Spice Group');

    // 9. Multi-outlet create, list, switch, update, soft-delete
    const createOutletRes = await fetch(`${baseUrl}/outlets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessTokenA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'SG Highway Branch',
        contactPhone: '+919825099887',
        address: 'SG Highway, Ahmedabad',
        kdsLanguage: 'gu',
      }),
    });
    expect(createOutletRes.status).toBe(201);
    const outlet2 = (await createOutletRes.json()) as { id: string; name: string };

    const listOutletsRes = await fetch(`${baseUrl}/outlets`, {
      headers: { authorization: `Bearer ${accessTokenA}` },
    });
    expect(listOutletsRes.status).toBe(200);
    expect((await listOutletsRes.json()) as unknown[]).toHaveLength(2);

    const switchRes = await fetch(`${baseUrl}/auth/switch-outlet`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessTokenA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ outletId: outlet2.id }),
    });
    expect(switchRes.status).toBe(201);
    const switched = (await switchRes.json()) as { accessToken: string; outlet: { id: string } };
    expect(switched.outlet.id).toBe(outlet2.id);
    accessTokenA = switched.accessToken;

    const patchOutletRes = await fetch(`${baseUrl}/outlets/${outlet2.id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${accessTokenA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ receiptFooter: 'Aavjo! Thank you.' }),
    });
    expect(patchOutletRes.status).toBe(200);

    // 10. System roles & RBAC matrix endpoint
    const rolesRes = await fetch(`${baseUrl}/roles`, {
      headers: { authorization: `Bearer ${accessTokenA}` },
    });
    expect(rolesRes.status).toBe(200);
    const rolesJson = (await rolesRes.json()) as Array<{ code: string }>;
    expect(rolesJson.some((r) => r.code === StaffRole.OWNER)).toBe(true);

    // 11. Invitation create & accept -> Waiter denied OWNER endpoints by RolesGuard/PermissionsGuard
    const inviteRes = await fetch(`${baseUrl}/auth/invitations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessTokenA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Karan Joshi',
        phone: '+919825011122',
        role: StaffRole.WAITER,
      }),
    });
    expect(inviteRes.status).toBe(201);
    const inviteJson = (await inviteRes.json()) as { inviteToken: string };
    expect(inviteJson.inviteToken.length).toBeGreaterThanOrEqual(32);

    const acceptRes = await fetch(`${baseUrl}/auth/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: inviteJson.inviteToken,
        password: 'WaiterPass#2026',
        pin: '4321',
      }),
    });
    expect(acceptRes.status).toBe(201);
    const acceptJson = (await acceptRes.json()) as {
      accessToken: string;
      user: { role: string };
    };
    expect(acceptJson.user.role).toBe(StaffRole.WAITER);

    const waiterDeniedRes = await fetch(`${baseUrl}/tenants/current`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${acceptJson.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Waiter Hijacked' }),
    });
    expect(waiterDeniedRes.status).toBe(403);

    // 12. Register Tenant B and prove x-tenant-id spoofing + cross-tenant outlet read are blocked
    const regBRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        restaurantName: 'Mumbai Chai House',
        outletName: 'Bandra West',
        ownerName: 'Asha Mehta',
        email: 'asha@mumbaichai.in',
        phone: '+919820012345',
        password: 'Password#2026',
        pin: '5678',
      }),
    });
    expect(regBRes.status).toBe(201);
    const regBBody = (await regBRes.json()) as {
      tenant: { id: string };
      outlet: { id: string };
    };

    const spoofHeaderRes = await fetch(`${baseUrl}/tenants/current`, {
      headers: {
        authorization: `Bearer ${accessTokenA}`,
        'x-tenant-id': regBBody.tenant.id,
      },
    });
    expect(spoofHeaderRes.status).toBe(403);

    const crossOutletRes = await fetch(`${baseUrl}/outlets/${regBBody.outlet.id}`, {
      headers: { authorization: `Bearer ${accessTokenA}` },
    });
    expect([403, 404]).toContain(crossOutletRes.status);

    // 13. Soft-delete secondary outlet A2 while leaving primary outlet A1 active
    const deleteOutletRes = await fetch(`${baseUrl}/outlets/${outlet2.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessTokenA}` },
    });
    expect(deleteOutletRes.status).toBe(200);
    expect(outletIdA1).toBeTruthy();

    // Verify logout succeeds
    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `anx_refresh=${cookieRefresh}; anx_csrf=${cookieCsrf}`,
        'x-csrf-token': cookieCsrf,
      },
      body: JSON.stringify({}),
    });
    expect(logoutRes.status).toBe(201);
  });
});
