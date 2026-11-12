import Link from 'next/link';
import { QrCode, ShieldCheck, UtensilsCrossed } from 'lucide-react';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-orange-50 via-white to-slate-50">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white font-bold">
            A
          </div>
          <div>
            <p className="text-sm font-bold tracking-tight text-slate-900">AutoNex Restaurant OS</p>
            <p className="text-xs text-slate-500">Build • Order • Serve • Manage</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Owner Login
          </Link>
          <Link
            href="/register"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
          >
            Register Restaurant
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 pb-20 pt-14 text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-brand-700">
          Phase 2 Active: Menu Management & Permanent Table QR System
        </span>
        <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
          Simple QR Menu & Table Control Built for Local Indian Restaurants
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-base text-slate-600 sm:text-lg">
          Set up your restaurant menu, modifiers, stock availability, and permanent revocable table QR
          stickers in under 15 minutes — without reprinting QRs when prices change.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link
            href="/dashboard"
            className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow hover:bg-brand-700"
          >
            Open Owner Dashboard
          </Link>
          <Link
            href="/register"
            className="rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            Onboard Your Restaurant
          </Link>
        </div>

        <div className="mt-14 grid gap-6 text-left sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <UtensilsCrossed className="h-6 w-6 text-brand-600" />
            <h2 className="mt-3 text-base font-semibold text-slate-900">Instant Menu & Stock Control</h2>
            <p className="mt-1.5 text-sm text-slate-600">
              Manage categories, veg/non-veg tags, add-on modifiers, WebP images, and 1-tap
              out-of-stock toggles.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <QrCode className="h-6 w-6 text-brand-600" />
            <h2 className="mt-3 text-base font-semibold text-slate-900">Permanent Table QR Stickers</h2>
            <p className="mt-1.5 text-sm text-slate-600">
              Download print-ready A4 bulk PDFs. Price updates go live immediately without ever
              reprinting stickers.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <ShieldCheck className="h-6 w-6 text-brand-600" />
            <h2 className="mt-3 text-base font-semibold text-slate-900">Opaque & Revocable Tokens</h2>
            <p className="mt-1.5 text-sm text-slate-600">
              Cryptographically random table URL tokens verified via SHA-256 hash with instant
              one-click rotation.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

