'use client';

import QRCode from 'qrcode';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileDown,
  Pencil,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  TableDto,
  apiRequest,
  downloadProtectedPdf,
  getStoredSession,
  listOutlets,
  subscribeWorkspaceSync,
} from '@/lib/api-client';

function validateTableFields(
  rawNumber: string,
  rawCapacity: string,
  existingTables: TableDto[],
  excludeId?: string,
): string | null {
  const num = rawNumber.trim();
  if (!num) return 'Table number is required (e.g. T1, T2, Patio-1).';
  if (num.length > 20) return 'Table number must be 20 characters or fewer.';

  const duplicate = existingTables.find(
    (t) => t.id !== excludeId && t.tableNumber.trim().toLowerCase() === num.toLowerCase(),
  );
  if (duplicate) {
    return `Table "${num}" already exists in this outlet.`;
  }

  const parsedSeats = Number(rawCapacity.trim());
  if (
    !rawCapacity.trim() ||
    !Number.isInteger(parsedSeats) ||
    parsedSeats < 1 ||
    parsedSeats > 50
  ) {
    return 'Seating capacity must be a whole number between 1 and 50.';
  }

  return null;
}

function extractTokenPath(qrUrl: string): string {
  try {
    const parsed = new URL(qrUrl);
    return parsed.pathname;
  } catch {
    return qrUrl;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function generateStickerPngDataUrl(
  table: TableDto,
  outletName: string,
): Promise<string> {
  if (!table.activeQr) {
    throw new Error('This table has no active QR token.');
  }

  const qrDataUrl = await QRCode.toDataURL(table.activeQr.qrUrl, {
    width: 440,
    margin: 2,
    errorCorrectionLevel: 'M',
  });

  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 760;
  const ctx = canvas.getContext('2d');
  if (!ctx) return qrDataUrl;

  // Card background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Navy border
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 6;
  ctx.strokeRect(20, 20, 560, 720);

  // Outlet header
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(outletName || 'AutoNex Restaurant', 300, 82, 500);

  // Orange Table heading
  ctx.fillStyle = '#ea580c';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText(`Table ${table.tableNumber}`, 300, 142, 500);

  // Label + capacity
  ctx.fillStyle = '#475569';
  ctx.font = '20px sans-serif';
  const subtitle = table.label
    ? `${table.label} • ${table.capacity} seats`
    : `${table.capacity} seats`;
  ctx.fillText(subtitle, 300, 180, 500);

  // Load and draw QR image
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to render QR graphic'));
    img.src = qrDataUrl;
  });
  ctx.drawImage(img, 100, 210, 400, 400);

  // Scan footer
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('Scan QR to View Menu & Order', 300, 658);

  ctx.fillStyle = '#64748b';
  ctx.font = '16px sans-serif';
  ctx.fillText(`AutoNex Restaurant OS • QR v${table.activeQr.qrVersion}`, 300, 700);

  return canvas.toDataURL('image/png');
}

