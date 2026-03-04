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
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('shot_type', shotType);

        const res = await fetch(`/api/projects/${id}/heroes`, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json();
          toast.error(`Error subiendo ${file.name}: ${err.error}`);
        }
      }
      toast.success(`${files.length} hero shot(s) subidos`);
      fetchHeroes();
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

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Heroes Subidos ({heroes.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {heroes.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground py-8">
                  Sin hero shots aun
                </p>
              ) : (
                <div className="space-y-3">
                  {heroes.map((hero) => (
                    <div key={hero.id} className="flex items-center gap-3 rounded-lg border p-2">
                      <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded bg-gray-100">
                        <div className="flex h-full items-center justify-center text-xs text-gray-400">
                          {hero.shot_type}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium">{hero.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {hero.shot_type} &middot; {hero.file_size_kb}KB
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
        </div>
      </div>
    </div>
  );
}
