# AutoNex Restaurant OS — REST API & WebSocket Contract

**Base URL:** `/api/v1` · **WebSocket Namespace:** `/realtime` (Socket.IO)  
**Money Unit:** Integer **paise** (`100` paise = ₹1) · **Tax Unit:** Basis points (`500` bps = `5.00%`)

---

## 1. Conventions, Auth & Error Format

### Authentication Headers
- **Staff / Owner / Super Admin:** `Authorization: Bearer <access_jwt>` (15m TTL; refresh token in `HttpOnly` cookie `anx_refresh`).
- **Customer QR Session:** `X-Table-Session: <signed_guest_session_token>` (bound to `tenantId`, `outletId`, `tableId`, `sessionId`, `guestId`).
- **Required Idempotency Header:** `Idempotency-Key: <uuid-v4>` mandatory on `POST /orders` and `POST /bills/:billId/payments/upi-qr`.

### Standard Error Response
```json
{
  "statusCode": 409,
  "code": "OUT_OF_STOCK",
  "message": "Paneer Tikka is currently out of stock.",
  "details": { "menuItemId": "uuid", "itemName": "Paneer Tikka" },
  "requestId": "req_01J...",
  "timestamp": "2026-11-11T15:02:11.000Z"
}
```

**Key Domain Error Codes:** `OUT_OF_STOCK`, `TABLE_PIN_REQUIRED`, `SESSION_NOT_APPROVED`, `KOT_ALREADY_PREPARING`, `IDEMPOTENCY_CONFLICT`, `SUBSCRIPTION_LOCKED`, `INVALID_QR_TOKEN`.

---

## 2. REST API Endpoints (By Module)

### 2.1 `identity` & `tenancy`
| Method & Path | Auth / Roles | Request Body | Response (`200` / `201`) |
| :--- | :--- | :--- | :--- |
| `POST /auth/register` | Public | `{ restaurantName, outletName, ownerName, phone, password, pin, gstin?, gstRateBps? }` | `{ tenant, outlet, user, accessToken }` *(starts 14-day `TRIAL`)* |
| `POST /auth/login` | Public | `{ phone, password }` | `{ accessToken, user, memberships[] }` *(sets refresh cookie)* |
| `POST /auth/staff-pin` | Public | `{ outletId, phone, pin }` | `{ accessToken, membership: { id, role, tenantId, outletId } }` |
| `POST /auth/refresh` | Cookie | `—` | `{ accessToken }` |
| `POST /auth/logout` | Bearer | `—` | `{ ok: true }` |
| `GET /staff` | `OWNER` | `—` | `{ staff: [{ membershipId, name, phone, role, isActive }] }` |
| `POST /staff` | `OWNER` | `{ name, phone, role, pin }` | `{ membershipId, role }` |
| `PATCH /staff/:membershipId` | `OWNER` | `{ role?, pin?, isActive? }` | `{ membershipId, updated: true }` |
| `GET /outlet/settings` | `OWNER`, `CASHIER` | `—` | `{ id, name, phone, address, gstin, gstRateBps, requireWaiterApproval, tablePinEnabled }` |
| `PATCH /outlet/settings` | `OWNER` | `{ name?, gstin?, gstRateBps?, requireWaiterApproval?, tablePinEnabled? }` | `{ updated: true }` |
| `GET /outlet/summary/daily` | `OWNER`, `CASHIER` | Query: `?date=2026-11-11` | `{ totalOrders, paidBills, grossPaise, discountPaise, gstPaise, netPaise, byMethod: { UPI_GATEWAY, UPI_MANUAL, CASH, CARD }, topItems[] }` |

### 2.2 `menus`
| Method & Path | Auth / Roles | Request Body | Response (`200` / `201`) |
| :--- | :--- | :--- | :--- |
| `GET /menus` | Staff or `X-Table-Session` | Query: `?includeInactive=false` | `{ categories: [{ id, name, sortOrder, items: [{ id, name, dietaryType, basePricePaise, inStock, imageUrl, modifierGroups[] }] }] }` |
| `POST /menus/categories` | `OWNER` | `{ name, sortOrder? }` | `{ id, name }` |
| `POST /menus/items` | `OWNER` | `{ categoryId, name, description?, dietaryType, basePricePaise, imageUrl?, modifierGroups? }` | `{ id, name }` |
| `PATCH /menus/items/:id` | `OWNER` | `{ name?, categoryId?, dietaryType?, basePricePaise?, isActive? }` | `{ id, updated: true }` |
| `PATCH /menus/items/:id/stock` | `OWNER`, `CASHIER`, `KITCHEN` | `{ inStock: boolean }` | `{ id, inStock }` *(emits `menu.stock_updated`)* |
| `POST /menus/upload-url` | `OWNER` | `{ fileName, contentType: "image/webp" }` | `{ uploadUrl, publicUrl }` |

