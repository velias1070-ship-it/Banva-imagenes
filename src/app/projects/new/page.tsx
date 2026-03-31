'use client';

import { useState, useEffect } from 'react';
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
  variantes: {
    sku: string;
    color: string;
    color_slug: string;
  }[];
}

export default function NewProjectPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'catalog' | 'manual'>('catalog');
  const [productos, setProductos] = useState<ProductGroup[]>([]);
  const [loadingProductos, setLoadingProductos] = useState(true);
  const [selectedProducto, setSelectedProducto] = useState<string>('');

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

  function handleProductoSelect(slug: string) {
    setSelectedProducto(slug);
    const prod = productos.find((p) => p.slug === slug);
    if (prod) {
      setName(prod.base_name);
      setCategory(prod.categoria);
      setSkuBase(prod.slug);
      const varList = prod.variantes.map((v) => `${v.sku} (${v.color})`).join(', ');
      setDescription(`${prod.tamano} — ${prod.variantes.length} variantes: ${varList}`);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    const prod = productos.find((p) => p.slug === selectedProducto);

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
          variantes: mode === 'catalog' && prod ? prod.variantes : undefined,
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
              <div className="space-y-2">
                <Label>Producto del catalogo</Label>
                <Select
                  value={selectedProducto}
                  onValueChange={handleProductoSelect}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={loadingProductos ? 'Cargando...' : 'Selecciona un producto'} />
                  </SelectTrigger>
                  <SelectContent>
                    {productos.map((p) => (
                      <SelectItem key={p.slug} value={p.slug}>
                        {p.base_name} — {p.tamano} ({p.variantes.length} vars)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedProducto && (
                  <div className="mt-2 rounded-md bg-muted p-3 text-sm">
                    {productos.find((p) => p.slug === selectedProducto)?.variantes.map((v) => (
                      <span key={v.sku} className="mr-2 inline-block rounded bg-background px-2 py-0.5 text-xs">
                        {v.color} <span className="text-muted-foreground">({v.sku})</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
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
