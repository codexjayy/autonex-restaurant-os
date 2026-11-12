import type { ModifierOptionDto, PublicMenuItemDto } from './api-client';

export interface CartModifierSummary {
  optionId: string;
  optionName: string;
  priceDeltaPaise: number;
}

export interface CartLineItem {
  lineKey: string;
  menuItemId: string;
  itemName: string;
  dietaryType: PublicMenuItemDto['dietaryType'];
  basePricePaise: number;
  selectedOptionIds: string[];
  modifiers: CartModifierSummary[];
  unitPricePaise: number;
  quantity: number;
  prepNotes: string;
  outOfStock?: boolean;
  priceChanged?: boolean;
}

export interface StoredGuestAuth {
  guestToken: string;
  guestId: string;
  sessionId: string;
  displayLabel: string;
}

const cartStorageKey = (scopeKey: string) => `autonex_cart_v1_${scopeKey}`;
const idempotencyStorageKey = (scopeKey: string) => `autonex_idem_v1_${scopeKey}`;
const guestStorageKey = (qrToken: string) => `autonex_guest_v1_${qrToken}`;

export function buildCartLineKey(
  menuItemId: string,
  selectedOptionIds: string[],
  prepNotes: string,
): string {
  const sortedOpts = [...selectedOptionIds].sort().join(',');
  return `${menuItemId}::${sortedOpts}::${prepNotes.trim().toLowerCase()}`;
}

export function loadCartFromStorage(scopeKey: string): CartLineItem[] {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem(cartStorageKey(scopeKey));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartLineItem[]) : [];
  } catch {
    return [];
  }
}

export function saveCartToStorage(scopeKey: string, items: CartLineItem[]): void {
  if (typeof window === 'undefined') return;
  if (items.length === 0) {
    window.localStorage.removeItem(cartStorageKey(scopeKey));
  } else {
    window.localStorage.setItem(cartStorageKey(scopeKey), JSON.stringify(items));
  }
}

export function getOrCreateIdempotencyKey(scopeKey: string): string {
  if (typeof window === 'undefined') return `idem-${Date.now()}`;
  const existing = window.localStorage.getItem(idempotencyStorageKey(scopeKey));
  if (existing && existing.length >= 8) return existing;
  const generated =
    typeof window.crypto?.randomUUID === 'function'
      ? `ord-${window.crypto.randomUUID()}`
      : `ord-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(idempotencyStorageKey(scopeKey), generated);
  return generated;
}

export function clearIdempotencyKey(scopeKey: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(idempotencyStorageKey(scopeKey));
}

export function loadGuestAuth(qrToken: string): StoredGuestAuth | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(guestStorageKey(qrToken));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredGuestAuth;
  } catch {
    return null;
  }
}

export function saveGuestAuth(qrToken: string, guest: StoredGuestAuth): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(guestStorageKey(qrToken), JSON.stringify(guest));
}

export function clearGuestAuth(qrToken: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(guestStorageKey(qrToken));
}

export function addOrIncrementCartLine(
  cart: CartLineItem[],
  item: PublicMenuItemDto,
  selectedOptions: ModifierOptionDto[],
  quantity: number,
  prepNotes: string,
): CartLineItem[] {
  const selectedOptionIds = selectedOptions.map((o) => o.id);
  const lineKey = buildCartLineKey(item.id, selectedOptionIds, prepNotes);
  const modifierDelta = selectedOptions.reduce((sum, o) => sum + o.priceDeltaPaise, 0);
  const unitPricePaise = item.basePricePaise + modifierDelta;

  const existingIndex = cart.findIndex((c) => c.lineKey === lineKey);
  if (existingIndex >= 0) {
    return cart.map((line, idx) =>
      idx === existingIndex
        ? {
            ...line,
            unitPricePaise,
            quantity: Math.min(50, line.quantity + quantity),
            outOfStock: false,
            priceChanged: false,
          }
        : line,
    );
  }

  return [
    ...cart,
    {
      lineKey,
      menuItemId: item.id,
      itemName: item.name,
      dietaryType: item.dietaryType,
      basePricePaise: item.basePricePaise,
      selectedOptionIds,
      modifiers: selectedOptions.map((o) => ({
        optionId: o.id,
        optionName: o.name,
        priceDeltaPaise: o.priceDeltaPaise,
      })),
      unitPricePaise,
      quantity,
      prepNotes: prepNotes.trim(),
      outOfStock: false,
      priceChanged: false,
    },
  ];
}

export function updateCartLineQuantity(
  cart: CartLineItem[],
  lineKey: string,
  quantity: number,
): CartLineItem[] {
  if (quantity <= 0) {
    return cart.filter((c) => c.lineKey !== lineKey);
  }
  return cart.map((c) => (c.lineKey === lineKey ? { ...c, quantity: Math.min(50, quantity) } : c));
}

export function computeCartTotals(cart: CartLineItem[]) {
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotalPaise = cart.reduce((sum, item) => sum + item.unitPricePaise * item.quantity, 0);
  const hasStockIssues = cart.some((item) => Boolean(item.outOfStock));
  const hasPriceUpdates = cart.some((item) => Boolean(item.priceChanged));
  return { totalItems, subtotalPaise, hasStockIssues, hasPriceUpdates };
}

/**
 * Re-validates stored browser cart against live fetched menu after refresh or stale conflict.
 */
export function reconcileCartWithLiveMenu(
  cart: CartLineItem[],
  categories: Array<{ menuItems: PublicMenuItemDto[] }>,
): CartLineItem[] {
  const liveItems = new Map<string, PublicMenuItemDto>();
  for (const cat of categories) {
    for (const item of cat.menuItems) {
      liveItems.set(item.id, item);
    }
  }

  return cart.map((line) => {
    const live = liveItems.get(line.menuItemId);
    if (!live || !live.inStock) {
      return { ...line, outOfStock: true };
    }

    const optMap = new Map<string, ModifierOptionDto>();
    for (const group of live.modifierGroups) {
      for (const opt of group.options) {
        optMap.set(opt.id, opt);
      }
    }

    let missingOrOosOption = false;
    const updatedModifiers: CartModifierSummary[] = [];
    for (const optId of line.selectedOptionIds) {
      const liveOpt = optMap.get(optId);
      if (!liveOpt || !liveOpt.inStock) {
        missingOrOosOption = true;
      } else {
        updatedModifiers.push({
          optionId: liveOpt.id,
          optionName: liveOpt.name,
          priceDeltaPaise: liveOpt.priceDeltaPaise,
        });
      }
    }

    if (missingOrOosOption) {
      return { ...line, outOfStock: true };
    }

    const newUnitPrice =
      live.basePricePaise + updatedModifiers.reduce((s, o) => s + o.priceDeltaPaise, 0);
    const priceChanged = newUnitPrice !== line.unitPricePaise;

    return {
      ...line,
      itemName: live.name,
      basePricePaise: live.basePricePaise,
      modifiers: updatedModifiers,
      unitPricePaise: newUnitPrice,
      outOfStock: false,
      priceChanged: Boolean(line.priceChanged || priceChanged),
    };
  });
}

