'use client';

import QRCode from 'qrcode';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  TableDto,
  apiRequest,
  downloadProtectedPdf,
} from '@/lib/api-client';

function TableQrPreview({ qrUrl }: { qrUrl: string }) {
  const [dataUrl, setDataUrl] = useState<string>('');

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(qrUrl, { width: 180, margin: 1 })
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => {
        if (active) setDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [qrUrl]);

  if (!dataUrl) {
    return (
      <div className="flex h-36 w-36 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-400">
        Generating QR...
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt="Table QR Code"
      className="h-36 w-36 rounded-lg border border-slate-200 bg-white p-1"
    />
  );
}

export default function TablesAndQrPage() {
  const [tables, setTables] = useState<TableDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [tableNumber, setTableNumber] = useState('');
  const [label, setLabel] = useState('');
  const [capacity, setCapacity] = useState('4');
  const [creating, setCreating] = useState(false);

  const loadTables = useCallback(async () => {
    setError(null);
    try {
      const data = await apiRequest<TableDto[]>('/tables');
      setTables(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load tables');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  const handleCreateTable = async (e: FormEvent) => {
    e.preventDefault();
    if (!tableNumber.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await apiRequest('/tables', {
        method: 'POST',
        body: JSON.stringify({
          tableNumber: tableNumber.trim(),
          label: label.trim() || undefined,
          capacity: Number(capacity) || 4,
        }),
      });
      setTableNumber('');
      setLabel('');
      setCapacity('4');
      await loadTables();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create table');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (table: TableDto) => {
    try {
      await apiRequest(`/tables/${table.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !table.isActive }),
      });
      await loadTables();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update table status');
    }
  };

  const handleRotateQr = async (table: TableDto) => {
    const confirmed = window.confirm(
      `Rotate QR token for Table ${table.tableNumber}? The previously printed sticker will immediately stop working.`,
    );
    if (!confirmed) return;

    try {
      await apiRequest(`/tables/${table.id}/rotate-qr`, { method: 'POST' });
      await loadTables();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rotate QR code');
    }
  };

  const handleDeleteTable = async (table: TableDto) => {
    const confirmed = window.confirm(`Delete Table ${table.tableNumber}?`);
    if (!confirmed) return;

    try {
      await apiRequest(`/tables/${table.id}`, { method: 'DELETE' });
      await loadTables();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete table');
    }
  };

  const handleCopyUrl = async (table: TableDto) => {
    if (!table.activeQr) return;
    await navigator.clipboard.writeText(table.activeQr.qrUrl);
    setCopiedId(table.id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const extractTokenPath = (qrUrl: string): string => {
    try {
      const parsed = new URL(qrUrl);
      return parsed.pathname;
    } catch {
      return qrUrl;
    }
  };

  return (
    <DashboardShell
      title="Tables & Printable QR Codes"
      subtitle="Each table gets a permanent cryptographically random URL token. Print bulk PDFs once — menu & price edits apply automatically."
    >
      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Create Table + Bulk Print Header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <form onSubmit={handleCreateTable} className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600">
              Table No.
            </label>
            <input
              required
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              placeholder="T7"
              className="mt-1 w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600">
              Label (optional)
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Window Corner"
              className="mt-1 w-44 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600">Seats</label>
            <input
              type="number"
              min={1}
              max={50}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              className="mt-1 w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            <Plus className="h-4 w-4" />
            {creating ? 'Adding...' : 'Add Table'}
          </button>
        </form>

        <button
          type="button"
          onClick={() =>
            downloadProtectedPdf('/tables/qr-pdf/bulk', 'autonex-all-table-qr-codes.pdf').catch(
              (err) => setError(err instanceof Error ? err.message : 'PDF download failed'),
            )
          }
          disabled={tables.filter((t) => t.isActive && t.activeQr).length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
        >
          <Download className="h-4 w-4" />
          Generate All Table QR Codes (PDF)
        </button>
      </div>

      {/* Tables Grid */}
      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Loading tables...
        </div>
      ) : tables.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-600">
          Add your restaurant&apos;s tables above (e.g. T1, T2, Garden-1) to generate permanent QR
          stickers.
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {tables.map((table) => (
            <div
              key={table.id}
              className={`rounded-2xl border bg-white p-5 shadow-sm ${
                table.isActive ? 'border-slate-200' : 'border-slate-200 opacity-70'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-slate-900">Table {table.tableNumber}</h3>
                    {table.activeQr && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                        v{table.activeQr.qrVersion}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    {table.label ? `${table.label} • ` : ''}
                    {table.capacity} seats
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => handleToggleActive(table)}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    table.isActive
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {table.isActive ? 'Active' : 'Inactive'}
                </button>
              </div>

              <div className="my-4 flex justify-center">
                {table.activeQr ? (
                  <TableQrPreview qrUrl={table.activeQr.qrUrl} />
                ) : (
                  <div className="flex h-36 w-36 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-500">
                    QR Revoked
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  disabled={!table.activeQr}
                  onClick={() =>
                    downloadProtectedPdf(
                      `/tables/${table.id}/qr-pdf`,
                      `autonex-table-${table.tableNumber}-qr.pdf`,
                    ).catch((err) => setError(err instanceof Error ? err.message : 'PDF failed'))
                  }
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 py-2 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" />
                  Print PDF
                </button>
                <button
                  type="button"
                  onClick={() => handleRotateQr(table)}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-amber-200 bg-amber-50 py-2 font-semibold text-amber-800 hover:bg-amber-100"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Rotate QR
                </button>
                <button
                  type="button"
                  disabled={!table.activeQr}
                  onClick={() => handleCopyUrl(table)}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 py-2 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copiedId === table.id ? 'Copied!' : 'Copy Link'}
                </button>
                {table.activeQr ? (
                  <a
                    href={extractTokenPath(table.activeQr.qrUrl)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 py-2 font-medium text-brand-700 hover:bg-orange-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Preview
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleDeleteTable(table)}
                    className="inline-flex items-center justify-center gap-1 rounded-lg border border-rose-200 py-2 font-medium text-rose-600 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}

