'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PRODUCT_CATEGORIES } from '@/lib/constants';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

interface ProductGroup {
  base_name: string;
  slug: string;
  tamano: string;
  categoria: string;
  family_name?: string | null;
  variantes: {
    sku: string;
    color: string;
    color_slug: string;
    item_id?: string;
    titulo?: string;
    thumbnail?: string;
    permalink?: string;
    tipo?: string | null;
    bed_size?: string | null;
    label?: string;
  }[];
}

function SyncMlFamiliesButton() {
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function handleSync() {
    setSyncing(true);
    setStatus(null);
    try {
      const statRes = await fetch('/api/sync/ml-families');
      const stat = (await statRes.json()) as { pending_sync?: number };
      const pending = stat.pending_sync ?? 0;
      if (pending === 0) {
        setStatus('Sin pendientes');
        setTimeout(() => window.location.reload(), 800);
        return;
      }
      const res = await fetch('/api/sync/ml-families?stale_only=1', { method: 'POST' });
      const data = (await res.json()) as { synced?: number; error_count?: number };
      setStatus(`Sync: ${data.synced ?? 0}${data.error_count ? ` · ${data.error_count} errores` : ''}`);
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Error');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSync}
      disabled={syncing}
      className="text-blue-600 hover:underline disabled:opacity-50"
      title="Refresca family_name y titulos desde MercadoLibre"
    >
      {syncing ? 'Sincronizando…' : status || 'Sync ML'}
    </button>
  );
}

function ProductCombobox({
  productos,
  loading,
  selectedSlugs,
  onToggle,
  onClear,
}: {
  productos: ProductGroup[];
  loading: boolean;
  selectedSlugs: string[];
  onToggle: (slug: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedSet = new Set(selectedSlugs);
  const selectedProducts = productos.filter((p) => selectedSet.has(p.slug));
  const totalVariantes = selectedProducts.reduce((sum, p) => sum + p.variantes.length, 0);

  const filtered = productos.filter((p) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      p.base_name.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q) ||
      p.tamano.toLowerCase().includes(q) ||
      p.categoria.toLowerCase().includes(q) ||
      p.variantes.some((v) => v.sku.toLowerCase().includes(q) || v.color.toLowerCase().includes(q))
    );
  });

  const placeholder = loading
    ? 'Cargando...'
    : selectedSlugs.length === 0
    ? 'Buscar y seleccionar productos...'
    : `${selectedSlugs.length} producto${selectedSlugs.length !== 1 ? 's' : ''} · ${totalVariantes} variantes`;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Productos del catalogo</Label>
        <div className="flex items-center gap-3 text-xs">
          <SyncMlFamiliesButton />
          {selectedSlugs.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="text-muted-foreground hover:text-foreground"
            >
              Limpiar todo
            </button>
          )}
        </div>
      </div>
      <div ref={wrapperRef} className="relative">
        <Input
          value={open ? query : ''}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => { setOpen(true); }}
          placeholder={placeholder}
          className={open ? 'ring-2 ring-ring' : ''}
        />
        {open && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[320px] overflow-y-auto rounded-md border bg-popover shadow-lg">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">Sin resultados</div>
            ) : (
              filtered.map((p) => {
                const isSelected = selectedSet.has(p.slug);
                return (
                  <button
                    key={p.slug}
                    type="button"
                    onClick={() => onToggle(p.slug)}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${isSelected ? 'bg-accent' : ''}`}
                  >
                    <div className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border ${isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground'}`}>
                      {isSelected && <span className="block text-center text-xs leading-3">✓</span>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{p.base_name} — {p.tamano}</div>
                      <div className="text-xs text-muted-foreground">{p.variantes.length} variantes · {p.categoria}</div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      {selectedProducts.length > 0 && (
        <div className="mt-2 space-y-2 rounded-md bg-muted p-3 text-sm">
          {selectedProducts.map((p) => (
            <div key={p.slug} className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => onToggle(p.slug)}
                className="mt-0.5 text-muted-foreground hover:text-destructive"
                title="Quitar"
              >
                ✕
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{p.base_name} — {p.tamano}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.variantes.map((v) => (
                    <span key={v.sku} className="rounded bg-background px-1.5 py-0.5 text-[10px]">
                      {v.label || v.color} <span className="text-muted-foreground">({v.sku})</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NewProjectPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'catalog' | 'manual'>('catalog');
  const [productos, setProductos] = useState<ProductGroup[]>([]);
  const [loadingProductos, setLoadingProductos] = useState(true);
  const [selectedProductos, setSelectedProductos] = useState<string[]>([]);

  // Form fields
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [skuBase, setSkuBase] = useState('');
  const [description, setDescription] = useState('');
  const [brandId, setBrandId] = useState('');
  const [brands, setBrands] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    fetch('/api/productos')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setProductos(data);
      })
      .finally(() => setLoadingProductos(false));
    fetch('/api/brands')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setBrands(data);
      });
  }, []);

  function handleProductoToggle(slug: string) {
    setSelectedProductos((prev) => {
      const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
      // Auto-fill form fields based on the new selection
      const selected = productos.filter((p) => next.includes(p.slug));
      if (selected.length === 0) {
        setName('');
        setCategory('');
        setSkuBase('');
        setDescription('');
      } else if (selected.length === 1) {
        const prod = selected[0];
        setName(prod.base_name);
        setCategory(prod.categoria);
        setSkuBase(prod.slug);
        const varList = prod.variantes.map((v) => `${v.sku} (${v.color})`).join(', ');
        setDescription(`${prod.tamano} — ${prod.variantes.length} variantes: ${varList}`);
      } else {
        // Multiple products combined — derive a generic name
        const totalVariants = selected.reduce((sum, p) => sum + p.variantes.length, 0);
        const categorias = [...new Set(selected.map((p) => p.categoria))];
        const tamanos = [...new Set(selected.map((p) => p.tamano))];
        // Find common prefix from base_name (e.g. "Jgo Sabana Polar AF 100%Pol Est")
        const names = selected.map((p) => p.base_name);
        let commonPrefix = names[0];
        for (let i = 1; i < names.length; i++) {
          while (commonPrefix && !names[i].startsWith(commonPrefix)) {
            commonPrefix = commonPrefix.slice(0, -1);
          }
        }
        const prefix = commonPrefix.trim().replace(/[—-]+$/, '').trim();
        setName(prefix || `${selected.length} productos combinados`);
        setCategory(categorias[0]);
        setSkuBase('');
        setDescription(
          `${selected.length} productos · ${totalVariants} variantes · ${tamanos.join(', ')}`
        );
      }
      return next;
    });
  }

  function handleClearProductos() {
    setSelectedProductos([]);
    setName('');
    setCategory('');
    setSkuBase('');
    setDescription('');
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    // Combine variants from all selected products
    const allVariantes = productos
      .filter((p) => selectedProductos.includes(p.slug))
      .flatMap((p) => p.variantes);

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          category,
          sku_base: skuBase,
          description,
          brand_id: brandId || null,
          variantes: mode === 'catalog' && allVariantes.length > 0 ? allVariantes : undefined,
        }),
      });

      if (res.ok) {
        const project = await res.json();
        router.push(`/projects/${project.id}`);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-8">
      <Link href="/" className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Dashboard
      </Link>

      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Nuevo Proyecto</CardTitle>
          <CardDescription>
            Selecciona un producto del catalogo o crea uno manual.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Mode toggle */}
          <div className="mb-6 flex gap-2">
            <Button
              type="button"
              variant={mode === 'catalog' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('catalog')}
            >
              Desde catalogo
            </Button>
            <Button
              type="button"
              variant={mode === 'manual' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('manual')}
            >
              Manual
            </Button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'catalog' && (
              <ProductCombobox
                productos={productos}
                loading={loadingProductos}
                selectedSlugs={selectedProductos}
                onToggle={handleProductoToggle}
                onClear={handleClearProductos}
              />
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Nombre del producto</Label>
              <Input
                id="name"
                name="name"
                placeholder="Ej: Sabana Lisa 1.5 Plazas"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Categoria</Label>
              <Select name="category" required value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona una categoria" />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_CATEGORIES.map((cat) => (
                    <SelectItem key={cat.key} value={cat.key}>
                      {cat.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sku_base">SKU Base (opcional)</Label>
              <Input
                id="sku_base"
                name="sku_base"
                placeholder="Ej: SAB-001"
                value={skuBase}
                onChange={(e) => setSkuBase(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Descripcion (opcional)</Label>
              <Textarea
                id="description"
                name="description"
                placeholder="Notas sobre el producto..."
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {brands.length > 0 && (
              <div className="space-y-2">
                <Label>Brand Book (opcional)</Label>
                <Select value={brandId} onValueChange={setBrandId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sin brand — imagenes sin logo ni guidelines" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin brand</SelectItem>
                    {brands.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Creando...' : 'Crear Proyecto'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