function TableQrPreview({
  qrUrl,
  tableNumber,
  size = 152,
  onClick,
}: {
  qrUrl: string;
  tableNumber: string;
  size?: number;
  onClick?: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string>('');

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(qrUrl, { width: Math.max(220, size * 2), margin: 1 })
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => {
        if (active) setDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [qrUrl, size]);

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-xs text-slate-400"
      >
        Generating QR...
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt={`QR code for Table ${tableNumber}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      className={`rounded-xl border border-slate-200 bg-white p-1.5 ${
        onClick ? 'cursor-pointer transition hover:border-orange-300' : ''
      }`}
    />
  );
}

export default function TablesAndQrPage() {
  const [tables, setTables] = useState<TableDto[]>([]);
  const [activeOutletName, setActiveOutletName] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Add Table form
  const tableNumberInputRef = useRef<HTMLInputElement | null>(null);
  const [tableNumber, setTableNumber] = useState('');
  const [label, setLabel] = useState('');
  const [floorSection, setFloorSection] = useState('');
  const [capacity, setCapacity] = useState('4');
  const [creating, setCreating] = useState(false);

  // Batch add tables modal
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchPrefix, setBatchPrefix] = useState('T');
  const [batchStart, setBatchStart] = useState('1');
  const [batchCount, setBatchCount] = useState('4');
  const [batchSection, setBatchSection] = useState('Main Hall');
  const [batchCapacity, setBatchCapacity] = useState('4');
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchCreating, setBatchCreating] = useState(false);

  // Bulk PDF & per-card actions
  const [downloadingBulkPdf, setDownloadingBulkPdf] = useState(false);
  const [downloadingTableId, setDownloadingTableId] = useState<string | null>(null);

  // Modals
  const [viewQrTable, setViewQrTable] = useState<TableDto | null>(null);
  const [editingTable, setEditingTable] = useState<TableDto | null>(null);
  const [editNumber, setEditNumber] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editFloorSection, setEditFloorSection] = useState('');
  const [editCapacity, setEditCapacity] = useState('4');
  const [editActive, setEditActive] = useState(true);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const [confirmDeleteTable, setConfirmDeleteTable] = useState<TableDto | null>(null);
  const [deletingTable, setDeletingTable] = useState(false);

  const [confirmRotateTable, setConfirmRotateTable] = useState<TableDto | null>(null);
  const [rotatingQr, setRotatingQr] = useState(false);

  const loadTables = useCallback(async () => {
    setError(null);
    try {
      const [tablesData, outlets] = await Promise.all([
        apiRequest<TableDto[]>('/tables'),
        listOutlets().catch(() => []),
      ]);
      setTables(tablesData);

      const sessionOutletId = getStoredSession()?.user?.outletId;
      const activeOutlet = outlets.find((o) => o.id === sessionOutletId) ?? outlets[0] ?? null;
      setActiveOutletName(activeOutlet?.name ?? '');

      setViewQrTable((prev) =>
        prev ? tablesData.find((t) => t.id === prev.id) ?? null : null,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load tables');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTables();
    return subscribeWorkspaceSync(() => {
      void loadTables();
    });
  }, [loadTables]);

  const filteredTables = useMemo(() => {
    if (statusFilter === 'ACTIVE') return tables.filter((t) => t.isActive);
    if (statusFilter === 'INACTIVE') return tables.filter((t) => !t.isActive);
    return tables;
  }, [tables, statusFilter]);

  const activeQrCount = useMemo(
    () => tables.filter((t) => t.isActive && t.activeQr).length,
    [tables],
  );

  const sectionSuggestions = useMemo(() => {
    const defaults = ['Main Hall', 'Patio', 'Window Side', 'AC Lounge', 'Rooftop', 'Family Dining'];
    const dynamic = tables
      .map((t) => t.floorSection?.trim())
      .filter((s): s is string => Boolean(s));
    return Array.from(new Set([...dynamic, ...defaults]));
  }, [tables]);

  const handleCreateTable = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    const validationError = validateTableFields(tableNumber, capacity, tables);
    if (validationError) {
      setError(validationError);
      return;
    }

    const trimmedNumber = tableNumber.trim();
    const trimmedLabel = label.trim();
    const trimmedSection = floorSection.trim();
    const seats = Number(capacity.trim());

    setCreating(true);
    try {
      const created = await apiRequest<TableDto>('/tables', {
        method: 'POST',
        body: JSON.stringify({
          tableNumber: trimmedNumber,
          label: trimmedLabel || undefined,
          floorSection: trimmedSection || undefined,
          capacity: seats,
        }),
      });
      setTableNumber('');
      setLabel('');
      setFloorSection('');
      setCapacity('4');
      setSuccessMessage(`Table "${created.tableNumber}" added with its permanent QR code.`);
      await loadTables();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create table');
    } finally {
      setCreating(false);
    }
  };

  const handleBatchCreateTables = async (e: FormEvent) => {
    e.preventDefault();
    setBatchError(null);
    setError(null);
    setSuccessMessage(null);

    const prefix = batchPrefix.trim();
    const startNum = Number(batchStart.trim());
    const countNum = Number(batchCount.trim());
    const seatsNum = Number(batchCapacity.trim());

    if (!prefix || prefix.length > 12) {
      setBatchError('Prefix is required (e.g. T or Patio-) and must be 12 chars or fewer.');
      return;
    }
    if (!Number.isInteger(startNum) || startNum < 1 || startNum > 999) {
      setBatchError('Starting number must be between 1 and 999.');
      return;
    }
    if (!Number.isInteger(countNum) || countNum < 1 || countNum > 20) {
      setBatchError('Batch count must be between 1 and 20 tables at a time.');
      return;
    }
    if (!Number.isInteger(seatsNum) || seatsNum < 1 || seatsNum > 50) {
      setBatchError('Seats per table must be a whole number between 1 and 50.');
      return;
    }

    const existingNums = new Set(tables.map((t) => t.tableNumber.trim().toLowerCase()));
    const candidateNumbers: string[] = [];
    for (let i = 0; i < countNum; i += 1) {
      const nextNum = `${prefix}${startNum + i}`;
      if (nextNum.length > 20) {
        setBatchError(`Generated table number "${nextNum}" exceeds 20 characters.`);
        return;
      }
      if (existingNums.has(nextNum.toLowerCase())) {
        setBatchError(`Table "${nextNum}" already exists in this outlet. Adjust starting number.`);
        return;
      }
      candidateNumbers.push(nextNum);
    }

    setBatchCreating(true);
    let createdCount = 0;
    try {
      for (const nextNum of candidateNumbers) {
        await apiRequest<TableDto>('/tables', {
          method: 'POST',
          body: JSON.stringify({
            tableNumber: nextNum,
            floorSection: batchSection.trim() || undefined,
            capacity: seatsNum,
          }),
        });
        createdCount += 1;
      }
      setBatchModalOpen(false);
      setSuccessMessage(
        `Created ${createdCount} table${createdCount === 1 ? '' : 's'} (${candidateNumbers[0]}–${candidateNumbers[candidateNumbers.length - 1]}) with permanent QR codes.`,
      );
      await loadTables();
    } catch (err) {
      await loadTables();
      setBatchError(
        err instanceof ApiError
          ? `${err.message}${createdCount > 0 ? ` (${createdCount} created before stopping)` : ''}`
          : 'Failed during batch creation',
      );
    } finally {
      setBatchCreating(false);
    }
  };

  const openEditModal = (table: TableDto) => {
    setEditError(null);
    setEditingTable(table);
    setEditNumber(table.tableNumber);
    setEditLabel(table.label ?? '');
    setEditFloorSection(table.floorSection ?? '');
    setEditCapacity(String(table.capacity));
    setEditActive(table.isActive);
  };

  const handleSaveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingTable) return;
    setEditError(null);
    setError(null);
    setSuccessMessage(null);

    const validationError = validateTableFields(
      editNumber,
      editCapacity,
      tables,
      editingTable.id,
    );
    if (validationError) {
      setEditError(validationError);
      return;
    }

    const trimmedNumber = editNumber.trim();
    setSavingEdit(true);
    try {
      await apiRequest(`/tables/${editingTable.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          tableNumber: trimmedNumber,
          label: editLabel.trim() || null,
          floorSection: editFloorSection.trim() || null,
          capacity: Number(editCapacity.trim()),
          isActive: editActive,
        }),
      });
      setEditingTable(null);
      setSuccessMessage(`Table "${trimmedNumber}" updated. Its permanent QR URL remains unchanged.`);
      await loadTables();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Failed to update table');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggleActive = async (table: TableDto) => {
    setError(null);
    setSuccessMessage(null);
    try {
      await apiRequest(`/tables/${table.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !table.isActive }),
      });
      setSuccessMessage(
        `Table "${table.tableNumber}" marked ${!table.isActive ? 'Active' : 'Inactive'}.`,
      );
      await loadTables();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update table status');
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteTable) return;
    setDeletingTable(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await apiRequest(`/tables/${confirmDeleteTable.id}`, { method: 'DELETE' });
      const deletedNum = confirmDeleteTable.tableNumber;
      setConfirmDeleteTable(null);
      if (viewQrTable?.id === confirmDeleteTable.id) setViewQrTable(null);
      setSuccessMessage(`Table "${deletedNum}" was deleted.`);
      await loadTables();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete table');
      setConfirmDeleteTable(null);
    } finally {
      setDeletingTable(false);
    }
  };

  const handleConfirmRotateQr = async () => {
    if (!confirmRotateTable) return;
    setRotatingQr(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const updated = await apiRequest<TableDto>(`/tables/${confirmRotateTable.id}/rotate-qr`, {
        method: 'POST',
      });
      setConfirmRotateTable(null);
      setSuccessMessage(
        `Rotated QR token for Table "${updated.tableNumber}" to v${updated.activeQr?.qrVersion ?? 1}. Print and replace the old sticker.`,
      );
      await loadTables();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rotate QR code');
      setConfirmRotateTable(null);
    } finally {
      setRotatingQr(false);
    }
  };

  const handleCopyUrl = async (table: TableDto) => {
    if (!table.activeQr) return;
    try {
      await navigator.clipboard.writeText(table.activeQr.qrUrl);
      setCopiedId(table.id);
      setTimeout(() => setCopiedId((prev) => (prev === table.id ? null : prev)), 1800);
    } catch {
      setError('Unable to copy QR link to clipboard.');
    }
  };

  const handleDownloadQrPng = async (table: TableDto) => {
    if (!table.activeQr) return;
    setDownloadingTableId(table.id);
    setError(null);
    try {
      const pngUrl = await generateStickerPngDataUrl(table, activeOutletName);
      const anchor = document.createElement('a');
      const safeNum = table.tableNumber.replace(/[^a-zA-Z0-9_-]+/g, '-');
      anchor.href = pngUrl;
      anchor.download = `autonex-table-${safeNum}-qr.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setSuccessMessage(`Downloaded QR PNG sticker for Table "${table.tableNumber}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download QR PNG');
    } finally {
      setDownloadingTableId(null);
    }
  };

  const handlePrintQr = async (table: TableDto) => {
    if (!table.activeQr) return;
    setError(null);
    try {
      const qrDataUrl = await QRCode.toDataURL(table.activeQr.qrUrl, {
        width: 480,
        margin: 2,
        errorCorrectionLevel: 'M',
      });

      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      document.body.appendChild(iframe);

      const doc = iframe.contentWindow?.document;
      if (!doc || !iframe.contentWindow) {
        iframe.remove();
        setError('Unable to initialize print preview.');
        return;
      }

      const safeOutlet = escapeHtml(activeOutletName || 'AutoNex Restaurant');
      const safeNum = escapeHtml(table.tableNumber);
      const safeLabel = table.label ? escapeHtml(table.label) : '';
      const safeVersion = escapeHtml(String(table.activeQr.qrVersion));

      doc.open();
      doc.write(`<!DOCTYPE html>
<html>
  <head>
    <title>Table ${safeNum} QR Sticker</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #fff; }
      .sticker { width: 340px; border: 2px solid #0f172a; border-radius: 18px; padding: 28px 24px; text-align: center; }
      .outlet { font-size: 18px; font-weight: 700; color: #0f172a; margin: 0 0 6px; }
      .table { font-size: 28px; font-weight: 800; color: #ea580c; margin: 0 0 4px; }
      .meta { font-size: 13px; color: #475569; margin: 0 0 18px; }
      .qr { width: 220px; height: 220px; display: block; margin: 0 auto 16px; }
      .cta { font-size: 14px; font-weight: 700; color: #0f172a; margin: 0 0 6px; }
      .ver { font-size: 11px; color: #64748b; margin: 0; }
    </style>
  </head>
  <body>
    <div class="sticker">
      <p class="outlet">${safeOutlet}</p>
      <h1 class="table">Table ${safeNum}</h1>
      <p class="meta">${safeLabel ? `${safeLabel} &bull; ` : ''}${table.capacity} seats</p>
      <img class="qr" src="${qrDataUrl}" alt="Table ${safeNum} QR" />
      <p class="cta">Scan QR to View Menu &amp; Order</p>
      <p class="ver">AutoNex Restaurant OS &bull; QR v${safeVersion}</p>
    </div>
  </body>
</html>`);
      doc.close();

      iframe.onload = () => {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        setTimeout(() => iframe.remove(), 1500);
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to print QR sticker');
    }
  };

  const handleBulkPdfDownload = async () => {
    setDownloadingBulkPdf(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await downloadProtectedPdf('/tables/qr-pdf/bulk', 'autonex-all-table-qr-codes.pdf');
      setSuccessMessage('Downloaded printable All Table QR Codes PDF sticker sheet.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk PDF generation failed');
    } finally {
      setDownloadingBulkPdf(false);
    }
  };

  return (
    <DashboardShell
      title="Tables & Printable QR Codes"
      subtitle="Each table gets a permanent cryptographically random URL token. Print stickers once — menu and price updates sync automatically."
      onOutletChanged={() => {
        setSuccessMessage(null);
        setError(null);
        setStatusFilter('ALL');
        setLoading(true);
        void loadTables();
      }}
    >
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            {successMessage}
          </span>
          <button type="button" aria-label="Dismiss notice" onClick={() => setSuccessMessage(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Create Table + Bulk Print Control Card */}
      <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-sm font-semibold text-slate-900">
              {activeOutletName ? `${activeOutletName} Tables` : 'Outlet Tables'}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              {tables.length} {tables.length === 1 ? 'table' : 'tables'} · {activeQrCount} active QR
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {tables.length > 0 && (
              <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs font-semibold">
                {(['ALL', 'ACTIVE', 'INACTIVE'] as const).map((filterKey) => (
                  <button
                    key={filterKey}
                    type="button"
                    onClick={() => setStatusFilter(filterKey)}
                    className={`rounded-md px-2.5 py-1 transition ${
                      statusFilter === filterKey
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {filterKey === 'ALL' ? 'All' : filterKey === 'ACTIVE' ? 'Active' : 'Inactive'}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              data-testid="open-batch-add-btn"
              onClick={() => {
                setBatchError(null);
                setBatchStart(String(tables.length + 1));
                setBatchModalOpen(true);
              }}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Multiple
            </button>

            <button
              type="button"
              data-testid="bulk-qr-pdf-btn"
              onClick={handleBulkPdfDownload}
              disabled={downloadingBulkPdf || activeQrCount === 0}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-40"
            >
              <Download className="h-4 w-4" />
              {downloadingBulkPdf
                ? 'Generating PDF...'
                : 'Generate All Table QR Codes (PDF)'}
            </button>
          </div>
        </div>

        <datalist id="tables-floor-sections">
          {sectionSuggestions.map((sec) => (
            <option key={sec} value={sec} />
          ))}
        </datalist>

        <form
          onSubmit={handleCreateTable}
          noValidate
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(105px,130px)_minmax(140px,1fr)_minmax(140px,1fr)_90px_auto] lg:items-end"
        >
          <div>
            <label
              htmlFor="new-table-number"
              className="block text-xs font-semibold uppercase tracking-wide text-slate-600"
            >
              Table No.
            </label>
            <input
              id="new-table-number"
              ref={tableNumberInputRef}
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              placeholder="e.g. T7"
              maxLength={20}
              className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </div>

          <div>
            <label
              htmlFor="new-table-label"
              className="block text-xs font-semibold uppercase tracking-wide text-slate-600"
            >
              Label (optional)
            </label>
            <input
              id="new-table-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Window Corner"
              maxLength={60}
              className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </div>

          <div>
            <label
              htmlFor="new-table-section"
              className="block text-xs font-semibold uppercase tracking-wide text-slate-600"
            >
              Floor / Section
            </label>
            <input
              id="new-table-section"
              list="tables-floor-sections"
              value={floorSection}
              onChange={(e) => setFloorSection(e.target.value)}
              placeholder="e.g. Main Hall, Patio"
              maxLength={60}
              className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </div>

          <div>
            <label
              htmlFor="new-table-seats"
              className="block text-xs font-semibold uppercase tracking-wide text-slate-600"
            >
              Seats
            </label>
            <input
              id="new-table-seats"
              type="number"
              min={1}
              max={50}
              step={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </div>

          <button
            type="submit"
            disabled={creating}
            data-testid="add-table-btn"
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60 sm:col-span-2 lg:col-span-1"
          >
            <Plus className="h-4 w-4" />
            {creating ? 'Adding...' : 'Add Table'}
          </button>
        </form>
      </div>

      {/* Tables Card Grid / Empty State */}
      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Loading outlet tables and QR tokens...
        </div>
      ) : tables.length === 0 ? (
        <div
          data-testid="tables-empty-state"
          className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm"
        >
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-orange-50 text-orange-600">
            <QrCode className="h-6 w-6" />
          </div>
          <h3 className="mt-4 text-base font-bold text-slate-900">
            No tables configured for {activeOutletName || 'this outlet'} yet
          </h3>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
            Add your dining tables above (for example T1, T2, Patio-1) to generate permanent
            scannable QR codes and printable sticker PDFs.
          </p>
          <button
            type="button"
            onClick={() => tableNumberInputRef.current?.focus()}
            className="mt-5 inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Add Your First Table
          </button>
        </div>
      ) : filteredTables.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No {statusFilter.toLowerCase()} tables found in this outlet.
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filteredTables.map((table) => (
            <div
              key={table.id}
              data-testid={`table-card-${table.tableNumber}`}
              className={`flex flex-col rounded-2xl border bg-white p-5 shadow-sm transition ${
                table.isActive
                  ? 'border-slate-200 hover:border-slate-300'
                  : 'border-slate-200 bg-slate-50/60 opacity-80'
              }`}
            >
              {/* Card Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-bold text-slate-900">Table {table.tableNumber}</h3>
                    {table.activeQr && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                        v{table.activeQr.qrVersion}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {table.floorSection && (
                      <span className="rounded-md bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                        {table.floorSection}
                      </span>
                    )}
                    {table.label && (
                      <span className="truncate font-medium text-slate-700">{table.label}</span>
                    )}
                    {table.label && <span aria-hidden="true">•</span>}
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3.5 w-3.5 text-slate-400" />
                      {table.capacity} {table.capacity === 1 ? 'seat' : 'seats'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleToggleActive(table)}
                  title="Toggle active status"
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${
                    table.isActive
                      ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100'
                      : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                  }`}
                >
                  {table.isActive ? 'Active' : 'Inactive'}
                </button>
              </div>

              {/* Permanent QR Preview */}
              <div className="my-4 flex flex-col items-center rounded-xl border border-slate-100 bg-slate-50/70 py-3.5">
                {table.activeQr ? (
                  <>
                    <TableQrPreview
                      qrUrl={table.activeQr.qrUrl}
                      tableNumber={table.tableNumber}
                      onClick={() => setViewQrTable(table)}
                    />
                    <span className="mt-2 text-[11px] font-medium text-slate-500">
                      Permanent QR URL • Auto-syncs menu
                    </span>
                  </>
                ) : (
                  <div className="flex h-36 w-36 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-center text-xs text-slate-500">
                    <QrCode className="mb-1 h-5 w-5 text-slate-400" />
                    QR Revoked
                  </div>
                )}
              </div>

              {/* Primary QR Action Row */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <button
                  type="button"
                  disabled={!table.activeQr}
                  onClick={() => setViewQrTable(table)}
                  aria-label={`View QR for Table ${table.tableNumber}`}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-2 font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  <QrCode className="h-3.5 w-3.5 text-orange-600" />
                  View QR
                </button>

                <button
                  type="button"
                  disabled={!table.activeQr || downloadingTableId === table.id}
                  onClick={() => void handleDownloadQrPng(table)}
                  aria-label={`Download QR for Table ${table.tableNumber}`}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-2 font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5 text-slate-600" />
                  {downloadingTableId === table.id ? '...' : 'Download'}
                </button>

                <button
                  type="button"
                  disabled={!table.activeQr}
                  onClick={() => void handlePrintQr(table)}
                  aria-label={`Print QR for Table ${table.tableNumber}`}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-2 font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  <Printer className="h-3.5 w-3.5 text-slate-600" />
                  Print QR
                </button>
              </div>

              {/* Table Management Footer */}
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs">
                <button
                  type="button"
                  disabled={!table.activeQr}
                  onClick={() => void handleCopyUrl(table)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
                >
                  {copiedId === table.id ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                      <span className="text-emerald-700">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Copy Link</span>
                    </>
                  )}
                </button>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => openEditModal(table)}
                    aria-label={`Edit Table ${table.tableNumber}`}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 transition hover:bg-slate-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteTable(table)}
                    aria-label={`Delete Table ${table.tableNumber}`}
                    className="inline-flex items-center gap-1 rounded-md border border-rose-200 px-2.5 py-1 font-semibold text-rose-600 transition hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* View QR Modal */}
      {viewQrTable && viewQrTable.activeQr && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  Table {viewQrTable.tableNumber} QR Code
                </h2>
                <p className="text-xs text-slate-500">
                  {activeOutletName ? `${activeOutletName} • ` : ''}
                  {viewQrTable.label ? `${viewQrTable.label} • ` : ''}
                  {viewQrTable.capacity} seats • v{viewQrTable.activeQr.qrVersion}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close QR modal"
                onClick={() => setViewQrTable(null)}
              >
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>

            <div className="mt-5 flex flex-col items-center">
              <TableQrPreview
                qrUrl={viewQrTable.activeQr.qrUrl}
                tableNumber={viewQrTable.tableNumber}
                size={220}
              />

              <div className="mt-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-center">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Permanent Table URL
                </p>
                <p
                  data-testid="modal-qr-url"
                  className="mt-0.5 break-all font-mono text-xs text-slate-700"
                >
                  {viewQrTable.activeQr.qrUrl}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2.5 text-xs">
              <button
                type="button"
                onClick={() => void handleDownloadQrPng(viewQrTable)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
              >
                <Download className="h-4 w-4" />
                Download PNG
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadProtectedPdf(
                    `/tables/${viewQrTable.id}/qr-pdf`,
                    `autonex-table-${viewQrTable.tableNumber}-qr.pdf`,
                  ).catch((err) => setError(err instanceof Error ? err.message : 'PDF failed'))
                }
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2.5 font-semibold text-white shadow-sm hover:bg-slate-800"
              >
                <FileDown className="h-4 w-4" />
                Download PDF
              </button>
              <button
                type="button"
                onClick={() => void handlePrintQr(viewQrTable)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Printer className="h-4 w-4" />
                Print Sticker
              </button>
              <a
                href={extractTokenPath(viewQrTable.activeQr.qrUrl)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 font-semibold text-orange-700 hover:bg-orange-100"
              >
                <ExternalLink className="h-4 w-4" />
                Open Guest Menu
              </a>
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => void handleCopyUrl(viewQrTable)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900"
              >
                <Copy className="h-3.5 w-3.5" />
                {copiedId === viewQrTable.id ? 'Copied Link!' : 'Copy QR Link'}
              </button>

              <button
                type="button"
                onClick={() => setConfirmRotateTable(viewQrTable)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-800"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Rotate QR Token
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Table Modal */}
      {editingTable && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-lg font-bold text-slate-900">
                Edit Table {editingTable.tableNumber}
              </h2>
              <button
                type="button"
                aria-label="Close edit modal"
                onClick={() => setEditingTable(null)}
              >
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>

            {editError && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                {editError}
              </div>
            )}

            <form onSubmit={handleSaveEdit} noValidate className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Table No.
                </label>
                <input
                  value={editNumber}
                  onChange={(e) => setEditNumber(e.target.value)}
                  maxLength={20}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Label (optional)
                </label>
                <input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  placeholder="e.g. Window Corner"
                  maxLength={60}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Floor / Section (optional)
                </label>
                <input
                  list="tables-floor-sections"
                  value={editFloorSection}
                  onChange={(e) => setEditFloorSection(e.target.value)}
                  placeholder="e.g. Main Hall, Patio"
                  maxLength={60}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Seating Capacity
                </label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={editCapacity}
                  onChange={(e) => setEditCapacity(e.target.value)}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                />
                Table Active (accepting QR scans)
              </label>

              <p className="text-xs text-slate-500">
                Updating table details preserves the permanent QR code URL already printed for this
                table.
              </p>

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setEditingTable(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  data-testid="save-table-edit-btn"
                  className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
                >
                  {savingEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDeleteTable && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Delete Table {confirmDeleteTable.tableNumber}?
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  This removes Table{' '}
                  <span className="font-semibold text-slate-900">
                    {confirmDeleteTable.tableNumber}
                  </span>{' '}
                  and invalidates its QR code immediately. Tables with past order history cannot be
                  deleted permanently and should be marked Inactive instead.
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                disabled={deletingTable}
                onClick={() => setConfirmDeleteTable(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingTable}
                data-testid="confirm-delete-table-btn"
                onClick={() => void handleConfirmDelete()}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {deletingTable ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rotate QR Confirmation Modal */}
      {confirmRotateTable && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                <RefreshCw className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Rotate QR Token for Table {confirmRotateTable.tableNumber}?
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  Only rotate a QR token if a sticker was compromised. Existing printed stickers for
                  Table {confirmRotateTable.tableNumber} will stop working immediately.
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                disabled={rotatingQr}
                onClick={() => setConfirmRotateTable(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={rotatingQr}
                data-testid="confirm-rotate-qr-btn"
                onClick={() => void handleConfirmRotateQr()}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
              >
                {rotatingQr ? 'Rotating...' : 'Rotate QR Token'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Add Multiple Tables Modal */}
      {batchModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Add Multiple Tables</h2>
                <p className="text-xs text-slate-500">
                  Quickly generate sequential tables with permanent QR codes.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close batch modal"
                onClick={() => setBatchModalOpen(false)}
              >
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>

            {batchError && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                {batchError}
              </div>
            )}

            <form onSubmit={handleBatchCreateTables} noValidate className="mt-4 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Prefix
                  </label>
                  <input
                    value={batchPrefix}
                    onChange={(e) => setBatchPrefix(e.target.value)}
                    placeholder="T"
                    maxLength={12}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Start #
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={batchStart}
                    onChange={(e) => setBatchStart(e.target.value)}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Count
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={batchCount}
                    onChange={(e) => setBatchCount(e.target.value)}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Floor / Section
                  </label>
                  <input
                    list="tables-floor-sections"
                    value={batchSection}
                    onChange={(e) => setBatchSection(e.target.value)}
                    placeholder="Main Hall"
                    maxLength={60}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Seats Each
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={batchCapacity}
                    onChange={(e) => setBatchCapacity(e.target.value)}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
              </div>

              <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Preview:{' '}
                <span className="font-semibold text-slate-900">
                  {batchPrefix.trim() || 'T'}
                  {batchStart || '1'}
                </span>{' '}
                to{' '}
                <span className="font-semibold text-slate-900">
                  {batchPrefix.trim() || 'T'}
                  {Math.max(1, (Number(batchStart) || 1) + Math.max(1, Number(batchCount) || 1) - 1)}
                </span>
              </div>

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setBatchModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={batchCreating}
                  data-testid="confirm-batch-add-btn"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
                >
                  <Plus className="h-4 w-4" />
                  {batchCreating ? 'Creating...' : 'Create Tables'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
