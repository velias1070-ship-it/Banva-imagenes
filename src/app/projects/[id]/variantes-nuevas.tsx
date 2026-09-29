'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { VariantesNuevas as Datos } from '@/lib/proyectos-familia';

interface IProps {
  projectId: string;
  /** Después de agregar y bajar las fotos, para refrescar la pantalla. */
  onAgregadas: () => void;
}

const MAX_OTROS = 5;

// Variantes de la familia de ML del proyecto que todavía no están en ningún
// proyecto (los diseños nuevos), para sumarlas sin armar un proyecto nuevo.
export function VariantesNuevas({ projectId, onAgregadas }: IProps) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [agregando, setAgregando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/missing-variants`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const d = data as Datos;
      setDatos(d);
      setError(null);
      setMarcadas(new Set(d.nuevas.map((v) => v.sku)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }, [projectId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  function alternar(sku: string) {
    setMarcadas((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  async function agregar() {
    setAgregando(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/missing-variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: [...marcadas] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Error agregando variantes');
        return;
      }
      toast.success(`${data.agregadas} variantes agregadas. Bajando sus fotos de ML…`);
      if (data.no_agregadas?.length) {
        toast.info(`${data.no_agregadas.length} no se agregaron: ya están en otro proyecto o ya no están publicadas`);
      }

      const fotos = await fetch(`/api/projects/${projectId}/fetch-ml-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false, sync_new: true }),
      });
      const f = await fotos.json().catch(() => ({}));
      if (!fotos.ok) toast.error(`No se bajaron las fotos (${f.error || fotos.status}): usa «Traer fotos de ML»`);
      else if (f.errors > 0) toast.error(`${f.errors} fotos no se pudieron bajar`);

      onAgregadas();
      await cargar();
    } catch {
      toast.error('Error de conexion');
    } finally {
      setAgregando(false);
    }
  }

  if (error) {
    return <p className="text-xs text-destructive">No pude revisar las variantes nuevas de la familia: {error}</p>;
  }
  if (!datos) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Buscando variantes nuevas de la familia…
      </p>
    );
  }

  const otros = datos.en_otros_proyectos;
  const notaOtros = otros.length > 0 && (
    <p className="text-xs text-muted-foreground">
      Otras variantes de esta familia ya están en:{' '}
      {otros.slice(0, MAX_OTROS).map((p, i) => (
        <span key={p.id}>
          {i > 0 && ', '}
          <Link href={`/projects/${p.id}/swatches`} className="underline hover:text-foreground">
            {p.name}
          </Link>{' '}
          ({p.variantes})
        </span>
      ))}
      {otros.length > MAX_OTROS && ` y ${otros.length - MAX_OTROS} más`}
    </p>
  );

  if (datos.nuevas.length === 0) return notaOtros || null;

  return (
    <Card className="border-amber-300 bg-amber-50/50">
      <CardHeader>
        <CardTitle>Variantes nuevas de la familia ({datos.nuevas.length})</CardTitle>
        <p className="text-xs text-muted-foreground">{datos.familias.join(' · ')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {datos.nuevas.map((v) => (
            <label key={v.sku} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={marcadas.has(v.sku)} onCheckedChange={() => alternar(v.sku)} />
              <span className="min-w-0 flex-1 truncate">{v.label || v.color}</span>
              {v.status_ml === 'paused' && <span className="text-xs text-amber-600">pausada</span>}
              <span className="font-mono text-xs text-muted-foreground">{v.sku}</span>
            </label>
          ))}
        </div>
        <Button size="sm" onClick={agregar} disabled={agregando || marcadas.size === 0}>
          {agregando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          Agregar {marcadas.size}
        </Button>
        {notaOtros}
      </CardContent>
    </Card>
  );
}
