import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AutoNex Restaurant OS',
  description: 'Build • Order • Serve • Manage — Multi-tenant QR ordering and kitchen management',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

