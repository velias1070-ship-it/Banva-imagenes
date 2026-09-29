'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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

interface Variante {
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
  status_ml?: string | null;
}

interface ProductGroup {
  base_name: string;
  slug: string;
  tamano: string;
  // '' = no se pudo deducir: el formulario obliga a elegirla.
  categoria: string;
  family_name?: string | null;
  variantes: Variante[];
}

interface ProyectoRef {
  id: string;
  name: string;
}

// SKU (MAYÚSCULAS) → proyectos que lo tienen (/api/projects/indice-skus).
type IndiceSkus = Record<string, ProyectoRef[]>;

// Un proyecto por familia de ML: si alguna variante del grupo ya está en un
// proyecto, las nuevas se agregan desde ese proyecto en vez de crear otro.
function proyectosDelGrupo(p: ProductGroup, indice: IndiceSkus): ProyectoRef[] {
  const porId = new Map<string, ProyectoRef>();
  for (const v of p.variantes) {
    for (const ref of indice[v.sku.toUpperCase()] ?? []) porId.set(ref.id, ref);
  }
  return [...porId.values()];
}

function resumenGrupo(p: ProductGroup): string {
  const n = p.variantes.length;
  const pausadas = p.variantes.filter((v) => v.status_ml === 'paused').length;
  const cantidad = n === 1 ? 'Producto suelto · 1 variante' : `${n} variantes`;
  const nota = pausadas === 0 ? '' : n === 1 ? ' (pausada)' : ` (${pausadas} pausada${pausadas === 1 ? '' : 's'})`;
  return `${cantidad}${nota} · ${p.categoria || 'sin categoría'}`;
}

