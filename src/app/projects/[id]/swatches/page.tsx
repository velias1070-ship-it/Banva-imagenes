'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dropzone } from '@/components/upload/dropzone';
import { ArrowLeft, Trash2 } from 'lucide-react';
import type { Swatch } from '@/types/database';
import { toast } from 'sonner';

export default function SwatchesPage() {
  const { id } = useParams<{ id: string }>();
  const [swatches, setSwatches] = useState<Swatch[]>([]);
  const [uploading, setUploading] = useState(false);

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
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        // Use filename without extension as swatch name
        const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        formData.append('name', name);

        const res = await fetch(`/api/projects/${id}/swatches`, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json();
          toast.error(`Error subiendo ${file.name}: ${err.error}`);
        }
      }
      toast.success(`${files.length} swatch(es) subidos`);
      fetchSwatches();
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

  async function handleRename(swatchId: string, newName: string) {
    const res = await fetch(`/api/projects/${id}/swatches/${swatchId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (res.ok) {
      setSwatches((prev) =>
        prev.map((s) => (s.id === swatchId ? { ...s, name: newName } : s))
      );
    }
  }

  return (
    <div className="p-8">
      <Link href={`/projects/${id}`} className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Proyecto
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-bold">Swatches</h1>
        <p className="text-muted-foreground">Sube las variantes de color/diseno del producto</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
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
                    <div key={swatch.id} className="flex items-center gap-3 rounded-lg border p-2">
                      <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded bg-gray-100">
                        {swatch.dominant_color_hex ? (
                          <div
                            className="h-full w-full"
                            style={{ backgroundColor: swatch.dominant_color_hex }}
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-gray-400">
                            swatch
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <Input
                          defaultValue={swatch.name}
                          onBlur={(e) => {
                            if (e.target.value !== swatch.name) {
                              handleRename(swatch.id, e.target.value);
                            }
                          }}
                          className="h-7 text-sm font-medium border-none px-1 hover:bg-gray-50 focus:bg-white"
                        />
                        <p className="px-1 text-xs text-muted-foreground">
                          {swatch.file_size_kb}KB
                          {swatch.sku_suffix && ` · ${swatch.sku_suffix}`}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(swatch.id)}
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
        </div>
      </div>
    </div>
  );
}
