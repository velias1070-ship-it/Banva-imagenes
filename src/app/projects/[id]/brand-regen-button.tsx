'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Sparkles, Loader2 } from 'lucide-react';

interface Props {
  projectId: string;
  brandName: string | null;
  hasBrand: boolean;
  swatchCount: number;
}

export function BrandRegenButton({ projectId, brandName, hasBrand, swatchCount }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleBrandRegen() {
    if (!hasBrand) {
      setResult({ ok: false, message: 'Asigna un Brand Book en Configuracion primero.' });
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/brand-regen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await res.json();

      if (!res.ok) {
        setResult({ ok: false, message: data.error || 'Error al iniciar regeneracion' });
        return;
      }

      setResult({
        ok: true,
        message: `Batch creado: ${data.total_jobs} imagenes con brand "${data.brand}". ${data.errors?.length ? `(${data.errors.length} errores)` : ''}`,
      });

      // Navigate to generate page to see progress
      setTimeout(() => router.push(`/projects/${projectId}/generate`), 2000);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Error de red' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3">
        <Sparkles className="h-8 w-8 text-pink-500" />
        <div className="flex-1">
          <CardTitle className="text-base">Regenerar con Brand</CardTitle>
          <CardDescription>
            Descarga las imagenes actuales de ML y las regenera con el Brand Book aplicado
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <div className="flex-1 text-sm text-muted-foreground">
            {hasBrand
              ? `Brand: ${brandName} · ${swatchCount} variantes`
              : 'Sin Brand Book asignado'}
          </div>
          <Button
            onClick={handleBrandRegen}
            disabled={loading || !hasBrand}
            variant={hasBrand ? 'default' : 'outline'}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Procesando...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Regenerar con Brand
              </>
            )}
          </Button>
        </div>
        {result && (
          <div className={`mt-3 rounded-md px-3 py-2 text-sm ${result.ok ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
            {result.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
