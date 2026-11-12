'use client';

import { useState } from 'react';
import { Printer, X } from 'lucide-react';
import { DietaryType, KdsTicketPayload } from '@autonex/shared';

function dietaryTag(dietary: DietaryType): string {
  if (dietary === DietaryType.VEG) return '[V]';
  if (dietary === DietaryType.NON_VEG) return '[NV]';
  return '[EGG]';
}

export function KotPrintModal({
  ticket,
  outletName,
  onClose,
}: {
  ticket: KdsTicketPayload;
  outletName: string;
  onClose: () => void;
}) {
  const [paperWidth, setPaperWidth] = useState<'58mm' | '80mm'>('80mm');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 print:static print:bg-white print:p-0">
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #autonex-kot-print-sheet,
          #autonex-kot-print-sheet * {
            visibility: visible;
          }
          #autonex-kot-print-sheet {
            position: absolute;
            left: 0;
            top: 0;
            margin: 0;
            box-shadow: none !important;
            border: none !important;
          }
        }
      `}</style>

      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl print:max-w-none print:border-0 print:bg-white print:shadow-none">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5 print:hidden">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">Thermal KOT Print Preview</span>
            <div className="flex rounded-lg bg-slate-800 p-0.5 text-xs">
              {(['58mm', '80mm'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setPaperWidth(w)}
                  className={`rounded-md px-2 py-1 font-semibold ${
                    paperWidth === w ? 'bg-brand-600 text-white' : 'text-slate-300'
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close print preview"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex justify-center bg-slate-950/60 p-5 print:bg-white print:p-0">
          <div
            id="autonex-kot-print-sheet"
            style={{ width: paperWidth === '58mm' ? '220px' : '302px' }}
            className="rounded-lg bg-white p-4 font-mono text-xs text-slate-950 shadow-md print:rounded-none print:p-1 print:shadow-none"
          >
            <div className="border-b border-dashed border-slate-400 pb-2 text-center">
              <div className="text-sm font-bold uppercase tracking-wide">{outletName}</div>
              <div className="mt-0.5 font-bold">
                KOT #{ticket.kotNumber}{' '}
                {ticket.isAddOn ? `· ADD-ON (R${ticket.roundNumber})` : `(R${ticket.roundNumber})`}
              </div>
              <div className="mt-1 text-base font-extrabold">
                TABLE {ticket.tableNumber}
                {ticket.tableLabel ? ` (${ticket.tableLabel})` : ''}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-600">
                {new Date(ticket.createdAt).toLocaleString('en-IN', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {ticket.source === 'STAFF_POS' ? 'WAITER' : 'QR'}
              </div>
            </div>

            <div className="my-2 space-y-2 border-b border-dashed border-slate-400 pb-2">
              {ticket.items.map((item) => (
                <div key={item.id}>
                  <div className="flex items-start justify-between gap-2 font-bold">
                    <span>
                      {item.quantity}x {item.itemNameSnapshot}
                    </span>
                    <span className="shrink-0 text-[10px]">{dietaryTag(item.dietaryTypeSnapshot)}</span>
                  </div>
                  {item.modifiersSnapshotJson?.length > 0 && (
                    <div className="pl-3 text-[11px] text-slate-700">
                      + {item.modifiersSnapshotJson.map((m) => m.optionName).join(', ')}
                    </div>
                  )}
                  {item.prepNotes && (
                    <div className="pl-3 text-[11px] font-bold uppercase text-slate-900">
                      * {item.prepNotes}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {ticket.notes && (
              <div className="mb-2 border-b border-dashed border-slate-400 pb-2 text-[11px] font-bold">
                NOTE: {ticket.notes}
              </div>
            )}

            <div className="text-center text-[10px] text-slate-500">
              AutoNex KDS · Status: {ticket.kitchenStatus}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3.5 print:hidden">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Printer className="h-4 w-4" />
            Print KOT ({paperWidth})
          </button>
        </div>
      </div>
    </div>
  );
}

