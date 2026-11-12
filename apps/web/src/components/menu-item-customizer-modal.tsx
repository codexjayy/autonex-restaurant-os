'use client';

import { SelectionType, formatInrFromPaise } from '@autonex/shared';
import { useMemo, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import type { ModifierOptionDto, PublicMenuItemDto } from '@/lib/api-client';
import { DietaryBadge } from './dietary-badge';

export function MenuItemCustomizerModal({
  item,
  onClose,
  onConfirm,
}: {
  item: PublicMenuItemDto;
  onClose: () => void;
  onConfirm: (selectedOptions: ModifierOptionDto[], quantity: number, prepNotes: string) => void;
}) {
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    for (const group of item.modifierGroups) {
      const defaults = group.options
        .filter((o) => o.isDefault && o.inStock)
        .slice(0, group.selectionType === SelectionType.SINGLE ? 1 : group.maxSelect)
        .map((o) => o.id);
      if (defaults.length === 0 && group.isRequired && group.selectionType === SelectionType.SINGLE) {
        const firstInStock = group.options.find((o) => o.inStock);
        initial[group.id] = firstInStock ? [firstInStock.id] : [];
      } else {
        initial[group.id] = defaults;
      }
    }
    return initial;
  });

  const [quantity, setQuantity] = useState(1);
  const [prepNotes, setPrepNotes] = useState('');

  const { selectedOptions, unitPricePaise, validationError } = useMemo(() => {
    const picked: ModifierOptionDto[] = [];
    let errorMsg: string | null = null;

    for (const group of item.modifierGroups) {
      const ids = selectedByGroup[group.id] ?? [];
      const minRequired = group.isRequired ? Math.max(1, group.minSelect) : group.minSelect;

      if (ids.length < minRequired) {
        errorMsg = `Select at least ${minRequired} option(s) in "${group.name}".`;
      } else if (ids.length > group.maxSelect) {
        errorMsg = `Select at most ${group.maxSelect} option(s) in "${group.name}".`;
      }

      for (const opt of group.options) {
        if (ids.includes(opt.id)) picked.push(opt);
      }
    }

    const delta = picked.reduce((sum, o) => sum + o.priceDeltaPaise, 0);
    return {
      selectedOptions: picked,
      unitPricePaise: item.basePricePaise + delta,
      validationError: errorMsg,
    };
  }, [item, selectedByGroup]);

  const toggleOption = (
    groupId: string,
    optionId: string,
    selectionType: SelectionType,
    maxSelect: number,
  ) => {
    setSelectedByGroup((prev) => {
      const current = prev[groupId] ?? [];
      if (selectionType === SelectionType.SINGLE) {
        return {
          ...prev,
          [groupId]: current.includes(optionId) ? [] : [optionId],
        };
      }
      if (current.includes(optionId)) {
        return { ...prev, [groupId]: current.filter((id) => id !== optionId) };
      }
      if (current.length >= maxSelect) {
        return prev;
      }
      return { ...prev, [groupId]: [...current, optionId] };
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {item.imageUrl && (
              <img
                src={item.imageUrl}
                alt={item.name}
                className="h-16 w-16 shrink-0 rounded-xl border border-slate-200 object-cover"
              />
            )}
            <div>
              <div className="flex items-center gap-2">
                <DietaryBadge type={item.dietaryType} />
                <h2 className="text-lg font-bold text-slate-900">{item.name}</h2>
              </div>
              <p className="text-sm font-semibold text-slate-700">
                Base {formatInrFromPaise(item.basePricePaise)}
              </p>
              {item.description && (
                <p className="mt-1 text-xs text-slate-500">{item.description}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {item.modifierGroups.length > 0 && (
          <div className="mt-5 space-y-4">
            {item.modifierGroups.map((group) => {
              const selectedIds = selectedByGroup[group.id] ?? [];
              return (
                <div key={group.id} className="rounded-xl border border-slate-200 p-3.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-900">{group.name}</h3>
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      {group.isRequired ? 'Required' : 'Optional'} •{' '}
                      {group.selectionType === SelectionType.SINGLE
                        ? 'Choose 1'
                        : `Up to ${group.maxSelect}`}
                    </span>
                  </div>

                  <div className="mt-2.5 space-y-2">
                    {group.options.map((opt) => {
                      const checked = selectedIds.includes(opt.id);
                      const disabled = !opt.inStock;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            toggleOption(group.id, opt.id, group.selectionType, group.maxSelect)
                          }
                          className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
                            disabled
                              ? 'cursor-not-allowed border-slate-100 bg-slate-50 text-slate-400'
                              : checked
                                ? 'border-brand-600 bg-brand-50 text-slate-900'
                                : 'border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <span
                              className={`flex h-4 w-4 items-center justify-center rounded-${
                                group.selectionType === SelectionType.SINGLE ? 'full' : 'sm'
                              } border ${
                                checked
                                  ? 'border-brand-600 bg-brand-600'
                                  : 'border-slate-300 bg-white'
                              }`}
                            >
                              {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                            </span>
                            <span>{opt.name}</span>
                            {disabled && (
                              <span className="text-[10px] font-semibold uppercase text-rose-500">
                                Out of stock
                              </span>
                            )}
                          </div>
                          <span className="text-xs font-semibold text-slate-600">
                            {opt.priceDeltaPaise === 0
                              ? 'Included'
                              : opt.priceDeltaPaise > 0
                                ? `+${formatInrFromPaise(opt.priceDeltaPaise)}`
                                : formatInrFromPaise(opt.priceDeltaPaise)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4">
          <label className="block text-xs font-semibold uppercase text-slate-600">
            Cooking Instructions (optional)
          </label>
          <input
            value={prepNotes}
            onChange={(e) => setPrepNotes(e.target.value)}
            maxLength={200}
            placeholder="e.g. Less spicy, Jain, no onion..."
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
        </div>

        {validationError && (
          <p className="mt-3 text-xs font-medium text-rose-600">{validationError}</p>
        )}

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <div className="inline-flex items-center rounded-lg border border-slate-300">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="px-3 py-2 text-slate-700 hover:bg-slate-100"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-9 text-center text-sm font-bold text-slate-900">{quantity}</span>
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.min(50, q + 1))}
              className="px-3 py-2 text-slate-700 hover:bg-slate-100"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <button
            type="button"
            disabled={Boolean(validationError)}
            onClick={() => onConfirm(selectedOptions, quantity, prepNotes)}
            className="flex-1 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-40"
          >
            Add {formatInrFromPaise(unitPricePaise * quantity)}
          </button>
        </div>
      </div>
    </div>
  );
}

