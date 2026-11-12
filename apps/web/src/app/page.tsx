import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@autonex/ui';
import { Building2, LockKeyhole, QrCode, ShieldCheck, Store, Users } from 'lucide-react';

export default function HomePage() {
  const pillars = [
    {
      title: 'Strict Tenant Isolation',
      description:
        'Database PostgreSQL Row-Level Security paired with application-layer Prisma isolation guarantees every restaurant only accesses its own records.',
      icon: LockKeyhole,
    },
    {
      title: 'Multi-Outlet Control',
      description:
        'Operate one café or ten outlets under a single restaurant account with independent GST, KDS language, and instant outlet switching.',
      icon: Store,
    },
    {
      title: 'Role-Based Access & Invites',
      description:
        'Granular Owner, Manager, Cashier, Waiter, and Kitchen permissions backed by Argon2id hashing and token-based staff invitations.',
      icon: Users,
    },
    {
      title: 'Built for Local Restaurants',
      description:
        '15–30 minute onboarding, Gujarati/Hindi KDS support, QR dining workflows, and resilient billing workflows built for daily service.',
      icon: QrCode,
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
              AN
            </div>
            <div>
              <div className="text-base font-bold tracking-tight">AutoNex Restaurant OS</div>
              <div className="text-xs text-muted-foreground">Build • Order • Serve • Manage</div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <Button variant="outline" size="sm" asChild>
              <Link href="/login">Sign In</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/register">Get Started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="max-w-3xl space-y-5">
          <Badge variant="default" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Multi-Tenant SaaS Foundation for Indian Restaurants & Cafés
          </Badge>

          <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-5xl">
            Simple, dependable restaurant operations in one cloud workspace.
          </h1>

          <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
            Replace paper KOTs and WhatsApp coordination with a secure platform built for 10–30 table
            local restaurants, cafés, and thali houses — with multi-outlet control, RBAC team onboarding,
            and live kitchen & billing workflows.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button size="lg" asChild>
              <Link href="/register">Register Your Restaurant</Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="/login">Owner / Staff Sign In</Link>
            </Button>
            <Button variant="ghost" size="lg" asChild>
              <Link href="/dashboard">
                <Building2 className="h-4 w-4" />
                Open Workspace
              </Link>
            </Button>
          </div>
        </div>

        <section className="mt-12 grid gap-5 sm:grid-cols-2">
          {pillars.map((pillar) => {
            const Icon = pillar.icon;
            return (
              <Card key={pillar.title}>
                <CardHeader>
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <CardTitle>{pillar.title}</CardTitle>
                  <CardDescription>{pillar.description}</CardDescription>
                </CardHeader>
                <CardContent />
              </Card>
            );
          })}
        </section>
      </main>
    </div>
  );
}
