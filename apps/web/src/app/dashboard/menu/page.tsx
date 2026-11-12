'use client';

import {
  DietaryType,
  KitchenStation,
  SelectionType,
  TaxMode,
  formatInrFromPaise,
  rupeesToPaise,
} from '@autonex/shared';

const STATION_LABELS: Record<KitchenStation, string> = {
  [KitchenStation.MAIN_KITCHEN]: 'Main Kitchen',
  [KitchenStation.BAR]: 'Bar',
  [KitchenStation.BAKERY]: 'Bakery',
  [KitchenStation.DESSERTS]: 'Desserts',
};
import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  ImagePlus,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import { DietaryBadge } from '@/components/dietary-badge';
import {
  ApiError,
  MenuCategoryDto,
  MenuItemDto,
  apiRequest,
  getStoredSession,
  listOutlets,
  subscribeWorkspaceSync,
} from '@/lib/api-client';

interface ModifierOptionDraft {
  name: string;
  priceDeltaRupees: string;
  inStock: boolean;
}

interface ModifierGroupDraft {
  name: string;
  selectionType: SelectionType;
  isRequired: boolean;
  options: ModifierOptionDraft[];
}

interface ItemFormState {
  id?: string;
  categoryId: string;
  name: string;
  description: string;
  dietaryType: DietaryType;
  kitchenStation: KitchenStation;
  priceRupees: string;
  prepTimeMinutes: string;
  gstOverride: boolean;
  gstRatePercent: string;
  taxMode: TaxMode;
  imageUrl: string;
  inStock: boolean;
  isActive: boolean;
  modifierGroups: ModifierGroupDraft[];
}

const EMPTY_ITEM_FORM = (categoryId: string, defaultTaxMode: TaxMode = TaxMode.EXCLUSIVE): ItemFormState => ({
  categoryId,
  name: '',
  description: '',
  dietaryType: DietaryType.VEG,
  kitchenStation: KitchenStation.MAIN_KITCHEN,
  priceRupees: '',
  prepTimeMinutes: '',
  gstOverride: false,
  gstRatePercent: '5',
  taxMode: defaultTaxMode,
  imageUrl: '',
  inStock: true,
  isActive: true,
  modifierGroups: [],
});

function formatGstBadge(gstRateBps: number, taxMode: string): string {
  const pct = (gstRateBps / 100).toFixed(2).replace(/\.00$/, '');
  if (taxMode === TaxMode.NONE || gstRateBps === 0) return '0% GST (Exempt)';
  return `${pct}% GST ${taxMode === TaxMode.INCLUSIVE ? 'Incl.' : 'Excl.'}`;
}