### 2.3 `tables` & `sessions`
| Method & Path | Auth / Roles | Request Body / Query | Response (`200` / `201`) |
| :--- | :--- | :--- | :--- |
| `GET /tables` | `WAITER`, `CASHIER`, `OWNER` | `—` | `{ tables: [{ id, tableNumber, label, capacity, status, activeSessionId?, qrVersion }] }` |
| `POST /tables` | `OWNER` | `{ tableNumber, label?, capacity? }` | `{ id, tableNumber, qrToken, qrUrl }` |
| `POST /tables/:id/rotate-qr` | `OWNER` | `—` | `{ tableId, qrVersion, qrToken, qrUrl }` *(revokes old token)* |
| `GET /tables/:id/qr-pdf` | `OWNER` | `—` | `application/pdf` printable Table QR tent card |
| `GET /public/qr/:qrToken` | Public | `—` | `{ outlet: { id, name, requireWaiterApproval, tablePinEnabled }, table: { id, tableNumber }, activeSession?, menu, guestSessionToken? }` |
| `POST /public/sessions/join` | Public (QR token) | `{ qrToken, tablePin?, guestLabel? }` | `{ guestSessionToken, session: { id, status, isApproved, roundCount } }` |
| `GET /sessions` | `WAITER`, `CASHIER`, `OWNER` | Query: `?status=ACTIVE,BILL_REQUESTED` | `{ sessions: [{ id, tableNumber, status, isApproved, subtotalPaise, readyKotCount }] }` |
| `GET /sessions/:id` | Staff or `X-Table-Session` | `—` | `{ id, status, tableNumber, orders[], runningSubtotalPaise, bill? }` |
| `POST /sessions/:id/approve` | `WAITER`, `CASHIER`, `OWNER` | `—` | `{ id, isApproved: true }` |
| `POST /sessions/:id/request-bill` | Staff or `X-Table-Session` | `—` | `{ sessionId, status: "BILL_REQUESTED", bill }` *(emits `session.bill_requested`)* |

### 2.4 `ordering` & `kitchen`
- **`POST /orders`** *(Auth: `X-Table-Session` OR Staff `WAITER`/`CASHIER`/`OWNER`; Header: `Idempotency-Key` required)*
  ```json
  // Request
  {
    "sessionId": "uuid",
    "notes": "Serve starters first",
    "items": [
      {
        "menuItemId": "uuid",
        "quantity": 2,
        "modifierOptionIds": ["uuid_full", "uuid_less_spicy"],
        "prepNotes": "No onion-garlic (Jain)"
      }
    ]
  }
  // Response (201 Created)
  {
    "id": "order_uuid",
    "sessionId": "session_uuid",
    "roundNumber": 2,
    "kotNumber": 47,
    "isAddOn": true,
    "kitchenStatus": "NEW",
    "subtotalPaise": 52000,
    "items": [
      {
        "id": "oi_uuid",
        "itemNameSnapshot": "Paneer Tikka",
        "unitPricePaise": 26000,
        "quantity": 2,
        "lineTotalPaise": 52000
      }
    ]
  }
  ```
- **`PATCH /orders/:orderId/items/:itemId`** *(Staff only; Customer cancel forbidden once `kitchenStatus != NEW`)*
  - Request: `{ quantity?: number, status?: "CANCELLED", reason?: string }`
  - Response: `{ orderId, itemId, status, newSubtotalPaise }` *(logs `order_events` + `audit_logs` + outbox)*
- **`GET /kds/orders`** *(`KITCHEN`, `OWNER`, `WAITER`; supports initial load + 4s polling fallback)*
  - Query: `?status=NEW,PREPARING,READY&since=2026-11-11T15:00:00Z`
  - Response: `{ serverTime, orders: [{ id, kotNumber, tableNumber, roundNumber, isAddOn, kitchenStatus, notes, createdAt, updatedAt, items[] }] }`
- **`PATCH /kds/orders/:orderId/status`** *(`KITCHEN`, `OWNER`, `WAITER` for `SERVED`)*
  - Request: `{ kitchenStatus: "PREPARING" | "READY" | "SERVED" }`
  - Response: `{ id, kotNumber, kitchenStatus, updatedAt }` *(writes `order_events` + `outbox_events` `kot.updated`)*
- **`GET /kds/orders/:orderId/print`** *(`KITCHEN`, `CASHIER`, `OWNER`)*
  - Response: `{ kotNumber, tableNumber, isAddOn, timestamp, lines: [{ name, qty, modifiers[], prepNotes }] }`

