'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dropzone } from '@/components/upload/dropzone';
import { SHOT_TYPES } from '@/lib/constants';
import { ArrowLeft, Trash2 } from 'lucide-react';
import type { HeroShot } from '@/types/database';
import { toast } from 'sonner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

export default function HeroShotsPage() {
  const { id } = useParams<{ id: string }>();
  const [heroes, setHeroes] = useState<HeroShot[]>([]);
  const [uploading, setUploading] = useState(false);
  const [shotType, setShotType] = useState('lifestyle');

  const fetchHeroes = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}/heroes`);
    if (res.ok) {
      setHeroes(await res.json());
    }
  }, [id]);

  useEffect(() => {
    fetchHeroes();
  }, [fetchHeroes]);

  async function handleUpload(files: File[]) {
    setUploading(true);
    let successCount = 0;
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('shot_type', shotType);

        try {
          const res = await fetch(`/api/projects/${id}/heroes`, {
            method: 'POST',
            body: formData,
          });

          if (!res.ok) {
            let errorMsg = `HTTP ${res.status}`;
            try {
              const err = await res.json();
              errorMsg = err.error || errorMsg;
            } catch {
              // Response is not JSON (e.g., Vercel HTML error page)
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
        toast.success(`${successCount} hero shot(s) subidos`);
        fetchHeroes();
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(heroId: string) {
    const res = await fetch(`/api/projects/${id}/heroes/${heroId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setHeroes((prev) => prev.filter((h) => h.id !== heroId));
      toast.success('Hero shot eliminado');
    } else {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      toast.error(`Error eliminando: ${err.error || res.status}`);
    }
  }

  return (
    <div className="p-8">
      <Link href={`/projects/${id}`} className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Proyecto
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-bold">Hero Shots</h1>
        <p className="text-muted-foreground">Sube las imagenes base del producto</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Subir Hero Shots</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium">Tipo de toma:</span>
                <Select value={shotType} onValueChange={setShotType}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHOT_TYPES.map((type) => (
                      <SelectItem key={type.key} value={type.key}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Dropzone
                onUpload={handleUpload}
                uploading={uploading}
                label="Arrastra hero shots aqui"
                description="Imagenes base del producto (fondo blanco, lifestyle, detalle, etc.)"
                maxFiles={10}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {/* Heroes subidos manualmente */}
          <Card>
            <CardHeader>
              <CardTitle>Heroes Subidos ({heroes.filter(h => h.source !== 'ml').length})</CardTitle>
            </CardHeader>
            <CardContent>
              {heroes.filter(h => h.source !== 'ml').length === 0 ? (
                <p className="text-center text-sm text-muted-foreground py-8">
                  Sin hero shots subidos
                </p>
              ) : (
                <div className="space-y-3">
                  {heroes.filter(h => h.source !== 'ml').map((hero) => (
                    <div key={hero.id} className="flex items-center gap-3 rounded-lg border p-2">
                      <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded bg-gray-100 relative">
                        {hero.storage_path ? (
                          <img
                            src={`${SUPABASE_URL}/storage/v1/object/public/images/${hero.storage_path}`}
                            alt={hero.filename}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                              if (target.nextElementSibling) {
                                (target.nextElementSibling as HTMLElement).style.display = 'flex';
                              }
                            }}
                          />
                        ) : null}
                        <div className={`h-full items-center justify-center text-xs text-gray-400 ${hero.storage_path ? 'hidden' : 'flex'}`}>
                          {hero.shot_type}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium">{hero.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {hero.shot_type}{hero.file_size_kb ? ` · ${hero.file_size_kb}KB` : ''}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(hero.id)}
                        className="h-8 w-8 text-red-500 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Heroes de ML (Branding) — agrupados por variante/SKU */}
          {heroes.filter(h => h.source === 'ml').length > 0 && (() => {
            const mlHeroes = heroes.filter(h => h.source === 'ml');
            // Group by SKU prefix (everything before _ml_)
            const grouped: Record<string, HeroShot[]> = {};
            for (const h of mlHeroes) {
              const match = h.filename.match(/^(.+?)_ml_/);
              const sku = match ? match[1] : 'Otros';
              if (!grouped[sku]) grouped[sku] = [];
              grouped[sku].push(h);
            }

            return Object.entries(grouped).map(([sku, skuHeroes]) => (
              <Card key={sku}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{sku}</CardTitle>
                      <p className="text-xs text-muted-foreground">{skuHeroes.length} fotos de ML</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-4 gap-2">
                    {skuHeroes.map((hero) => (
                      <div key={hero.id} className="group relative">
                        <div className="aspect-square overflow-hidden rounded bg-gray-100">
                          {hero.storage_path ? (
                            <img
                              src={`${SUPABASE_URL}/storage/v1/object/public/images/${hero.storage_path}`}
                              alt={hero.filename}
                              className="h-full w-full object-cover"
                              loading="lazy"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.style.display = 'none';
                                if (target.nextElementSibling) {
                                  (target.nextElementSibling as HTMLElement).style.display = 'flex';
                                }
                              }}
                            />
                          ) : null}
                          <div className={`h-full items-center justify-center text-xs text-gray-400 ${hero.storage_path ? 'hidden' : 'flex'}`}>
                            {hero.shot_type}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(hero.id)}
                          className="absolute -right-1 -top-1 h-6 w-6 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-700"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                        <p className="mt-1 truncate text-[10px] text-muted-foreground">{hero.shot_type}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ));
          })()}
        </div>
      </div>
    </div>
  );
}