export default function MenuEditorPage() {
  const [categories, setCategories] = useState<MenuCategoryDto[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [outletGst, setOutletGst] = useState<{ gstRateBps: number; taxMode: TaxMode }>({
    gstRateBps: 500,
    taxMode: TaxMode.EXCLUSIVE,
  });

  const [newCategoryName, setNewCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [itemForm, setItemForm] = useState<ItemFormState>(() => EMPTY_ITEM_FORM(''));
  const [modalError, setModalError] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [savingItem, setSavingItem] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<
    | { type: 'item'; item: MenuItemDto }
    | { type: 'category'; category: MenuCategoryDto }
    | null
  >(null);
  const [deletingConfirm, setDeletingConfirm] = useState(false);

  const loadMenu = useCallback(async () => {
    setError(null);
    try {
      const [data, outlets] = await Promise.all([
        apiRequest<{ categories: MenuCategoryDto[] }>('/menus'),
        listOutlets().catch(() => []),
      ]);
      setCategories(data.categories);

      const sessionOutletId = getStoredSession()?.user?.outletId;
      const activeOutlet =
        outlets.find((o) => o.id === sessionOutletId) ?? outlets[0] ?? null;
      if (activeOutlet) {
        const bps = activeOutlet.settings?.gstRateBps ?? activeOutlet.gstRateBps ?? 500;
        const mode = (activeOutlet.settings?.taxMode ?? activeOutlet.taxMode ?? 'EXCLUSIVE') as TaxMode;
        setOutletGst({ gstRateBps: bps, taxMode: mode });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load menu');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMenu();
    return subscribeWorkspaceSync(() => {
      void loadMenu();
    });
  }, [loadMenu]);

  const handleCreateCategory = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newCategoryName.trim();
    if (!trimmed) {
      setError('Please enter a category name before clicking Add Category.');
      return;
    }
    setCreatingCategory(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const created = await apiRequest<{ id: string; name: string }>('/menus/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          sortOrder: categories.length,
        }),
      });
      setNewCategoryName('');
      setSelectedCategoryId(created.id);
      setSuccessMessage(`Category "${created.name}" created. Now add food items to it.`);
      await loadMenu();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create category');
    } finally {
      setCreatingCategory(false);
    }
  };

  const handleMoveCategory = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= categories.length) return;
    const copy = [...categories];
    const [moved] = copy.splice(index, 1);
    if (!moved) return;
    copy.splice(target, 0, moved);
    setCategories(copy);

    try {
      await apiRequest('/menus/categories/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ categoryIds: copy.map((c) => c.id) }),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reorder categories');
      await loadMenu();
    }
  };

  const handleDeleteCategory = (category: MenuCategoryDto) => {
    if (category.menuItems.length > 0) {
      setError('Move or delete items inside this category before removing it.');
      return;
    }
    setError(null);
    setConfirmDelete({ type: 'category', category });
  };

  const openCreateItem = (explicitCategoryId?: string) => {
    const defaultCategoryId =
      explicitCategoryId ||
      (selectedCategoryId !== 'ALL' ? selectedCategoryId : categories[0]?.id || '');
    if (!defaultCategoryId) {
      setError('Create a category first using "+ Add Category" before adding food items.');
      return;
    }
    setModalError(null);
    setItemForm(EMPTY_ITEM_FORM(defaultCategoryId, outletGst.taxMode));
    setItemModalOpen(true);
  };

  const openEditItem = (item: MenuItemDto) => {
    setModalError(null);
    const hasCustomGst = item.gstRateBps !== null || item.taxMode !== null;
    const effectiveBps = item.gstRateBps ?? outletGst.gstRateBps;
    setItemForm({
      id: item.id,
      categoryId: item.categoryId,
      name: item.name,
      description: item.description ?? '',
      dietaryType: item.dietaryType,
      kitchenStation: item.kitchenStation ?? KitchenStation.MAIN_KITCHEN,
      priceRupees: (item.basePricePaise / 100).toFixed(2).replace(/\.00$/, ''),
      prepTimeMinutes:
        item.prepTimeMinutes !== null && item.prepTimeMinutes !== undefined
          ? String(item.prepTimeMinutes)
          : '',
      gstOverride: hasCustomGst,
      gstRatePercent: (effectiveBps / 100).toFixed(2).replace(/\.00$/, ''),
      taxMode: (item.taxMode ?? outletGst.taxMode) as TaxMode,
      imageUrl: item.imageUrl ?? '',
      inStock: item.inStock,
      isActive: item.isActive,
      modifierGroups: item.modifierGroups.map((g) => ({
        name: g.name,
        selectionType: g.selectionType,
        isRequired: g.isRequired,
        options: g.options.map((o) => ({
          name: o.name,
          priceDeltaRupees: (o.priceDeltaPaise / 100).toFixed(2).replace(/\.00$/, ''),
          inStock: o.inStock,
        })),
      })),
    });
    setItemModalOpen(true);
  };

  const handleImageUpload = async (file: File | undefined) => {
    if (!file) return;
    setUploadingImage(true);
    setModalError(null);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const uploaded = await apiRequest<{ imageUrl: string }>('/menus/images/upload', {
        method: 'POST',
        body: formData,
      });
      setItemForm((prev) => ({ ...prev, imageUrl: uploaded.imageUrl }));
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Image upload failed');
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSaveItem = async (e: FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setError(null);
    setSuccessMessage(null);

    const trimmedName = itemForm.name.trim();
    if (!trimmedName) {
      setModalError('Food item name is required.');
      return;
    }
    if (!itemForm.categoryId) {
      setModalError('Please select a category.');
      return;
    }

    const parsedPrice = Number(itemForm.priceRupees.trim());
    if (!itemForm.priceRupees.trim() || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
      setModalError('Enter a valid non-negative price in INR.');
      return;
    }

    let prepTimeMinutes: number | null = null;
    if (itemForm.prepTimeMinutes.trim() !== '') {
      const parsedPrep = Number(itemForm.prepTimeMinutes.trim());
      if (!Number.isInteger(parsedPrep) || parsedPrep < 1 || parsedPrep > 240) {
        setModalError('Preparation time must be a whole number between 1 and 240 minutes.');
        return;
      }
      prepTimeMinutes = parsedPrep;
    }

    let gstRateBps: number | null = null;
    let taxMode: TaxMode | null = null;
    if (itemForm.gstOverride) {
      const parsedPct = Number(itemForm.gstRatePercent.trim());
      if (
        itemForm.gstRatePercent.trim() === '' ||
        !Number.isFinite(parsedPct) ||
        parsedPct < 0 ||
        parsedPct > 28
      ) {
        setModalError('GST rate must be between 0% and 28%.');
        return;
      }
      gstRateBps = itemForm.taxMode === TaxMode.NONE ? 0 : Math.round(parsedPct * 100);
      taxMode = itemForm.taxMode;
    }

    setSavingItem(true);

    try {
      const basePricePaise = rupeesToPaise(itemForm.priceRupees.trim());
      const modifierGroups = itemForm.modifierGroups.map((group, gIdx) => ({
        name: group.name.trim(),
        selectionType: group.selectionType,
        isRequired: group.isRequired,
        minSelect: group.isRequired ? 1 : 0,
        maxSelect:
          group.selectionType === SelectionType.SINGLE ? 1 : Math.max(1, group.options.length),
        sortOrder: gIdx,
        options: group.options.map((opt, oIdx) => ({
          name: opt.name.trim(),
          priceDeltaPaise: rupeesToPaise(opt.priceDeltaRupees || '0'),
          inStock: opt.inStock,
          sortOrder: oIdx,
        })),
      }));

      const payload = {
        categoryId: itemForm.categoryId,
        name: trimmedName,
        description: itemForm.description.trim(),
        dietaryType: itemForm.dietaryType,
        kitchenStation: itemForm.kitchenStation,
        basePricePaise,
        prepTimeMinutes,
        gstRateBps,
        taxMode,
        imageUrl: itemForm.imageUrl.trim() || '',
        inStock: itemForm.inStock,
        isActive: itemForm.isActive,
        modifierGroups,
      };

      if (itemForm.id) {
        await apiRequest(`/menus/items/${itemForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setSuccessMessage(`Updated "${trimmedName}" successfully.`);
      } else {
        await apiRequest('/menus/items', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setSuccessMessage(`Added "${trimmedName}" to menu.`);
      }

      setItemModalOpen(false);
      await loadMenu();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Failed to save menu item');
    } finally {
      setSavingItem(false);
    }
  };

  const handleToggleStock = async (item: MenuItemDto) => {
    const next = !item.inStock;
    setCategories((prev) =>
      prev.map((cat) => ({
        ...cat,
        menuItems: cat.menuItems.map((it) => (it.id === item.id ? { ...it, inStock: next } : it)),
      })),
    );
    try {
      await apiRequest(`/menus/items/${item.id}/stock`, {
        method: 'PATCH',
        body: JSON.stringify({ inStock: next }),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update stock');
      await loadMenu();
    }
  };

  const handleDeleteItem = (item: MenuItemDto) => {
    setError(null);
    setConfirmDelete({ type: 'item', item });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setDeletingConfirm(true);
    setError(null);
    setSuccessMessage(null);
    try {
      if (confirmDelete.type === 'item') {
        const res = await apiRequest<{ archived?: boolean; deleted?: boolean }>(
          `/menus/items/${confirmDelete.item.id}`,
          { method: 'DELETE' },
        );
        setSuccessMessage(
          res.archived
            ? `"${confirmDelete.item.name}" has historical orders and was archived from menus.`
            : `"${confirmDelete.item.name}" was deleted from the menu.`,
        );
      } else {
        await apiRequest(`/menus/categories/${confirmDelete.category.id}`, {
          method: 'DELETE',
        });
        if (selectedCategoryId === confirmDelete.category.id) {
          setSelectedCategoryId('ALL');
        }
        setSuccessMessage(`Category "${confirmDelete.category.name}" was deleted.`);
      }
      setConfirmDelete(null);
      await loadMenu();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete');
      setConfirmDelete(null);
    } finally {
      setDeletingConfirm(false);
    }
  };

  const visibleCategories = categories.filter(
    (cat) => selectedCategoryId === 'ALL' || cat.id === selectedCategoryId,
  );

  const normalizedQuery = search.trim().toLowerCase();

  return (
    <DashboardShell
      title="Menu Editor"
      subtitle="Update dishes, modifier prices, images, and stock availability — your printed table QRs update automatically."
      onOutletChanged={() => {
        setSelectedCategoryId('ALL');
        setSuccessMessage(null);
        void loadMenu();
      }}
    >
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            {successMessage}
          </span>
          <button type="button" onClick={() => setSuccessMessage(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start">
        {/* Categories Sidebar */}
        <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:sticky lg:top-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Categories</h2>
            <span className="text-xs font-medium text-slate-400">{categories.length}</span>
          </div>

          <form onSubmit={handleCreateCategory} className="mt-2.5 space-y-2">
            <input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="New category name..."
              aria-label="New category name"
              className="h-9 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            <button
              type="submit"
              disabled={creatingCategory}
              data-testid="add-category-btn"
              className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              {creatingCategory ? 'Adding Category...' : 'Add Category'}
            </button>
          </form>

          <div className="mt-3 space-y-0.5 border-t border-slate-100 pt-2.5">
            <button
              type="button"
              onClick={() => setSelectedCategoryId('ALL')}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition ${
                selectedCategoryId === 'ALL'
                  ? 'bg-orange-50 text-orange-700'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>All Categories</span>
              <span className="text-xs font-semibold text-slate-500">
                {categories.reduce((acc, c) => acc + c.menuItems.length, 0)}
              </span>
            </button>

            {categories.map((cat, idx) => (
              <div
                key={cat.id}
                className={`flex items-center justify-between rounded-lg px-2.5 py-1 transition ${
                  selectedCategoryId === cat.id
                    ? 'bg-orange-50 text-orange-700'
                    : 'hover:bg-slate-50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedCategoryId(cat.id)}
                  className={`flex-1 truncate text-left text-sm font-medium ${
                    selectedCategoryId === cat.id ? 'text-orange-700' : 'text-slate-800'
                  }`}
                >
                  {cat.name}{' '}
                  <span className="text-xs font-normal text-slate-400">
                    ({cat.menuItems.length})
                  </span>
                </button>
                <div className="flex items-center gap-0.5 text-slate-400">
                  <button
                    type="button"
                    title="Move up"
                    disabled={idx === 0}
                    onClick={() => handleMoveCategory(idx, -1)}
                    className="p-1 hover:text-slate-700 disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={idx === categories.length - 1}
                    onClick={() => handleMoveCategory(idx, 1)}
                    className="p-1 hover:text-slate-700 disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Delete empty category"
                    aria-label={`Delete category ${cat.name}`}
                    onClick={() => handleDeleteCategory(cat)}
                    className="p-1 hover:text-rose-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Items Main Panel */}
        <section className="min-w-0 space-y-4">
          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search dishes..."
                aria-label="Search dishes"
                className="h-9 w-full rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>
            {categories.length > 0 && (
              <button
                type="button"
                data-testid="add-food-item-btn"
                onClick={() => openCreateItem()}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" />
                Add Food Item
              </button>
            )}
          </div>

          {loading ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              Loading menu...
            </div>
          ) : categories.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-600">
              Start by adding your first menu category (e.g. Starters, Thali, Beverages) using{' '}
              <span className="font-semibold text-slate-800">+ Add Category</span> on the left.
            </div>
          ) : (
            visibleCategories.map((category) => {
              const filteredItems = category.menuItems.filter(
                (item) =>
                  !normalizedQuery ||
                  item.name.toLowerCase().includes(normalizedQuery) ||
                  (item.description ?? '').toLowerCase().includes(normalizedQuery),
              );

              return (
                <div
                  key={category.id}
                  className="rounded-2xl border border-slate-200 bg-white shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <h3 className="font-semibold text-slate-900">{category.name}</h3>
                      <span className="text-xs text-slate-500">{filteredItems.length} items</span>
                    </div>
                    <button
                      type="button"
                      data-testid={`category-add-food-item-${category.id}`}
                      onClick={() => openCreateItem(category.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700 transition hover:bg-orange-100"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Food Item
                    </button>
                  </div>

                  {filteredItems.length === 0 ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 text-sm text-slate-500">
                      <span>
                        {normalizedQuery
                          ? `No dishes match "${search.trim()}" in ${category.name}.`
                          : `No food items in ${category.name} yet.`}
                      </span>
                      {!normalizedQuery && (
                        <button
                          type="button"
                          onClick={() => openCreateItem(category.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add Food Item
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {filteredItems.map((item) => {
                        const effectiveBps = item.gstRateBps ?? outletGst.gstRateBps;
                        const effectiveTaxMode = item.taxMode ?? outletGst.taxMode;
                        const isCustomGst = item.gstRateBps !== null || item.taxMode !== null;

                        return (
                          <div
                            key={item.id}
                            className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
                          >
                            <div className="flex items-start gap-3.5">
                              {item.imageUrl ? (
                                <img
                                  src={item.imageUrl}
                                  alt={item.name}
                                  className="h-14 w-14 rounded-lg border border-slate-200 object-cover"
                                />
                              ) : (
                                <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-400">
                                  No img
                                </div>
                              )}
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <DietaryBadge type={item.dietaryType} />
                                  <span className="font-semibold text-slate-900">{item.name}</span>
                                  <span className="text-sm font-bold text-slate-800">
                                    {formatInrFromPaise(item.basePricePaise)}
                                  </span>
                                  {item.prepTimeMinutes && (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                                      <Clock className="h-3 w-3 text-slate-500" />
                                      {item.prepTimeMinutes} min
                                    </span>
                                  )}
                                  {item.kitchenStation &&
                                    item.kitchenStation !== KitchenStation.MAIN_KITCHEN && (
                                      <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-700 ring-1 ring-orange-200">
                                        {STATION_LABELS[item.kitchenStation] ?? item.kitchenStation}
                                      </span>
                                    )}
                                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                                    <Receipt className="h-3 w-3 text-slate-500" />
                                    {isCustomGst
                                      ? formatGstBadge(effectiveBps, effectiveTaxMode)
                                      : `Outlet GST (${formatGstBadge(effectiveBps, effectiveTaxMode)})`}
                                  </span>
                                  {!item.isActive && (
                                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                                      Hidden
                                    </span>
                                  )}
                                </div>
                                {item.description && (
                                  <p className="mt-0.5 text-xs text-slate-500">{item.description}</p>
                                )}
                                {item.modifierGroups.length > 0 && (
                                  <p className="mt-1 text-xs font-medium text-orange-700">
                                    Modifiers: {item.modifierGroups.map((g) => g.name).join(', ')}
                                  </p>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => handleToggleStock(item)}
                                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                                  item.inStock
                                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100'
                                    : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100'
                                }`}
                              >
                                {item.inStock ? 'Available' : 'Unavailable'}
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditItem(item)}
                                className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                                title="Edit item"
                                aria-label={`Edit ${item.name}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteItem(item)}
                                className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                                title="Delete item"
                                aria-label={`Delete ${item.name}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </section>
      </div>

      {/* Add / Edit Item Modal */}
      {itemModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-lg font-bold text-slate-900">
                {itemForm.id ? 'Edit Food Item' : 'Add Food Item'}
              </h2>
              <button
                type="button"
                aria-label="Close modal"
                onClick={() => setItemModalOpen(false)}
              >
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                <span>{modalError}</span>
                <button type="button" onClick={() => setModalError(null)}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <form onSubmit={handleSaveItem} className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Food Item Name
                  </label>
                  <input
                    required
                    value={itemForm.name}
                    onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
                    placeholder="e.g. Paneer Butter Masala"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Category
                  </label>
                  <select
                    value={itemForm.categoryId}
                    onChange={(e) => setItemForm({ ...itemForm, categoryId: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Price in INR (₹)
                  </label>
                  <input
                    required
                    type="text"
                    inputMode="decimal"
                    value={itemForm.priceRupees}
                    onChange={(e) => setItemForm({ ...itemForm, priceRupees: e.target.value })}
                    placeholder="240"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Preparation Time (minutes)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={240}
                    step={1}
                    value={itemForm.prepTimeMinutes}
                    onChange={(e) => setItemForm({ ...itemForm, prepTimeMinutes: e.target.value })}
                    placeholder="e.g. 15"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Veg / Non-Veg Indicator
                </label>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {[
                    { value: DietaryType.VEG, label: 'Veg' },
                    { value: DietaryType.EGG, label: 'Egg' },
                    { value: DietaryType.NON_VEG, label: 'Non-Veg' },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setItemForm({ ...itemForm, dietaryType: option.value })}
                      className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                        itemForm.dietaryType === option.value
                          ? 'border-orange-600 bg-orange-50 text-orange-700 ring-1 ring-orange-600'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <DietaryBadge type={option.value} />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Kitchen Station Routing
                </label>
                <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    KitchenStation.MAIN_KITCHEN,
                    KitchenStation.BAR,
                    KitchenStation.BAKERY,
                    KitchenStation.DESSERTS,
                  ].map((station) => (
                    <button
                      key={station}
                      type="button"
                      onClick={() => setItemForm({ ...itemForm, kitchenStation: station })}
                      className={`rounded-lg border px-2.5 py-2 text-xs font-semibold transition ${
                        itemForm.kitchenStation === station
                          ? 'border-orange-600 bg-orange-50 text-orange-700 ring-1 ring-orange-600'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {STATION_LABELS[station]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Description
                </label>
                <textarea
                  rows={2}
                  maxLength={280}
                  value={itemForm.description}
                  onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
                  placeholder="Short description for guests..."
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div className="rounded-xl border border-slate-200 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase text-slate-600">
                      Food Image Upload (Resized to WebP)
                    </p>
                    <p className="text-xs text-slate-500">JPEG, PNG, or WebP up to 5 MB</p>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                    <ImagePlus className="h-4 w-4" />
                    {uploadingImage ? 'Uploading...' : 'Upload Photo'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => handleImageUpload(e.target.files?.[0])}
                    />
                  </label>
                </div>
                {itemForm.imageUrl && (
                  <div className="mt-3 flex items-center gap-3">
                    <img
                      src={itemForm.imageUrl}
                      alt="Preview"
                      className="h-14 w-14 rounded-lg border border-slate-200 object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setItemForm({ ...itemForm, imageUrl: '' })}
                      className="text-xs font-medium text-rose-600 hover:underline"
                    >
                      Remove Image
                    </button>
                  </div>
                )}
              </div>

              {/* Availability & Customer QR visibility */}
              <div className="grid gap-3 rounded-xl border border-slate-200 p-3.5 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase text-slate-600">Availability</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setItemForm({ ...itemForm, inStock: true })}
                      className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                        itemForm.inStock
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-700'
                          : 'border-slate-200 bg-white text-slate-600'
                      }`}
                    >
                      Available
                    </button>
                    <button
                      type="button"
                      onClick={() => setItemForm({ ...itemForm, inStock: false })}
                      className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                        !itemForm.inStock
                          ? 'border-rose-600 bg-rose-50 text-rose-700'
                          : 'border-slate-200 bg-white text-slate-600'
                      }`}
                    >
                      Unavailable
                    </button>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase text-slate-600">Customer QR Menu</p>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={itemForm.isActive}
                      onChange={(e) => setItemForm({ ...itemForm, isActive: e.target.checked })}
                    />
                    Visible on Customer QR Menu
                  </label>
                </div>
              </div>

              {/* GST Configuration */}
              <div className="rounded-xl border border-slate-200 p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase text-slate-600">
                      GST Configuration
                    </p>
                    <p className="text-xs text-slate-500">
                      Outlet default: {formatGstBadge(outletGst.gstRateBps, outletGst.taxMode)}
                    </p>
                  </div>
                  <div className="inline-flex rounded-lg border border-slate-200 p-0.5">
                    <button
                      type="button"
                      onClick={() => setItemForm({ ...itemForm, gstOverride: false })}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                        !itemForm.gstOverride
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Outlet Default
                    </button>
                    <button
                      type="button"
                      onClick={() => setItemForm({ ...itemForm, gstOverride: true })}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                        itemForm.gstOverride
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Custom GST
                    </button>
                  </div>
                </div>

                {itemForm.gstOverride && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-slate-600">
                        GST Rate (%)
                      </label>
                      <select
                        value={itemForm.gstRatePercent}
                        onChange={(e) =>
                          setItemForm({ ...itemForm, gstRatePercent: e.target.value })
                        }
                        disabled={itemForm.taxMode === TaxMode.NONE}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                      >
                        <option value="0">0% (Exempt)</option>
                        <option value="5">5% (Standard Restaurant)</option>
                        <option value="12">12%</option>
                        <option value="18">18%</option>
                        <option value="28">28%</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">
                        Tax Calculation Mode
                      </label>
                      <select
                        value={itemForm.taxMode}
                        onChange={(e) => {
                          const nextMode = e.target.value as TaxMode;
                          setItemForm({
                            ...itemForm,
                            taxMode: nextMode,
                            gstRatePercent:
                              nextMode === TaxMode.NONE ? '0' : itemForm.gstRatePercent,
                          });
                        }}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value={TaxMode.EXCLUSIVE}>Exclusive (added at billing)</option>
                        <option value={TaxMode.INCLUSIVE}>Inclusive (included in price)</option>
                        <option value={TaxMode.NONE}>Exempt (No GST)</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>

              {/* Modifiers Builder */}
              <div className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">Modifiers / Add-ons</h3>
                  <button
                    type="button"
                    onClick={() =>
                      setItemForm((prev) => ({
                        ...prev,
                        modifierGroups: [
                          ...prev.modifierGroups,
                          {
                            name: '',
                            selectionType: SelectionType.SINGLE,
                            isRequired: false,
                            options: [{ name: '', priceDeltaRupees: '0', inStock: true }],
                          },
                        ],
                      }))
                    }
                    className="inline-flex items-center gap-1 text-xs font-semibold text-orange-600 hover:underline"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add Modifier Group
                  </button>
                </div>

                <div className="mt-3 space-y-3">
                  {itemForm.modifierGroups.map((group, gIdx) => (
                    <div key={gIdx} className="rounded-lg bg-slate-50 p-3 space-y-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          required
                          value={group.name}
                          onChange={(e) => {
                            const next = [...itemForm.modifierGroups];
                            next[gIdx] = { ...group, name: e.target.value };
                            setItemForm({ ...itemForm, modifierGroups: next });
                          }}
                          placeholder="Group name (e.g. Spice Level, Add-ons)"
                          className="flex-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                        />
                        <select
                          value={group.selectionType}
                          onChange={(e) => {
                            const next = [...itemForm.modifierGroups];
                            next[gIdx] = {
                              ...group,
                              selectionType: e.target.value as SelectionType,
                            };
                            setItemForm({ ...itemForm, modifierGroups: next });
                          }}
                          className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                        >
                          <option value={SelectionType.SINGLE}>Single Choice</option>
                          <option value={SelectionType.MULTI}>Multi Choice</option>
                        </select>
                        <label className="flex items-center gap-1 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={group.isRequired}
                            onChange={(e) => {
                              const next = [...itemForm.modifierGroups];
                              next[gIdx] = { ...group, isRequired: e.target.checked };
                              setItemForm({ ...itemForm, modifierGroups: next });
                            }}
                          />
                          Required
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setItemForm((prev) => ({
                              ...prev,
                              modifierGroups: prev.modifierGroups.filter((_, i) => i !== gIdx),
                            }))
                          }
                          className="text-rose-600 hover:text-rose-700"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      {group.options.map((opt, oIdx) => (
                        <div key={oIdx} className="flex items-center gap-2 pl-2">
                          <input
                            required
                            value={opt.name}
                            onChange={(e) => {
                              const next = [...itemForm.modifierGroups];
                              const nextOpts = [...group.options];
                              nextOpts[oIdx] = { ...opt, name: e.target.value };
                              next[gIdx] = { ...group, options: nextOpts };
                              setItemForm({ ...itemForm, modifierGroups: next });
                            }}
                            placeholder="Option (e.g. Extra Butter)"
                            className="flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs"
                          />
                          <input
                            value={opt.priceDeltaRupees}
                            onChange={(e) => {
                              const next = [...itemForm.modifierGroups];
                              const nextOpts = [...group.options];
                              nextOpts[oIdx] = { ...opt, priceDeltaRupees: e.target.value };
                              next[gIdx] = { ...group, options: nextOpts };
                              setItemForm({ ...itemForm, modifierGroups: next });
                            }}
                            placeholder="+₹ (0)"
                            className="w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          />
                          {group.options.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                const next = [...itemForm.modifierGroups];
                                next[gIdx] = {
                                  ...group,
                                  options: group.options.filter((_, idx) => idx !== oIdx),
                                };
                                setItemForm({ ...itemForm, modifierGroups: next });
                              }}
                              className="text-slate-400 hover:text-rose-600"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      ))}

                      <button
                        type="button"
                        onClick={() => {
                          const next = [...itemForm.modifierGroups];
                          next[gIdx] = {
                            ...group,
                            options: [
                              ...group.options,
                              { name: '', priceDeltaRupees: '0', inStock: true },
                            ],
                          };
                          setItemForm({ ...itemForm, modifierGroups: next });
                        }}
                        className="pl-2 text-xs font-medium text-orange-600 hover:underline"
                      >
                        + Add Option
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setItemModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingItem}
                  data-testid="save-food-item-btn"
                  className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
                >
                  {savingItem
                    ? 'Saving...'
                    : itemForm.id
                      ? 'Update Food Item'
                      : 'Save Food Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
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
                  {confirmDelete.type === 'item' ? 'Delete Food Item?' : 'Delete Category?'}
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  {confirmDelete.type === 'item' ? (
                    <>
                      Are you sure you want to remove{' '}
                      <span className="font-semibold text-slate-900">
                        {confirmDelete.item.name}
                      </span>
                      ? If this dish appears in past orders, it will be archived from active menus.
                    </>
                  ) : (
                    <>
                      Are you sure you want to delete the empty category{' '}
                      <span className="font-semibold text-slate-900">
                        {confirmDelete.category.name}
                      </span>
                      ?
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                disabled={deletingConfirm}
                onClick={() => setConfirmDelete(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingConfirm}
                data-testid="confirm-delete-btn"
                onClick={() => void handleConfirmDelete()}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {deletingConfirm ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

