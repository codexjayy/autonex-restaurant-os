# AutoNex Restaurant OS — Product Requirements Document (PRD)

**Version:** 1.0 (MVP)  
**Target Market:** Local Indian restaurants, family dining, cafes, and casual dine-in outlets (8–30 tables)  
**Goal:** Replace paper slips and manual totaling with fast QR ordering, kitchen tickets (KOT), and billing built for Indian rush hours.

---

## 1. Problem Statement

Local Indian restaurants rely on handwritten pads, shouted orders, and manual calculators. During lunch (12–3 PM) and weekend dinner rush (7–11 PM), this breaks down:

- **Lost or misread KOTs:** Handwritten slips get smudged, lost, or misread—causing wrong spice levels, missed prep notes (*Jain / no onion-garlic*), or forgotten dishes.
- **Missed add-on orders:** Diners add items mid-meal (*"2 butter naan aur"*). Busy waiters forget verbal add-ons, leading to kitchen delays or unbilled food.
- **Late out-of-stock updates:** Guests order an unavailable dish and find out 10 minutes later, causing frustration and rework.
- **Slow billing & table turnaround:** Manual totaling delays bills (*"Bhaiya, bill le aao"*), causes math mistakes, and keeps tables occupied longer.
- **No day-end clarity:** Owners lack a fast daily view of total orders, Cash vs. UPI split, and top-selling items at closing.

---

## 2. Target User Personas

- **Restaurant Owner / Manager:** Runs an 8–30 table outlet and manages the cash counter. Needs zero billing leakage, faster table turnover, and a clean daily Cash vs. UPI summary on a counter tablet, laptop, or phone.
- **Waiter / Captain:** Handles 4–6 tables during rush hours with basic smartphone comfort. Needs a 2-tap way to punch verbal orders/add-ons and instant alerts when food is ready to serve.
- **Kitchen Staff (Chef / Cook):** Works in a noisy, high-pressure kitchen. Needs large, clear, chronological KOTs with prep notes and one-tap status buttons (`Preparing` → `Ready`) on a kitchen tablet/screen or thermal printer.
- **Dine-in Customer:** Everyday Indian diners (families, office groups, students) on budget-to-mid-range phones. Wants to scan a table QR (no app install or forced login), browse Veg/Non-Veg items with prices, place add-ons, and pay via UPI or cash.

---

## 3. Core User Flows

### Flow A: Customer Ordering (QR Scan → KOT)
- Customer scans the table **QR code** using their phone camera, Google Lens, or UPI scanner.
- Mobile web menu opens instantly (no app install, no OTP login) with **Table #** auto-linked to an active session.
- Customer filters **Veg / Non-Veg**, adds items with short notes (*less spicy*, *extra butter*), and taps **Place Order**.
- Waiters can add items to the same table session via **Staff Mode** for guests who prefer ordering verbally.
- Order saves to the running session and sends an instant KOT to the kitchen; mid-meal add-ons append to the same bill.

### Flow B: Kitchen Receiving & Prep (KOT → Ready)
- New KOT appears on the **Kitchen Display Screen (KDS)** with a sound chime (plus optional thermal print), showing Table #, time, quantities, and prep notes.
- Repeat orders from an active table appear clearly tagged **`ADD-ON`** under that Table #.
- Kitchen taps **Preparing** when cooking starts and **Ready** when plated.
- Waiter/Counter view updates to **Ready** immediately for pickup and serving.

### Flow C: Billing & Settlement (Bill Request → Table Reset)
- Customer taps **Request Bill** on their phone (or asks the waiter/cashier).
- System merges all order rounds into one itemized bill: Subtotal, **CGST + SGST** (e.g., 5%), and optional cashier discount.
- Customer pays via **UPI** (dynamic QR / UPI app intent for exact amount) or **Cash / Card at Counter**.
- UPI auto-confirms via gateway (with a manual *Confirm UPI* cashier fallback if webhooks lag); Cash/Card is marked **Paid** by the cashier.
- Digital receipt appears (with optional thermal print) and the table resets to **Available**.

---

## 4. MVP Feature List (Launch-Essential Only)

