import { expect, test } from '@playwright/test';

const REAL_API = process.env.PLAYWRIGHT_REAL_API === '1';

test.describe('Milestone 1 Foundation Browser Flows', () => {
  test('landing page renders AutoNex SaaS branding and navigates to registration & login', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByText('AutoNex Restaurant OS')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Register Your Restaurant' })).toBeVisible();

    await page.getByRole('link', { name: 'Sign In' }).first().click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-identifier')).toBeVisible();
  });

  test('validates registration & login forms client-side via @autonex/validation Zod schemas', async ({
    page,
  }) => {
    await page.goto('/register');
    await page.getByTestId('reg-restaurant-name').fill('A');
    await page.getByTestId('reg-email').fill('not-an-email');
    await page.getByTestId('reg-pin').fill('12');
    await page.getByTestId('reg-submit').click();

    await expect(page.getByText('Restaurant name must be at least 2 characters')).toBeVisible();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByText('PIN must be 4 to 6 digits')).toBeVisible();

    await page.goto('/login');
    await page.getByTestId('login-identifier').fill('bad');
    await page.getByTestId('login-password').fill('123');
    await page.getByTestId('login-submit').click();
    await expect(page.getByText('Enter your email or phone number')).toBeVisible();
    await expect(page.getByText('Password must be at least 6 characters')).toBeVisible();
  });

  test('completes restaurant onboarding, outlet creation/switching, settings update, team invite & logout', async ({
    page,
  }) => {
    test.skip(REAL_API, 'Run dedicated live-API seed script separately when PLAYWRIGHT_REAL_API=1');

    const tenantId = '11111111-1111-4111-8111-111111111111';
    const outlet1Id = '33333333-3333-4333-8333-333333333333';
    const outlet2Id = '44444444-4444-4444-8444-444444444444';
    const userId = '55555555-5555-4555-8555-555555555555';

    let currentTenantName = 'Gujarat Spice Kitchen';
    let currentUserName = 'Rohan Patel';
    let currentUserEmail = 'rohan@gujaratspice.in';
    let currentOutletId = outlet1Id;
    const outlets = [
      {
        id: outlet1Id,
        tenantId,
        name: 'Navrangpura Flagship',
        contactPhone: '+919825012345',
        address: 'CG Road, Ahmedabad',
        logoUrl: null,
        timezone: 'Asia/Kolkata',
        gstin: null,
        gstRateBps: 500,
        taxMode: 'EXCLUSIVE',
        roundOffEnabled: true,
        requireWaiterApproval: true,
        tablePinEnabled: true,
        isActive: true,
        settings: {
          id: 'os-1',
          tenantId,
          outletId: outlet1Id,
          taxMode: 'EXCLUSIVE',
          gstRateBps: 500,
          roundOffEnabled: true,
          requireWaiterApproval: true,
          tablePinEnabled: true,
          kdsLanguage: 'en',
          receiptFooter: null,
        },
      },
    ];
    const invitations: Array<Record<string, unknown>> = [];
    const seenHeaders: Array<{ url: string; csrf: string | undefined }> = [];

    await page.addInitScript(() => {
      document.cookie = 'anx_csrf=e2e-csrf-token-value; path=/';
    });

    await page.route('**/api/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = req.method();
      const headers = req.headers();
      seenHeaders.push({ url: path, csrf: headers['x-csrf-token'] });

      if (path === '/auth/register' && method === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            accessToken: 'e2e-jwt-token',
            refreshToken: 'e2e-refresh-token',
            csrfToken: 'e2e-csrf-token-value',
            tenant: {
              id: tenantId,
              name: currentTenantName,
              slug: 'gujarat-spice-kitchen',
              status: 'ACTIVE',
            },
            outlet: { id: outlet1Id, name: 'Navrangpura Flagship', timezone: 'Asia/Kolkata' },
            user: {
              id: userId,
              name: 'Rohan Patel',
              email: 'rohan@gujaratspice.in',
              phone: '+919825012345',
              role: 'OWNER',
            },
          }),
        });
      }

      if (path === '/users/me' && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: userId,
            name: currentUserName,
            email: currentUserEmail,
            phone: '+919825012345',
            isSuperAdmin: false,
            mfaEnabled: false,
            tenantId,
            outletId: currentOutletId,
            role: 'OWNER',
            tenantStatus: 'ACTIVE',
            permissions: ['tenant:read', 'tenant:update', 'outlet:create', 'outlet:read', 'outlet:update'],
            memberships: outlets.map((o) => ({
              membershipId: `mem-${o.id}`,
              tenantId,
              tenantName: currentTenantName,
              tenantStatus: 'ACTIVE',
              outletId: o.id,
              outletName: o.name,
              role: 'OWNER',
            })),
          }),
        });
      }

      if (path === '/users/me' && method === 'PATCH') {
        const body = JSON.parse(req.postData() ?? '{}') as { name?: string; email?: string };
        if (body.name) currentUserName = body.name;
        if (body.email) currentUserEmail = body.email;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: userId,
            name: currentUserName,
            email: currentUserEmail,
            phone: '+919825012345',
            isSuperAdmin: false,
            mfaEnabled: false,
            tenantId,
            outletId: currentOutletId,
            role: 'OWNER',
            tenantStatus: 'ACTIVE',
            permissions: ['tenant:read', 'tenant:update', 'outlet:create', 'outlet:read', 'outlet:update'],
            memberships: outlets.map((o) => ({
              membershipId: `mem-${o.id}`,
              tenantId,
              tenantName: currentTenantName,
              tenantStatus: 'ACTIVE',
              outletId: o.id,
              outletName: o.name,
              role: 'OWNER',
            })),
          }),
        });
      }

      if (path === '/tenants/current' && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: tenantId,
            name: currentTenantName,
            slug: 'gujarat-spice-kitchen',
            status: 'ACTIVE',
            approvedAt: new Date().toISOString(),
            outletCount: outlets.length,
            settings: {
              id: 'ts-1',
              tenantId,
              currency: 'INR',
              locale: 'en-IN',
              defaultTimezone: 'Asia/Kolkata',
              onboardingCompleted: false,
              onboardingStep: 1,
            },
          }),
        });
      }

      if (path === '/tenants/current' && method === 'PATCH') {
        const body = JSON.parse(req.postData() ?? '{}') as { name?: string };
        if (body.name) currentTenantName = body.name;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: tenantId,
            name: currentTenantName,
            slug: 'gujarat-spice-kitchen',
            status: 'ACTIVE',
            approvedAt: new Date().toISOString(),
            settings: { currency: 'INR', locale: 'en-IN', defaultTimezone: 'Asia/Kolkata' },
          }),
        });
      }

      if (path === '/outlets' && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(outlets),
        });
      }

      if (path === '/outlets' && method === 'POST') {
        const body = JSON.parse(req.postData() ?? '{}') as {
          name: string;
          contactPhone: string;
          address?: string;
        };
        const created = {
          ...outlets[0],
          id: outlet2Id,
          name: body.name,
          contactPhone: body.contactPhone,
          address: body.address ?? null,
        };
        outlets.push(created);
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(created),
        });
      }

      if (path === '/auth/switch-outlet' && method === 'POST') {
        const body = JSON.parse(req.postData() ?? '{}') as { outletId: string };
        currentOutletId = body.outletId;
        const found = outlets.find((o) => o.id === currentOutletId) ?? outlets[0];
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            accessToken: 'e2e-jwt-switched',
            refreshToken: 'e2e-refresh-switched',
            outlet: { id: found.id, name: found.name, timezone: found.timezone },
            role: 'OWNER',
            permissions: ['tenant:read', 'tenant:update', 'outlet:create'],
          }),
        });
      }

      if (path === '/outlet/checklist') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            tenantStatus: 'ACTIVE',
            steps: {
              profileComplete: true,
              adminApproved: true,
              staffAdded: false,
              menuConfigured: false,
              tablesConfigured: false,
              qrGenerated: false,
            },
            counts: { staffCount: 1, menuItemsCount: 0, tablesCount: 0, activeQrCount: 0 },
            goLiveReady: false,
          }),
        });
      }

      if (path === '/subscriptions/current') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tenant: { status: 'ACTIVE' }, subscription: null }),
        });
      }

      if (path === '/auth/staff') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              membershipId: 'mem-1',
              userId,
              name: 'Rohan Patel',
              phone: '+919825012345',
              email: 'rohan@gujaratspice.in',
              role: 'OWNER',
              isActive: true,
            },
          ]),
        });
      }

      if (path === '/auth/invitations' && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(invitations),
        });
      }

      if (path === '/auth/invitations' && method === 'POST') {
        const body = JSON.parse(req.postData() ?? '{}') as {
          name: string;
          phone: string;
          role: string;
        };
        const created = {
          id: 'inv-1',
          tenantId,
          outletId: currentOutletId,
          email: null,
          phone: body.phone,
          name: body.name,
          role: body.role,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
        };
        invitations.push(created);
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ invitation: created, inviteToken: 'demo-invite-token-123456' }),
        });
      }

      if (path === '/roles') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              code: 'OWNER',
              name: 'Restaurant Owner',
              description: 'Full access',
              isSystem: true,
              permissions: ['tenant:read', 'tenant:update'],
            },
          ]),
        });
      }

      if (path === '/auth/sessions') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      }

      if (path === '/auth/logout' && method === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      }

      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    // 1. Register restaurant owner
    await page.goto('/register');
    await page.getByTestId('reg-restaurant-name').fill('Gujarat Spice Kitchen');
    await page.getByTestId('reg-outlet-name').fill('Navrangpura Flagship');
    await page.getByTestId('reg-owner-name').fill('Rohan Patel');
    await page.getByTestId('reg-phone').fill('+919825012345');
    await page.getByTestId('reg-email').fill('rohan@gujaratspice.in');
    await page.getByTestId('reg-password').fill('Password#2026');
    await page.getByTestId('reg-pin').fill('1234');
    await page.getByTestId('reg-address').fill('CG Road, Ahmedabad');
    await page.getByTestId('reg-submit').click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('overview-tenant-name')).toHaveText('Gujarat Spice Kitchen');

    // 2. Navigate to Outlets, create second outlet & switch outlet from Header selector
    await page.getByRole('link', { name: 'Outlets' }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/outlets$/);
    await page.getByTestId('new-outlet-name').fill('SG Highway Branch');
    await page.getByTestId('new-outlet-phone').fill('+919825099887');
    await page.getByTestId('new-outlet-address').fill('Plot 12, SG Highway, Ahmedabad');
    await page.getByTestId('create-outlet-submit').click();
    await expect(page.getByText('SG Highway Branch').first()).toBeVisible();

    await page.getByTestId('outlet-selector').selectOption(outlet2Id);
    await expect(page.getByTestId('outlet-selector')).toHaveValue(outlet2Id);

    // 3. Navigate to Team & Roles, send staff invitation
    await page.getByRole('link', { name: 'Team & Roles' }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/team$/);
    await page.getByTestId('invite-name').fill('Karan Joshi');
    await page.getByTestId('invite-phone').fill('+919825011122');
    await page.getByTestId('invite-role').selectOption('WAITER');
    await page.getByTestId('invite-submit').click();
    await expect(page.getByText('demo-invite-token-123456')).toBeVisible();
    await expect(page.getByTestId('invite-share-link')).toHaveAttribute(
      'href',
      '/invite?token=demo-invite-token-123456',
    );

    // 4. Navigate to Settings, update personal profile + restaurant brand name
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/settings$/);
    await page.getByTestId('settings-profile-name').fill('Rohan M. Patel');
    await page.getByTestId('save-profile-settings').click();
    await expect(page.getByTestId('settings-success')).toBeVisible();

    await page.getByTestId('settings-tenant-name').fill('Gujarat Spice Group');
    await page.getByTestId('save-tenant-settings').click();
    await expect(page.getByTestId('settings-success')).toBeVisible();

    // Verify CSRF header was propagated automatically on authenticated requests
    expect(seenHeaders.some((h) => h.csrf === 'e2e-csrf-token-value')).toBe(true);

    // 5. Sign out back to /login
    await page.getByTestId('logout-button').click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('validates /invite client-side schema and accepts staff invitation into /dashboard', async ({
    page,
  }) => {
    test.skip(REAL_API, 'Run dedicated live-API seed script separately when PLAYWRIGHT_REAL_API=1');

    const tenantId = '11111111-1111-4111-8111-111111111111';
    const outletId = '33333333-3333-4333-8333-333333333333';
    const waiterId = '77777777-7777-4777-8777-777777777777';

    await page.route('**/api/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = req.method();

      if (path === '/auth/invitations/accept' && method === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            accessToken: 'e2e-waiter-jwt',
            refreshToken: 'e2e-waiter-refresh',
            csrfToken: 'e2e-waiter-csrf',
            user: {
              id: waiterId,
              name: 'Karan Joshi',
              email: null,
              phone: '+919825011122',
              role: 'WAITER',
              tenantId,
              outletId,
            },
          }),
        });
      }

      if (path === '/users/me') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: waiterId,
            name: 'Karan Joshi',
            email: null,
            phone: '+919825011122',
            isSuperAdmin: false,
            mfaEnabled: false,
            tenantId,
            outletId,
            role: 'WAITER',
            tenantStatus: 'ACTIVE',
            permissions: ['outlet:read', 'table:read', 'order:create'],
            memberships: [
              {
                membershipId: 'mem-waiter-1',
                tenantId,
                tenantName: 'Gujarat Spice Kitchen',
                tenantStatus: 'ACTIVE',
                outletId,
                outletName: 'Navrangpura Flagship',
                role: 'WAITER',
              },
            ],
          }),
        });
      }

      if (path === '/tenants/current') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: tenantId,
            name: 'Gujarat Spice Kitchen',
            slug: 'gujarat-spice-kitchen',
            status: 'ACTIVE',
            approvedAt: new Date().toISOString(),
            outletCount: 1,
            settings: {
              currency: 'INR',
              locale: 'en-IN',
              defaultTimezone: 'Asia/Kolkata',
              onboardingCompleted: false,
              onboardingStep: 2,
            },
          }),
        });
      }

      if (path === '/outlets') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: outletId,
              tenantId,
              name: 'Navrangpura Flagship',
              contactPhone: '+919825012345',
              address: 'CG Road, Ahmedabad',
              timezone: 'Asia/Kolkata',
              gstRateBps: 500,
              taxMode: 'EXCLUSIVE',
              isActive: true,
              settings: null,
            },
          ]),
        });
      }

      if (path === '/outlet/checklist') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            tenantStatus: 'ACTIVE',
            steps: {
              profileComplete: true,
              adminApproved: true,
              staffAdded: true,
              menuConfigured: false,
              tablesConfigured: false,
              qrGenerated: false,
            },
            counts: { staffCount: 2, menuItemsCount: 0, tablesCount: 0, activeQrCount: 0 },
            goLiveReady: false,
          }),
        });
      }

      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/invite?token=demo-invite-token-123456');
    await expect(page.getByTestId('invite-accept-token')).toHaveValue('demo-invite-token-123456');

    // Trigger client-side Zod validation failure for short PIN
    await page.getByTestId('invite-accept-pin').fill('12');
    await page.getByTestId('invite-accept-submit').click();
    await expect(page.getByText('PIN must be 4 to 6 digits')).toBeVisible();

    // Valid invitation acceptance navigates into staff dashboard
    await page.getByTestId('invite-accept-name').fill('Karan Joshi');
    await page.getByTestId('invite-accept-password').fill('WaiterPass#2026');
    await page.getByTestId('invite-accept-pin').fill('4321');
    await page.getByTestId('invite-accept-submit').click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('overview-tenant-name')).toHaveText('Gujarat Spice Kitchen');
  });
});