### 2.5 `billing` & `payments`
| Method & Path | Auth / Roles | Request Body | Response (`200` / `201`) |
| :--- | :--- | :--- | :--- |
| `POST /sessions/:sessionId/bill` | `CASHIER`, `OWNER` *(or via bill request)* | `{ discountPaise?: number, discountReason?: string }` | `{ id, billNumber, subtotalPaise, discountPaise, cgstPaise, sgstPaise, totalPaise, paidPaise, status, lines[] }` |
| `GET /bills/:billId` | Staff or `X-Table-Session` | `—` | Full bill + `lines[]` + `paymentAttempts[]` |
| `POST /bills/:billId/payments/upi-qr` | Staff or `X-Table-Session` *(Header: `Idempotency-Key`)* | `{ amountPaise?: number }` | `{ paymentAttemptId, gatewayOrderId, qrPayloadUrl, upiIntentUrl, amountPaise, status: "PENDING" }` |
| `POST /bills/:billId/payments/manual` | `CASHIER`, `OWNER` | `{ method: "CASH" \| "CARD" \| "UPI_MANUAL", amountPaise: number, referenceNote?: string }` | `{ paymentAttemptId, billStatus: "PAID", sessionStatus: "CLOSED", tableStatus: "AVAILABLE" }` |
| `POST /bills/:billId/refunds` | `OWNER`, `CASHIER` | `{ paymentAttemptId, amountPaise, reason }` | `{ refundId, status }` |
| `POST /webhooks/razorpay` | Public (`X-Razorpay-Signature`) | Raw Razorpay webhook JSON | `{ received: true, status: "PROCESSED" \| "IGNORED" }` |

### 2.6 `subscriptions` & `admin`
- **`GET /subscription/current`** (`OWNER`) → `{ plan: { code, name, maxTables }, status, trialEndsAt, currentPeriodEnd, graceEndsAt }`
- **`GET /admin/tenants`** (`SUPER_ADMIN`) → Query: `?status=&q=` → `{ tenants: [{ id, name, slug, status, planCode, activeOutlets, ordersToday }] }`
- **`POST /admin/tenants`** (`SUPER_ADMIN`) → `{ restaurantName, ownerName, phone, planCode, trialDays }` → `{ tenantId, outletId, userId }`
- **`PATCH /admin/tenants/:id/status`** (`SUPER_ADMIN`) → `{ status: "ACTIVE" | "GRACE" | "LOCKED" | "SUSPENDED", reason }` → `{ updated: true }`
- **`GET /admin/telemetry`** (`SUPER_ADMIN`) → `{ activeTenants, ordersLast24h, upiSuccessRatePct, pendingOutboxCount }`
- **`GET /admin/audit-logs`** (`SUPER_ADMIN`) → Query: `?tenantId=&action=&limit=50` → `{ logs[] }`

---

## 3. WebSocket (Socket.IO) & Polling Fallback Contract

### Connection & Room Assignment
```ts
// Client connects to wss://api.autonex.in/realtime
const socket = io(`${WS_URL}/realtime`, {
  auth: { token: accessJwtOrGuestToken, mode: "staff" | "guest" },
  transports: ["websocket", "polling"]
});
```
The server validates the token on handshake and **auto-joins** the socket into scoped rooms (clients cannot arbitrarily join other tenants' rooms):
- `tenant:{tenantId}:outlet:{outletId}:kitchen` (`KITCHEN`, `OWNER`)
- `tenant:{tenantId}:outlet:{outletId}:staff` (`WAITER`, `CASHIER`, `OWNER`)
- `tenant:{tenantId}:session:{sessionId}` (`CUSTOMER_QR` + staff)

### Server → Client Event Envelope
Every outbox-relayed event uses a uniform envelope so clients can deduplicate via `eventId`:
```json
{
  "eventId": "outbox_uuid",
  "topic": "order.created",
  "tenantId": "tenant_uuid",
  "outletId": "outlet_uuid",
  "occurredAt": "2026-11-11T15:05:12.100Z",
  "data": {}
}
```

| Event Topic | Target Rooms | `data` Payload Highlights |
| :--- | :--- | :--- |
| `order.created` | `kitchen`, `staff`, `session:{id}` | `{ orderId, kotNumber, tableNumber, roundNumber, isAddOn, items[], notes }` |
| `kot.updated` | `kitchen`, `staff`, `session:{id}` | `{ orderId, kotNumber, tableNumber, kitchenStatus, updatedAt }` |
| `menu.stock_updated` | `staff`, active `session:*` | `{ menuItemId, inStock }` |
| `session.bill_requested` | `staff`, `session:{id}` | `{ sessionId, tableNumber, billId, totalPaise }` |
| `session.closed` | `staff`, `session:{id}` | `{ sessionId, tableId, billId, paidMethod }` |

### Polling Fallback Rule (Weak Wi-Fi Resilience)
1. Client listens for `connect`, `disconnect`, and server ping/heartbeat (`5s` timeout).
2. On disconnect or missed heartbeat `> 5s`, UI displays a non-blocking **"Reconnecting — Syncing every 4s"** banner and starts cursor-based HTTP polling:
   - **KDS / Staff:** `GET /api/v1/kds/orders?since=<lastServerTime>` every `4000ms`
   - **Customer QR:** `GET /api/v1/sessions/:sessionId` every `4000ms`
3. When Socket.IO reconnects, polling stops and one immediate `since` catch-up fetch prevents missed events during the reconnect gap.

