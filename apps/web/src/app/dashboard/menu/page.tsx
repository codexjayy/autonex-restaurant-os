'use client';

import { DietaryType, SelectionType, formatInrFromPaise, rupeesToPaise } from '@autonex/shared';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ImagePlus,
  Pencil,
  Plus,
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
  priceRupees: string;
  imageUrl: string;
  inStock: boolean;
  isActive: boolean;
  modifierGroups: ModifierGroupDraft[];
}

const EMPTY_ITEM_FORM = (categoryId: string): ItemFormState => ({
  categoryId,
  name: '',
  description: '',
  dietaryType: DietaryType.VEG,
  priceRupees: '',
  imageUrl: '',
  inStock: true,
  isActive: true,
  modifierGroups: [],
});

export default function MenuEditorPage() {
  const [categories, setCategories] = useState<MenuCategoryDto[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newCategoryName, setNewCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [itemForm, setItemForm] = useState<ItemFormState>(() => EMPTY_ITEM_FORM(''));
  const [uploadingImage, setUploadingImage] = useState(false);
  const [savingItem, setSavingItem] = useState(false);

  const loadMenu = useCallback(async () => {
    setError(null);
    try {
      const data = await apiRequest<{ categories: MenuCategoryDto[] }>('/menus');
      setCategories(data.categories);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load menu');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMenu();
  }, [loadMenu]);

  const handleCreateCategory = async (e: FormEvent) => {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    setCreatingCategory(true);
    setError(null);
    try {
      await apiRequest('/menus/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: newCategoryName.trim(),
          sortOrder: categories.length,
        }),
      });
      setNewCategoryName('');
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

  const handleDeleteCategory = async (category: MenuCategoryDto) => {
    if (category.menuItems.length > 0) {
      setError('Move or delete items inside this category before removing it.');
      return;
    }
    try {
      await apiRequest(`/menus/categories/${category.id}`, { method: 'DELETE' });
      if (selectedCategoryId === category.id) setSelectedCategoryId('ALL');
      await loadMenu();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete category');
    }
  };

  const openCreateItem = () => {
    const defaultCategoryId =
      selectedCategoryId !== 'ALL' ? selectedCategoryId : categories[0]?.id || '';
    if (!defaultCategoryId) {
      setError('Create at least one category before adding menu items.');
      return;
    }
    setItemForm(EMPTY_ITEM_FORM(defaultCategoryId));
    setItemModalOpen(true);
  };

  const openEditItem = (item: MenuItemDto) => {
    setItemForm({
      id: item.id,
      categoryId: item.categoryId,
      name: item.name,
      description: item.description ?? '',
      dietaryType: item.dietaryType,
      priceRupees: (item.basePricePaise / 100).toFixed(2).replace(/\.00$/, ''),
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
      setError(err instanceof ApiError ? err.message : 'Image upload failed');
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSaveItem = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSavingItem(true);

    try {
      const basePricePaise = rupeesToPaise(itemForm.priceRupees || '0');
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
        name: itemForm.name.trim(),
        description: itemForm.description.trim() || undefined,
        dietaryType: itemForm.dietaryType,
        basePricePaise,
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
      } else {
        await apiRequest('/menus/items', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      setItemModalOpen(false);
      await loadMenu();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save menu item');
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

  const handleDeleteItem = async (item: MenuItemDto) => {
    try {
      await apiRequest(`/menus/items/${item.id}`, { method: 'DELETE' });
      await loadMenu();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete item');
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
    >
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-4">
        {/* Categories Sidebar */}
        <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-1">
          <h2 className="text-sm font-semibold text-slate-900">Categories</h2>

          <form onSubmit={handleCreateCategory} className="mt-3 flex gap-2">
            <input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="New category..."
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={creatingCategory}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
            </button>
          </form>

          <div className="mt-4 space-y-1">
            <button
              type="button"
              onClick={() => setSelectedCategoryId('ALL')}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium ${
                selectedCategoryId === 'ALL'
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>All Categories</span>
              <span className="text-xs text-slate-500">
                {categories.reduce((acc, c) => acc + c.menuItems.length, 0)}
              </span>
            </button>

            {categories.map((cat, idx) => (
              <div
                key={cat.id}
                className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${
                  selectedCategoryId === cat.id ? 'bg-brand-50' : 'hover:bg-slate-50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedCategoryId(cat.id)}
                  className="flex-1 truncate text-left text-sm font-medium text-slate-800"
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
        <section className="space-y-4 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search dishes..."
                className="w-full rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={openCreateItem}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" />
              Add Menu Item
            </button>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              Loading menu...
            </div>
          ) : categories.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-600">
              Start by adding your first menu category (e.g. Starters, Thali, Beverages) on the left.
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
                  <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                    <h3 className="font-semibold text-slate-900">{category.name}</h3>
                    <span className="text-xs text-slate-500">{filteredItems.length} items</span>
                  </div>

                  {filteredItems.length === 0 ? (
                    <p className="px-5 py-4 text-sm text-slate-500">No items in this view.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {filteredItems.map((item) => (
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
                              <div className="flex items-center gap-2">
                                <DietaryBadge type={item.dietaryType} />
                                <span className="font-semibold text-slate-900">{item.name}</span>
                                <span className="text-sm font-bold text-slate-800">
                                  {formatInrFromPaise(item.basePricePaise)}
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
                                <p className="mt-1 text-xs text-brand-700">
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
                              {item.inStock ? 'In Stock' : 'Out of Stock'}
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditItem(item)}
                              className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                              title="Edit item"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteItem(item)}
                              className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                              title="Delete item"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
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
                {itemForm.id ? 'Edit Menu Item' : 'Add Menu Item'}
              </h2>
              <button type="button" onClick={() => setItemModalOpen(false)}>
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>

            <form onSubmit={handleSaveItem} className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
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
                    Dietary Type
                  </label>
                  <select
                    value={itemForm.dietaryType}
                    onChange={(e) =>
                      setItemForm({ ...itemForm, dietaryType: e.target.value as DietaryType })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value={DietaryType.VEG}>Veg</option>
                    <option value={DietaryType.EGG}>Egg</option>
                    <option value={DietaryType.NON_VEG}>Non-Veg</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-600">
                    Dish Name
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
                    Price (INR ₹)
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
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Description
                </label>
                <textarea
                  rows={2}
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
                      Dish Image (Resized to WebP)
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

              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={itemForm.inStock}
                    onChange={(e) => setItemForm({ ...itemForm, inStock: e.target.checked })}
                  />
                  Currently In Stock
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={itemForm.isActive}
                    onChange={(e) => setItemForm({ ...itemForm, isActive: e.target.checked })}
                  />
                  Visible on QR Menu
                </label>
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
                    className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
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
                        className="pl-2 text-xs font-medium text-brand-600 hover:underline"
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
                  className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {savingItem ? 'Saving...' : 'Save Dish'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

