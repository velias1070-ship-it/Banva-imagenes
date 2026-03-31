'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Palette, Plus, Trash2, Upload, Loader2, ImageIcon, Save } from 'lucide-react';
import { toast } from 'sonner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

interface Brand {
  id: string;
  name: string;
  slug: string;
  logo_storage_path: string;
  logo_position: string;
  logo_margin_px: number;
  logo_size_px: number;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  typography: string;
  prompt_guidelines: string;
  apply_logo_overlay: boolean;
  apply_to_shot_types: string[];
}

export default function BrandsPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchBrands = useCallback(async () => {
    const res = await fetch('/api/brands');
    if (res.ok) setBrands(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { fetchBrands(); }, [fetchBrands]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    const res = await fetch('/api/brands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) {
      toast.success('Brand creado');
      setNewName('');
      fetchBrands();
    } else {
      const err = await res.json();
      toast.error(err.error || 'Error creando brand');
    }
    setCreating(false);
  }

  async function handleUpdate(brand: Brand) {
    setSavingId(brand.id);
    const res = await fetch(`/api/brands/${brand.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: brand.name,
        primary_color: brand.primary_color,
        secondary_color: brand.secondary_color,
        accent_color: brand.accent_color,
        typography: brand.typography,
        prompt_guidelines: brand.prompt_guidelines,
        logo_position: brand.logo_position,
        logo_margin_px: brand.logo_margin_px,
        logo_size_px: brand.logo_size_px,
        apply_logo_overlay: brand.apply_logo_overlay,
      }),
    });
    if (res.ok) toast.success('Brand actualizado');
    else toast.error('Error actualizando');
    setSavingId(null);
  }

  async function handleUploadLogo(brandId: string) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('logo', file);
      const res = await fetch(`/api/brands/${brandId}`, { method: 'PUT', body: formData });
      if (res.ok) {
        toast.success('Logo subido');
        fetchBrands();
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast.error(`Error subiendo logo: ${err.error || res.status}`);
      }
    };
    input.click();
  }

  async function handleDelete(brandId: string) {
    if (!confirm('Eliminar este brand?')) return;
    await fetch(`/api/brands/${brandId}`, { method: 'DELETE' });
    fetchBrands();
    toast.success('Brand eliminado');
  }

  function updateBrandLocal(id: string, updates: Partial<Brand>) {
    setBrands((prev) => prev.map((b) => b.id === id ? { ...b, ...updates } : b));
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Brand Books</h1>
        <p className="text-muted-foreground">Identidad visual por marca — logo, colores, tipografia</p>
      </div>

      {/* Create new */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex gap-2">
            <Input placeholder="Nombre de la marca (ej: American Family)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
            <Button onClick={handleCreate} disabled={creating || !newName.trim()}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Crear Brand
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Brand list */}
      <div className="space-y-6">
        {brands.map((brand) => {
          const isEditing = editingId === brand.id;
          const logoUrl = brand.logo_storage_path ? `${SUPABASE_URL}/storage/v1/object/public/images/${brand.logo_storage_path}` : null;

          return (
            <Card key={brand.id} className={isEditing ? 'ring-2 ring-blue-500' : ''}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* Logo preview */}
                    <button onClick={() => handleUploadLogo(brand.id)} className="h-16 w-16 rounded-lg border-2 border-dashed flex items-center justify-center bg-gray-50 hover:bg-gray-100 transition-colors overflow-hidden" title="Subir logo (PNG transparente)">
                      {logoUrl ? (
                        <img src={logoUrl} alt={brand.name} className="h-full w-full object-contain p-1" />
                      ) : (
                        <Upload className="h-5 w-5 text-muted-foreground" />
                      )}
                    </button>
                    <div>
                      <CardTitle className="text-lg">{brand.name}</CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex gap-1">
                          <div className="h-4 w-4 rounded-full border" style={{ backgroundColor: brand.primary_color }} title="Primario" />
                          <div className="h-4 w-4 rounded-full border" style={{ backgroundColor: brand.secondary_color }} title="Secundario" />
                          <div className="h-4 w-4 rounded-full border" style={{ backgroundColor: brand.accent_color }} title="Acento" />
                        </div>
                        {brand.typography && <Badge variant="outline" className="text-[10px]">{brand.typography.substring(0, 30)}</Badge>}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditingId(isEditing ? null : brand.id)}>
                      {isEditing ? 'Cerrar' : 'Editar'}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-red-500" onClick={() => handleDelete(brand.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              {isEditing && (
                <CardContent className="border-t pt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-3">
                      <div>
                        <Label>Nombre</Label>
                        <Input value={brand.name} onChange={(e) => updateBrandLocal(brand.id, { name: e.target.value })} />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <Label className="text-xs">Color primario</Label>
                          <div className="flex gap-1">
                            <input type="color" value={brand.primary_color} onChange={(e) => updateBrandLocal(brand.id, { primary_color: e.target.value })} className="h-8 w-8 rounded cursor-pointer" />
                            <Input value={brand.primary_color} onChange={(e) => updateBrandLocal(brand.id, { primary_color: e.target.value })} className="h-8 text-xs font-mono" />
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Secundario</Label>
                          <div className="flex gap-1">
                            <input type="color" value={brand.secondary_color} onChange={(e) => updateBrandLocal(brand.id, { secondary_color: e.target.value })} className="h-8 w-8 rounded cursor-pointer" />
                            <Input value={brand.secondary_color} onChange={(e) => updateBrandLocal(brand.id, { secondary_color: e.target.value })} className="h-8 text-xs font-mono" />
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Acento</Label>
                          <div className="flex gap-1">
                            <input type="color" value={brand.accent_color} onChange={(e) => updateBrandLocal(brand.id, { accent_color: e.target.value })} className="h-8 w-8 rounded cursor-pointer" />
                            <Input value={brand.accent_color} onChange={(e) => updateBrandLocal(brand.id, { accent_color: e.target.value })} className="h-8 text-xs font-mono" />
                          </div>
                        </div>
                      </div>
                      <div>
                        <Label>Tipografia (descripcion para IA)</Label>
                        <Input value={brand.typography} onChange={(e) => updateBrandLocal(brand.id, { typography: e.target.value })} placeholder="Ej: Sans-serif bold, estilo clean y moderno" />
                      </div>
                      <div>
                        <Label>Posicion del logo</Label>
                        <Select value={brand.logo_position} onValueChange={(v) => updateBrandLocal(brand.id, { logo_position: v })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="top-left">Arriba izquierda</SelectItem>
                            <SelectItem value="top-right">Arriba derecha</SelectItem>
                            <SelectItem value="bottom-left">Abajo izquierda</SelectItem>
                            <SelectItem value="bottom-right">Abajo derecha</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">Margen (px)</Label>
                          <Input type="number" value={brand.logo_margin_px} onChange={(e) => updateBrandLocal(brand.id, { logo_margin_px: parseInt(e.target.value) || 40 })} />
                        </div>
                        <div>
                          <Label className="text-xs">Tamano logo (px)</Label>
                          <Input type="number" value={brand.logo_size_px} onChange={(e) => updateBrandLocal(brand.id, { logo_size_px: parseInt(e.target.value) || 150 })} />
                        </div>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <Label>Guidelines para el prompt de generacion</Label>
                        <Textarea value={brand.prompt_guidelines} onChange={(e) => updateBrandLocal(brand.id, { prompt_guidelines: e.target.value })} rows={6} placeholder="Instrucciones adicionales para Gemini cuando genera imagenes de esta marca. Ej: Usar tonos celeste para headers, texto negro para body, estilo premium y limpio..." />
                      </div>
                      <div>
                        <Label className="text-xs">Logo actual</Label>
                        {logoUrl ? (
                          <div className="mt-1 p-4 bg-gray-100 rounded-lg inline-block">
                            <img src={logoUrl} alt={brand.name} className="max-h-24" />
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground mt-1">Sin logo — click en el icono de arriba para subir</p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <Button onClick={() => handleUpdate(brand)} disabled={savingId === brand.id}>
                      {savingId === brand.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Guardar cambios
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}

        {brands.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <Palette className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>Sin brand books. Crea uno para empezar.</p>
          </div>
        )}
      </div>
    </div>
  );
}