// El query "parece un SKU" cuando no tiene espacios, mide >= 6 y es
// alfanumerico/mayusculas. Solo en ese caso hacemos el fetch on-demand a la API.
function looksLikeSku(q: string): boolean {
  return q.length >= 6 && !/\s/.test(q) && /^[A-Za-z0-9]+$/.test(q);
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
  onAddGroups,
  onPickVariant,
  indice,
}: {
  productos: ProductGroup[];
  loading: boolean;
  selectedSlugs: string[];
  onToggle: (slug: string) => void;
  onClear: () => void;
  onAddGroups: (groups: ProductGroup[]) => void;
  onPickVariant: (group: ProductGroup, variante: Variante) => void;
  /** null = todavía no se sabe qué familias ya tienen proyecto: no se elige. */
  indice: IndiceSkus | null;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [skuLoading, setSkuLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Evita refetch del mismo query (incluso si no devolvio nada).
  const attemptedRef = useRef<Set<string>>(new Set());

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

  // Escape single-variant: cuando el filtro local no encuentra nada y el query
  // parece un SKU, buscamos ese SKU on-demand en la API. Los grupos devueltos se
  // suman a `productos` (via onAddGroups), por lo que `filtered` los recalcula y
  // aparecen como opciones seleccionables con el mismo render que el resto.
  useEffect(() => {
    const q = query.trim();
    if (!open || filtered.length > 0 || !looksLikeSku(q) || attemptedRef.current.has(q.toLowerCase())) {
      return;
    }
    const handle = setTimeout(() => {
      attemptedRef.current.add(q.toLowerCase());
      setSkuLoading(true);
      fetch(`/api/productos?sku=${encodeURIComponent(q)}`)
        .then((res) => res.json())
        .then((data) => {
          const groups: ProductGroup[] = Array.isArray(data)
            ? (data as ProductGroup[])
            : data && Array.isArray((data as ProductGroup).variantes)
            ? [data as ProductGroup]
            : [];
          if (groups.length > 0) onAddGroups(groups);
        })
        .catch(() => {})
        .finally(() => setSkuLoading(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [query, open, filtered.length, onAddGroups]);

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
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {skuLoading ? 'Buscando SKU...' : 'Sin resultados'}
              </div>
            ) : (
              filtered.map((p) => {
                const isSelected = selectedSet.has(p.slug);
                const proyectos = indice ? proyectosDelGrupo(p, indice) : [];
                if (proyectos.length > 0 && !isSelected) {
                  return (
                    <div key={p.slug} className="px-3 py-2 pl-9 text-sm">
                      <div className="font-medium text-muted-foreground">
                        {p.base_name}
                        {p.tamano ? ` — ${p.tamano}` : ''}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Ya tiene proyecto:{' '}
                        <Link href={`/projects/${proyectos[0].id}/swatches`} className="text-blue-600 hover:underline">
                          {proyectos[0].name}
                        </Link>
                        {proyectos.length > 1 && ` (y ${proyectos.length - 1} más)`}. Agrega las variantes nuevas desde ahí.
                      </div>
                    </div>
                  );
                }
                // Buscando un SKU o color dentro de una familia: además de la
                // familia completa, se ofrece ese SKU solo.
                const q = query.trim().toLowerCase();
                const sueltas =
                  q && p.variantes.length > 1
                    ? p.variantes
                        .filter((v) => v.sku.toLowerCase().includes(q) || (v.label || v.color).toLowerCase().includes(q))
                        .slice(0, 3)
                    : [];
                return (
                  <div key={p.slug}>
                    <button
                      type="button"
                      onClick={() => onToggle(p.slug)}
                      disabled={!indice && !isSelected}
                      className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-wait disabled:opacity-60 ${isSelected ? 'bg-accent' : ''}`}
                    >
                      <div className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border ${isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground'}`}>
                        {isSelected && <span className="block text-center text-xs leading-3">✓</span>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {p.base_name}
                          {p.tamano ? ` — ${p.tamano}` : ''}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {indice ? resumenGrupo(p) : 'Revisando si ya tiene proyecto…'}
                        </div>
                      </div>
                    </button>
                    {sueltas.map((v) => (
                      <button
                        key={v.sku}
                        type="button"
                        disabled={!indice}
                        onClick={() => onPickVariant(p, v)}
                        className="block w-full py-1 pl-9 pr-3 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        Solo {v.label || v.color} ({v.sku}){v.status_ml === 'paused' ? ' · pausada' : ''}
                      </button>
                    ))}
                  </div>
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
                <div className="text-xs font-medium">
                  {p.base_name}
                  {p.tamano ? ` — ${p.tamano}` : ''}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.variantes.map((v) => (
                    <span key={v.sku} className="rounded bg-background px-1.5 py-0.5 text-[10px]">
                      {v.label || v.color} <span className="text-muted-foreground">({v.sku})</span>
                      {v.status_ml === 'paused' && <span className="text-amber-600"> · pausada</span>}
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
  const [indice, setIndice] = useState<IndiceSkus | null>(null);
  const [errorIndice, setErrorIndice] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/projects/indice-skus')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setIndice(data);
      })
      .catch((err) => {
        // Sin índice no se bloquea nada: se avisa y se puede crear igual.
        setErrorIndice(err instanceof Error ? err.message : 'Error');
        setIndice({});
      });
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
    const next = selectedProductos.includes(slug)
      ? selectedProductos.filter((s) => s !== slug)
      : [...selectedProductos, slug];
    setSelectedProductos(next);
    autocompletar(productos.filter((p) => next.includes(p.slug)));
  }

  // Un solo SKU de una familia: se arma su propio grupo y se selecciona.
  function handleSoloVariante(p: ProductGroup, v: Variante) {
    const grupo: ProductGroup = {
      ...p,
      base_name: `${p.base_name} ${v.label || v.color}`.trim(),
      slug: `${p.slug}--${v.sku.toLowerCase()}`,
      variantes: [v],
    };
    const lista = productos.some((x) => x.slug === grupo.slug) ? productos : [...productos, grupo];
    if (lista !== productos) setProductos(lista);
    const next = selectedProductos.includes(grupo.slug) ? selectedProductos : [...selectedProductos, grupo.slug];
    setSelectedProductos(next);
    autocompletar(lista.filter((x) => next.includes(x.slug)));
  }

  // Auto-fill form fields based on the selection
  function autocompletar(selected: ProductGroup[]) {
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
      setDescription(`${prod.tamano ? `${prod.tamano} — ` : ''}${prod.variantes.length} variantes: ${varList}`);
    } else {
      // Multiple products combined — derive a generic name
      const totalVariants = selected.reduce((sum, p) => sum + p.variantes.length, 0);
      const categorias = [...new Set(selected.map((p) => p.categoria).filter(Boolean))];
      const tamanos = [...new Set(selected.map((p) => p.tamano).filter(Boolean))];
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
      setCategory(categorias[0] ?? '');
      setSkuBase('');
      setDescription(
        `${selected.length} productos · ${totalVariants} variantes${tamanos.length ? ` · ${tamanos.join(', ')}` : ''}`
      );
    }
  }

  // Suma grupos traidos por SKU a la lista que ya maneja el estado, dedup por
  // slug, para que el toggle/autocompletado existente los encuentre.
  const handleAddGroups = useCallback((groups: ProductGroup[]) => {
    setProductos((prev) => {
      const existing = new Set(prev.map((p) => p.slug));
      const fresh = groups.filter((g) => g.slug && !existing.has(g.slug));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);

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

    // Combine variants from all selected products (un SKU elegido solo y
    // también dentro de su familia va una vez)
    const allVariantes = productos
      .filter((p) => selectedProductos.includes(p.slug))
      .flatMap((p) => p.variantes)
      .filter((v, i, arr) => arr.findIndex((x) => x.sku === v.sku) === i);

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
                onAddGroups={handleAddGroups}
                onPickVariant={handleSoloVariante}
                indice={indice}
              />
            )}
            {mode === 'catalog' && errorIndice && (
              <p className="text-xs text-destructive">
                No pude revisar qué productos ya tienen proyecto ({errorIndice}): fíjate antes de crear uno repetido.
              </p>
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
