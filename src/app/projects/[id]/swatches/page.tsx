'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dropzone } from '@/components/upload/dropzone';
import { ArrowLeft, Trash2, Download, RefreshCw, Loader2, ImagePlus, Plus, X } from 'lucide-react';
import type { Swatch } from '@/types/database';
import { toast } from 'sonner';

export default function SwatchesPage() {
  const { id } = useParams<{ id: string }>();
  const [swatches, setSwatches] = useState<Swatch[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fetchingML, setFetchingML] = useState(false);
  const [imgVersion, setImgVersion] = useState(0);
  const [skuInput, setSkuInput] = useState('');
  const [addingSku, setAddingSku] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlName, setUrlName] = useState('');
  const [addingUrl, setAddingUrl] = useState(false);
  const [expandedSwatch, setExpandedSwatch] = useState<string | null>(null);
  const [swatchExtraImages, setSwatchExtraImages] = useState<Record<string, { id: string; storage_path: string; label: string }[]>>({});

  const fetchSwatches = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}/swatches`);
    if (res.ok) {
      setSwatches(await res.json());
    }
  }, [id]);

  useEffect(() => {
    fetchSwatches();
  }, [fetchSwatches]);

  async function handleUpload(files: File[]) {
    setUploading(true);
    let successCount = 0;
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        // Use filename without extension as swatch name
        const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        formData.append('name', name);

        try {
          const res = await fetch(`/api/projects/${id}/swatches`, {
            method: 'POST',
            body: formData,
          });

          if (!res.ok) {
            let errorMsg = `HTTP ${res.status}`;
            try {
              const err = await res.json();
              errorMsg = err.error || errorMsg;
            } catch {
              if (res.status === 413) {
                errorMsg = 'Archivo muy grande para el servidor';
              }
            }
            toast.error(`Error subiendo ${file.name}: ${errorMsg}`);
          } else {
            successCount++;
          }
        } catch (networkErr) {
          toast.error(`Error de red subiendo ${file.name}`);
        }
      }
      if (successCount > 0) {
        toast.success(`${successCount} swatch(es) subidos`);
        fetchSwatches();
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(swatchId: string) {
    const res = await fetch(`/api/projects/${id}/swatches/${swatchId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setSwatches((prev) => prev.filter((s) => s.id !== swatchId));
      toast.success('Swatch eliminado');
    }
  }

  async function handleFetchFromML(force: boolean = false) {
    setFetchingML(true);
    try {
      const res = await fetch(`/api/projects/${id}/fetch-ml-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force, sync_new: true }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.success > 0) {
          toast.success(`${data.success} swatches ${force ? 'actualizados' : 'traidos'} desde MercadoLibre`);
          setImgVersion((v) => v + 1);
          fetchSwatches();
        } else if (data.skipped > 0 && data.success === 0) {
          toast.info('Todos los swatches ya tienen imagen. Usa "Actualizar" para re-descargar.');
        }
        if (data.errors > 0) {
          toast.error(`${data.errors} errores al traer imagenes`);
        }
      } else {
        toast.error(data.error || 'Error trayendo imagenes de ML');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setFetchingML(false);
    }
  }

  async function handleAddFromSku() {
    const sku = skuInput.trim();
    if (!sku) return;
    setAddingSku(true);
    try {
      const res = await fetch(`/api/projects/${id}/swatches/from-sku`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Swatch "${data.swatch.name}" creado desde ML (${data.ml_title})`);
        setSkuInput('');
        fetchSwatches();
      } else {
        toast.error(data.error || 'Error agregando SKU');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setAddingSku(false);
    }
  }

  async function handleAddFromUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setAddingUrl(true);
    try {
      const res = await fetch(`/api/projects/${id}/swatches/from-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name: urlName.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Swatch "${data.swatch.name}" creado desde URL`);
        setUrlInput('');
        setUrlName('');
        fetchSwatches();
      } else {
        toast.error(data.error || 'Error descargando imagen');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setAddingUrl(false);
    }
  }

  async function handleReplaceImage(swatchId: string) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch(`/api/projects/${id}/swatches/${swatchId}/image`, {
          method: 'PUT',
          body: formData,
        });
        if (res.ok) {
          toast.success('Imagen del swatch actualizada');
          setImgVersion((v) => v + 1);
          fetchSwatches();
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || 'Error subiendo imagen');
        }
      } catch {
        toast.error('Error de conexion');
      }
    };
    input.click();
  }

  async function fetchExtraImages(swatchId: string) {
    const res = await fetch(`/api/projects/${id}/swatches/${swatchId}/images`);
    if (res.ok) {
      const images = await res.json();
      setSwatchExtraImages((prev) => ({ ...prev, [swatchId]: images }));
    }
  }

  async function handleAddExtraImage(swatchId: string) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = input.files;
      if (!files?.length) return;
      let successCount = 0;
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch(`/api/projects/${id}/swatches/${swatchId}/images`, {
            method: 'POST',
            body: formData,
          });
          if (res.ok) {
            successCount++;
          } else {
            const err = await res.json().catch(() => ({}));
            toast.error(`Error subiendo ${file.name}: ${err.error || res.status}`);
          }
        } catch {
          toast.error(`Error de conexion subiendo ${file.name}`);
        }
      }
      if (successCount > 0) {
        toast.success(`${successCount} imagen(es) de referencia agregadas`);
      }
      fetchExtraImages(swatchId);
    };
    input.click();
  }

  async function handleDeleteExtraImage(swatchId: string, imageId: string) {
    await fetch(`/api/projects/${id}/swatches/${swatchId}/images?imageId=${imageId}`, {
      method: 'DELETE',
    });
    fetchExtraImages(swatchId);
  }

  function toggleExpand(swatchId: string) {
    if (expandedSwatch === swatchId) {
      setExpandedSwatch(null);
    } else {
      setExpandedSwatch(swatchId);
      if (!swatchExtraImages[swatchId]) {
        fetchExtraImages(swatchId);
      }
    }
  }

  async function handleUpdateSwatch(swatchId: string, updates: Partial<Swatch>) {
    const res = await fetch(`/api/projects/${id}/swatches/${swatchId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      setSwatches((prev) =>
        prev.map((s) => (s.id === swatchId ? { ...s, ...updates } : s))
      );
      if (updates.sku_suffix !== undefined) {
        toast.success(`SKU actualizado: ${updates.sku_suffix || '(vacío)'}`);
      }
    }
  }

  return (
    <div className="p-8">
      <Link href={`/projects/${id}`} className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Proyecto
      </Link>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Swatches</h1>
          <p className="text-muted-foreground">Sube las variantes de color/diseno del producto</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => handleFetchFromML(false)}
            disabled={fetchingML}
          >
            {fetchingML ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Traer fotos de ML
          </Button>
          {swatches.some((s) => s.storage_path) && (
            <Button
              variant="outline"
              onClick={() => handleFetchFromML(true)}
              disabled={fetchingML}
              title="Re-descarga todas las fotos desde ML (actualiza si cambiaron)"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Actualizar todas
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Agregar desde SKU</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  placeholder="SKU de MercadoLibre (ej: TXV23QLAT25BE)"
                  value={skuInput}
                  onChange={(e) => setSkuInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddFromSku()}
                  className="font-mono"
                  disabled={addingSku}
                />
                <Button onClick={handleAddFromSku} disabled={addingSku || !skuInput.trim()}>
                  {addingSku ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {addingSku ? 'Buscando...' : 'Agregar'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Busca el SKU en ML, descarga la foto y crea el swatch automaticamente
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Agregar desde URL</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Input
                  placeholder="URL de imagen (ej: https://cannonhome.cl/media/...jpg)"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  disabled={addingUrl}
                />
                <div className="flex gap-2">
                  <Input
                    placeholder="Nombre del swatch (opcional)"
                    value={urlName}
                    onChange={(e) => setUrlName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddFromUrl()}
                    disabled={addingUrl}
                  />
                  <Button onClick={handleAddFromUrl} disabled={addingUrl || !urlInput.trim()}>
                    {addingUrl ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {addingUrl ? 'Descargando...' : 'Agregar'}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Descarga la imagen desde cualquier URL y crea el swatch
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Subir Swatches</CardTitle>
            </CardHeader>
            <CardContent>
              <Dropzone
                onUpload={handleUpload}
                uploading={uploading}
                label="Arrastra swatches aqui"
                description="Imagenes de variantes de color o diseno (muestras de tela, patrones, etc.)"
                maxFiles={30}
              />
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Swatches Subidos ({swatches.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {swatches.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground py-8">
                  Sin swatches aun
                </p>
              ) : (
                <div className="space-y-3">
                  {swatches.map((swatch) => (
                    <div key={swatch.id} className="rounded-lg border p-2">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => handleReplaceImage(swatch.id)}
                        className="h-16 w-16 flex-shrink-0 overflow-hidden rounded bg-gray-100 relative group cursor-pointer"
                        title="Cambiar imagen"
                      >
                        {swatch.storage_path ? (
                          <img
                            src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/images/${swatch.storage_path}?v=${imgVersion}`}
                            alt={swatch.name}
                            className="h-full w-full object-cover"
                          />
                        ) : swatch.dominant_color_hex ? (
                          <div
                            className="h-full w-full"
                            style={{ backgroundColor: swatch.dominant_color_hex }}
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-gray-400">
                            sin foto
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <ImagePlus className="h-5 w-5 text-white" />
                        </div>
                      </button>
                      <div className="flex-1 min-w-0">
                        <Input
                          defaultValue={swatch.name}
                          onBlur={(e) => {
                            if (e.target.value !== swatch.name) {
                              handleUpdateSwatch(swatch.id, { name: e.target.value });
                            }
                          }}
                          className="h-7 text-sm font-medium border-none px-1 hover:bg-gray-50 focus:bg-white"
                        />
                        <Input
                          defaultValue={swatch.sku_suffix || ''}
                          placeholder="SKU (ej: TXV23QLAT25BE)"
                          onBlur={(e) => {
                            const val = e.target.value.trim();
                            if (val !== (swatch.sku_suffix || '')) {
                              handleUpdateSwatch(swatch.id, { sku_suffix: val || null });
                            }
                          }}
                          className="h-6 text-xs font-mono border-none px-1 text-muted-foreground hover:bg-gray-50 focus:bg-white"
                        />
                        <p className="px-1 text-xs text-muted-foreground">
                          {swatch.file_size_kb}KB
                        </p>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleExpand(swatch.id)}
                          className="h-7 w-7 text-blue-500 hover:text-blue-700"
                          title="Imagenes de referencia"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(swatch.id)}
                          className="h-7 w-7 text-red-500 hover:text-red-700"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    {/* Extra reference images panel — inside swatch container */}
                    {expandedSwatch === swatch.id && (
                      <div className="mt-2 pt-2 border-t">
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-xs font-medium text-muted-foreground">Imagenes de referencia</p>
                          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleAddExtraImage(swatch.id)}>
                            <ImagePlus className="h-3 w-3 mr-1" /> Agregar
                          </Button>
                        </div>
                        <div className="flex gap-1.5 flex-wrap">
                          {(swatchExtraImages[swatch.id] || []).map((img) => (
                            <div key={img.id} className="relative h-12 w-12 rounded overflow-hidden bg-gray-100 group">
                              <img
                                src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/images/${img.storage_path}`}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                              <button
                                onClick={() => handleDeleteExtraImage(swatch.id, img.id)}
                                className="absolute top-0 right-0 bg-red-500 text-white rounded-bl p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </div>
                          ))}
                          {(swatchExtraImages[swatch.id] || []).length === 0 && (
                            <p className="text-[10px] text-muted-foreground py-1">Sin imagenes extra — agrega close-ups, texturas o detalles del producto</p>
                          )}
                        </div>
                      </div>
                    )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
