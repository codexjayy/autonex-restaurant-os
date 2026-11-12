# AutoNex Restaurant OS — 90-Day Execution Plan

**Total Calendar Timeline:** 90 Days (~13 Weeks, overlapping phases)  
**Total Estimated Effort:** 24.0 Person-Weeks (Recommended team: 2 Full-Stack Engineers + shared QA/UI)  
**Architecture Baseline:** Next.js · NestJS Modular Monolith · PostgreSQL + Prisma + RLS · Transactional Outbox

---

## 90-Day Overlapping Roadmap Summary

| Phase | Window | Overlap With | Primary Modules | Effort | Key Milestone |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. SaaS Foundation + Registration** | Days 1–16 | Phase 2 (Days 12–16) | `identity`, `tenancy` | 3.0 PW | Multi-tenant RLS core + Outlet onboarding live |
| **2. Menu Management + QR Gen** | Days 12–28 | Phase 1, Phase 3 | `menus`, `tables` | 2.5 PW | Digital menu CRUD + Printable table QRs |
| **3. Customer Mobile Ordering** | Days 22–42 | Phase 2, Phase 4 | `ordering` | 3.5 PW | `< 2.5s` 4G QR menu + Idempotent order API |
| **4. KDS + Real-Time Orders** | Days 32–52 | Phase 3, Phase 5 | `kitchen`, Outbox | 3.5 PW | Outbox Relay + Socket.IO KDS + 4s polling fallback |
| **5. Dining Session + Multi-Order** | Days 45–63 | Phase 4, Phase 6 | `sessions`, `ordering` | 2.5 PW | Single running table bill + `ADD-ON` round flow |
| **6. Final Billing + Payments** | Days 54–74 | Phase 5, Phase 7 | `billing`, `payments` | 3.5 PW | GST bill + Razorpay UPI QR/Webhook + Cash fallback |
| **7. Super Admin + Subscriptions** | Days 65–80 | Phase 6, Phase 8 | `admin`, `subscriptions` | 2.5 PW | SaaS plans/trial locks + Super Admin console |
| **8. Testing + Pilot Launch** | Days 72–90 | Phase 6, Phase 7 | All Modules + Infra | 3.0 PW | RLS audit, rush load test, 2–3 pilot outlets live |

---

## Phase 1: SaaS Foundation + Restaurant Registration (Days 1–16)

- **Required Screens:**
  - Restaurant Owner Sign-up / Login (Phone + OTP/PIN).
  - Outlet Setup Wizard (Restaurant name, address, GSTIN/GST %, logo).
  - Staff & Role Management screen (add Waiter, Cashier, Kitchen PIN users).
- **Backend Functionality:**
  - Scaffold Next.js + NestJS modular monolith, Docker Compose local stack, and CI lint/test pipeline.
  - Implement `identity` (JWT + `HttpOnly` refresh cookie, PIN auth, `RolesGuard`) and `tenancy` (`TenantContext` via `AsyncLocalStorage`).
  - Configure Prisma `$extends` tenant filter + transaction wrapper executing `SET LOCAL app.current_tenant_id`.
- **Database Requirements:**
  - Tables: `tenants`, `users`, `refresh_tokens`.
  - Enable PostgreSQL Row-Level Security (RLS) policies on all tenant-scoped tables from Day 1; create non-superuser app DB role (so RLS is enforced).
- **Testing Scenarios:**
  - Tenant A JWT cannot read or mutate Tenant B users/settings (verify both App filter and raw SQL under RLS).
  - Invalid/expired staff PIN locks out after 5 failed attempts; RBAC blocks Waiter from Owner settings.
- **Dependencies:** None (Greenfield kickoff; Cloud/Mumbai `ap-south-1` staging DB provisioned by Day 5).
- **Effort Estimate:** **3.0 person-weeks** (Backend 1.8 PW, Frontend 0.8 PW, DevOps/QA 0.4 PW).
- **Common Mistakes:**
  - Connecting Prisma as Postgres `superuser` or `BYPASSRLS` role—silently disables RLS!
  - Deferring `tenant_id` and RLS to later phases, forcing painful schema rewrites.