- **Table & QR Management:** Add/edit tables, generate printable Table QRs, and track live status (`Available`, `Occupied`, `Bill Requested`).
- **Digital Menu Management:** Categories, prices, Veg/Non-Veg/Egg tags, basic variants/notes (Half/Full, spice level), and instant **In Stock / Out of Stock** toggle.
- **No-App Customer Web Menu:** Lightweight mobile web menu tied to the table session for multi-round ordering and viewing the live running bill.
- **Staff Assisted Ordering Mode:** Fast mobile/tablet view for waiters or cashiers to place, edit, or cancel unprepped items for any table.
- **Kitchen Display / KOT Queue:** Real-time browser KDS with sound alert, order timer, prep notes, and 2-tap status updates (`Preparing`, `Ready`); optional 58mm/80mm thermal KOT print.
- **Consolidated Billing & Checkout:** Single session bill across rounds, configurable GST %, manager discount, and payment tracking (`UPI`, `Cash`, `Card`).
- **Owner Daily Summary:** End-of-day view of total orders, gross/net sales, Cash vs. UPI vs. Card split, and top 5 dishes.

---

## 5. Out of Scope (Excluded from MVP)

- **Inventory & Recipe Management:** Raw stock tracking, ingredient deduction, supplier POs, and wastage logs.
- **HR, Payroll & Attendance:** Staff shifts, salary/overtime calculation, and tip pooling.
- **Accounting & Tax Filing:** Tally/Zoho Books sync, P&L statements, or GSTR-1/3B filing.
- **Aggregator Integrations:** Zomato, Swiggy, Magicpin, or ONDC order syncing.
- **CRM & Marketing:** Loyalty points, WhatsApp campaigns, table reservations, and waitlist queues.
- **Multi-Outlet & Split Bills:** Franchise HQ controls, multi-kitchen routing, or split-bill across multiple payers.

---

## 6. Success Metrics (60-Day Pilot Targets)

- **Orders / Day:** **≥ 50 dine-in orders/day** per active restaurant (≥ 70% of daily dine-in volume).
- **Session Completion Rate:** **≥ 90%** of started table sessions end in a placed order and settled bill.
- **Payment Success Rate:** **≥ 97%** first-attempt UPI checkout success, with **< 2%** day-end Cash/UPI mismatch.
- **Order-to-KOT Speed:** **< 5 seconds** from customer/waiter tap to kitchen screen display.

---

## 7. Non-Functional Requirements

- **Performance:** Menu loads in **< 2.5s** on Indian 4G (lightweight bundle, compressed images); order/KDS sync takes **< 2s** and handles 30 concurrent rush-hour tables smoothly.
- **Security & Abuse Control:** PIN/phone role-based access (**Owner**, **Cashier**, **Waiter**, **Kitchen**); idempotent order submission prevents duplicate KOTs on double-taps; active session tokens + optional table-PIN/waiter confirmation prevent prank QR orders; HTTPS/TLS and RBI/PCI-DSS compliant payment gateways (no card/UPI data stored locally).
- **Uptime & Reliability:** **99.5% overall uptime**, **99.9% during Indian meal peaks** (12:00–3:30 PM & 7:00–11:30 PM); clear retry prompts on network drops, KDS auto-reconnect, and automated daily backups (7-day retention).

---

## 8. Assumptions and Risks

### Assumptions
- Most dine-in guests have a smartphone with 4G/Wi-Fi and know QR scanning via everyday UPI usage.
- Outlets have basic Wi-Fi/4G and at least one Android tablet, phone, or PC for kitchen and counter.
- Waiters will assist elderly or non-tech-savvy diners using Staff Mode.
- Outlets use a single menu and standard GST structure (e.g., 5% GST without ITC).

### Risks & Mitigations
- **Weak Wi-Fi in kitchen/basement:** Use lightweight payloads, mobile hotspot fallback, and a loud offline banner if KDS disconnects so orders aren't silently missed.
- **Prank/accidental QR orders:** Add a *Confirm Order* step, pre-prep staff cancellation, and an optional 4-digit table PIN / waiter-approve toggle.
- **UPI webhook delays during evening rush:** Allow cashier verification via counter UPI soundbox/SMS to mark **Paid (UPI)** manually and keep tables moving.
- **Staff hesitation during peak hours:** Use large touch targets, Veg/Non-Veg icons, and max 2–3 taps per action for < 15-minute staff onboarding.