---

## Phase 2: Menu Management + QR Generation (Days 12–28)

- **Required Screens:**
  - Menu Manager (Categories, Dish list, Veg/Non-Veg/Egg toggle, Half/Full variants, `In Stock / Out of Stock` switch).
  - Table Floor Setup & Printable QR Sheet (PDF/PNG download with Table # label and restaurant branding).
- **Backend Functionality:**
  - `menus` module: CRUD for categories, items, variants, and instant `in_stock` toggle; S3/R2 pre-signed upload with `WebP` compression.
  - `tables` module: Table CRUD, HMAC-signed QR payload (`tenant_id + table_id + qr_version`), QR rotation/regeneration endpoint.
- **Database Requirements:**
  - Tables: `menu_categories`, `menu_items`, `menu_item_variants`, `tables` (all with `tenant_id`, composite indexes `(tenant_id, category_id)` and `(tenant_id, table_number)`).
- **Testing Scenarios:**
  - Toggling an item `Out of Stock` immediately blocks ordering on public menu API.
  - Rotating a table QR version invalidates old printed QR tokens cleanly.
- **Dependencies:** Phase 1 auth, `tenancy` context, and RLS setup; S3/R2 bucket configured.
- **Effort Estimate:** **2.5 person-weeks** (Backend 1.2 PW, Frontend 1.0 PW, QA 0.3 PW).
- **Common Mistakes:**
  - Storing uncompressed 3–5 MB phone photos directly, blowing up the `< 2.5s` 4G menu load target.
  - Embedding sequential `table_id` without a signed token/version, allowing external URL guessing.

---

## Phase 3: Customer Mobile Ordering (Days 22–42)

- **Required Screens:**
  - No-App Customer QR Web Menu (Veg/Non-Veg filter, search, dish modifiers, cooking notes like *Jain / less spicy*).
  - Cart Drawer + Order Confirmation screen (explicit review step to avoid accidental orders) + Order Placed status page.
  - Basic Staff Assisted Ordering screen (Waiter selects table and punches verbal orders).
- **Backend Functionality:**
  - Public QR landing endpoint validating signed QR token and issuing a short-lived `table_session_token`.
  - `ordering` module: Server-side price lookup (never trust client prices), stock check, `Idempotency-Key` deduplication (`24h` TTL), and price snapshot persistence.
  - Rate limiting via `ThrottlerGuard` on public QR order routes.
- **Database Requirements:**
  - Tables: `orders`, `order_items` (with `item_name_snapshot`, `unit_price_snapshot`, `modifiers_jsonb`), `idempotency_keys` (`UNIQUE (tenant_id, key)`).
- **Testing Scenarios:**
  - Double-tapping **Place Order** on flaky 4G creates exactly 1 order and returns the same cached response.
  - Changing a dish price mid-service does not alter already-placed order snapshots.
- **Dependencies:** Phase 2 `menus` and `tables` QR tokens.
- **Effort Estimate:** **3.5 person-weeks** (Backend 1.6 PW, Frontend 1.5 PW, QA 0.4 PW).
- **Common Mistakes:**
  - Trusting cart item prices sent from the browser instead of computing totals from DB on the server.
  - Forcing customer OTP/login on QR scan, killing dine-in conversion.

---

## Phase 4: KDS with Real-Time Orders (Days 32–52)

- **Required Screens:**
  - Kitchen Display System (KDS) screen: High-contrast ticket cards, elapsed timer, color alerts, prep notes, 2-tap `Preparing` / `Ready` buttons, audio chime, and offline warning banner.
  - Thermal KOT Print View (58mm / 80mm browser print CSS fallback).
- **Backend Functionality:**
  - `outbox_events` table + `OutboxRelay` worker (`SELECT ... FOR UPDATE SKIP LOCKED` every ~250ms).
  - Socket.IO Gateway authenticating staff JWT / `table_session_token` into scoped rooms (`tenant:{id}:kitchen`, `tenant:{id}:staff`).
  - `kitchen` module: `NEW → PREPARING → READY → SERVED` state machine + cursor-based polling endpoint (`GET /kds/orders?since=`).
- **Database Requirements:**
  - Tables: `kots`, `kot_items`, `outbox_events` (`status`, `retry_count`, `available_at`, partial index on `status = 'PENDING'`).
  - Commit `Order` + `KOT` + `OutboxEvent` inside one Prisma `$transaction`.
- **Testing Scenarios:**
  - Simulated DB rollback after order validation produces zero `outbox_events` and zero phantom KOTs on KDS.
  - Dropping Wi-Fi on KDS tablet for 30s triggers offline banner, switches to 4s polling, and catches up missed KOTs cleanly on reconnect.
- **Dependencies:** Phase 3 `ordering` write flow; Socket.IO setup in NestJS.
- **Effort Estimate:** **3.5 person-weeks** (Backend 2.0 PW, Frontend 1.1 PW, QA 0.4 PW).
- **Common Mistakes:**
  - Emitting Socket.IO events directly inside HTTP controllers before transaction commit (creates ghost KOTs).
  - Missing `SKIP LOCKED` in Outbox Relay, causing duplicate KOT chimes when running 2+ workers.

---

## Phase 5: Dining Session + Multi-Order (Days 45–63)

- **Required Screens:**
  - Waiter / Counter Live Table Floor View (`Available`, `Occupied`, `Bill Requested` badges + Ready-to-Serve alerts).
  - Customer Live Running Bill view (all rounds combined + "Order More" button).
  - Staff Order Edit / Pre-Prep Cancel modal (for verbal changes before kitchen hits `Preparing`).
- **Backend Functionality:**
  - `sessions` module: Auto-open a table session on first customer/waiter order; link subsequent scans of the same table QR to the same active session.
  - Tag Round 2+ KOTs automatically as `ADD-ON`; enforce cancellation lock once KOT status reaches `PREPARING` (unless Cashier/Owner overrides).
  - Optional Waiter-Approve / 4-digit Table PIN guard toggle per restaurant to block prank QR orders.
- **Database Requirements:**
  - Tables: `table_sessions` (`ACTIVE`, `BILL_REQUESTED`, `CLOSED`), partial unique index `UNIQUE (tenant_id, table_id) WHERE status != 'CLOSED'` to guarantee only one active session per table.
- **Testing Scenarios:**
  - Two family members scanning the same Table #4 QR see the shared cart/running bill and add rounds to one session.
  - Concurrent first-order requests on an `Available` table race cleanly without opening two active sessions.
- **Dependencies:** Phase 3 `ordering` + Phase 4 `kitchen` WS sync.
- **Effort Estimate:** **2.5 person-weeks** (Backend 1.3 PW, Frontend 0.9 PW, QA 0.3 PW).
- **Common Mistakes:**
  - Allowing multiple `ACTIVE` sessions on the same table under race conditions (fixed via partial unique index).
  - Letting customers cancel items after the chef already started cooking.

---

## Phase 6: Final Billing + Payments (Days 54–74)

- **Required Screens:**
  - Cashier Billing & Settlement Screen (itemized consolidated bill, CGST/SGST breakdown, manager discount modal, `UPI / Cash / Card` buttons).
  - Customer Checkout & Digital Receipt Screen (Request Bill → Dynamic UPI QR / App Intent → Paid Receipt).
  - Owner Daily Summary Dashboard (Today's Orders, Gross/Net Revenue, Cash vs. UPI vs. Card split, Top 5 dishes).
- **Backend Functionality:**
  - `billing` module: Consolidate session items, calculate configurable GST (e.g., 2.5% CGST + 2.5% SGST), generate sequential invoice number per tenant.
  - `payments` module: Razorpay dynamic UPI QR / order API, `HMAC-SHA256` webhook handler (idempotent by `gateway_payment_id`), plus cashier `Mark Paid (Cash/Card/UPI Manual)` override.
  - Atomic settlement transaction: `Payment = PAID`, `Session = CLOSED`, `Table = AVAILABLE`, `OutboxEvent` emitted.
- **Database Requirements:**
  - Tables: `bills`, `payments`, `tenant_invoice_counters` (atomic row lock for gap-free bill numbers).
  - Immutable `bill_snapshot_jsonb` so menu/tax edits later never mutate historical bills.
- **Testing Scenarios:**
  - Duplicate Razorpay payment webhooks settle the bill once and reject/ignore replays safely.
  - Webhook lag scenario: Cashier verifies counter UPI soundbox and completes `UPI_MANUAL`, freeing the table immediately; late webhook reconciles without double-counting.
- **Dependencies:** Phase 5 `sessions` + Razorpay Sandbox/Live merchant test keys.
- **Effort Estimate:** **3.5 person-weeks** (Backend 1.9 PW, Frontend 1.1 PW, QA 0.5 PW).
- **Common Mistakes:**
  - Using floating-point arithmetic (`float`) for currency/GST instead of integer **paise** (`INR * 100`).
  - Blocking table reset when UPI bank webhooks delay during evening rush instead of giving a cashier override.

---

## Phase 7: Super Admin + Subscriptions (Days 65–80)

- **Required Screens:**
  - Super Admin Console: Restaurant list, onboard/suspend outlet, daily order/payment health telemetry, audit log viewer.
  - Owner Billing & Plan Banner: Trial countdown, plan status, grace-period warning.
- **Backend Functionality:**
  - `subscriptions` module: Trial (`14-day`), Active, Grace (`3-day`), and Locked (`read-only` billing/menu, blocks new ordering) guard integrated into `TenantGuard`.
  - `admin` module: Restricted `SUPER_ADMIN` endpoints using audited bypass DB role + immutable `audit_logs` on every admin action.
- **Database Requirements:**
  - Tables: `plans`, `subscriptions`, `subscription_invoices`, `audit_logs`.
- **Testing Scenarios:**
  - Expired trial + grace period blocks new customer QR orders gracefully while still letting the Owner settle open tables and export daily summary.
  - Non-super-admin JWT receives `403 Forbidden` on all `/admin/*` endpoints.
- **Dependencies:** Phase 1 `identity` + Phase 6 `billing` summary data.
- **Effort Estimate:** **2.5 person-weeks** (Backend 1.3 PW, Frontend 0.9 PW, QA 0.3 PW).
- **Common Mistakes:**
  - Hard-locking an expired restaurant mid-dinner rush so they cannot even close active tables or collect bills.
  - Exposing Super Admin APIs without IP/MFA/audit-trail protection.

---

## Phase 8: Testing + Launch (Days 72–90)

- **Required Screens:**
  - No new feature screens; polish mobile responsiveness, Hindi/regional-friendly icons, print CSS, and error/retry UX across all views.
- **Backend Functionality:**
  - Automated E2E test suite covering QR Scan → Order → KOT → Add-on → UPI/Cash Checkout → Table Reset.
  - Production hardening: Cloudflare CDN + WAF rules, `PgBouncer` tuning, automated daily Postgres backups + PITR verification, Sentry error tracking + uptime alerts (peak dining hours monitoring).
- **Database Requirements:**
  - Verify all migration rollbacks, run `EXPLAIN ANALYZE` on hot KDS/ordering queries, validate RLS policies across every table via automated CI security script.
- **Testing Scenarios:**
  - **Security:** Automated cross-tenant penetration test suite across every REST & WebSocket event.
  - **Load:** k6/Artillery simulation of 100 outlets × concurrent dinner rush (`< 2s` KDS sync, `< 2.5s` 4G menu load).
  - **Field UAT:** 7-day live shadow/pilot run at 2–3 local Indian restaurants (testing actual 4G dead zones, 80mm thermal printers, and UPI soundbox reconciliation).
- **Dependencies:** Feature freeze from Phases 1–7 by Day 78; pilot restaurant agreements and Razorpay KYC approved.
- **Effort Estimate:** **3.0 person-weeks** (QA/Load Testing 1.4 PW, DevOps/Hardening 0.9 PW, Bug Fixes/Pilot Support 0.7 PW).
- **Common Mistakes:**
  - Skipping real-world testing on ₹8,000–₹12,000 budget Android phones, 80mm thermal printers, and weak kitchen Wi-Fi before launch.
  - Deploying without verifying PITR backup restore or peak-hour alert notifications.

