'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { sinTildes, type ProductGroup } from '@/lib/familias-ml';
import type { ProyectoRef, VariantesNuevas as Datos } from '@/lib/proyectos-familia';

interface IProps {
  projectId: string;
  /** Después de agregar y bajar las fotos, para refrescar la pantalla. */
  onAgregadas: () => void;
  /**
   * Con buscador (página de variantes): el cuadro se ve siempre y permite elegir
   * cualquier publicación de la lista. Sin buscador (Generar): sólo aparece si
   * hay variantes nuevas de la familia.
   */
  conBuscador?: boolean;
}

interface Opcion {
  sku: string;
  label: string;
  familia: string;
  status_ml?: string | null;
  texto: string;
}

const MAX_OTROS = 5;
const MAX_RESULTADOS = 30;

// Agregar variantes al proyecto eligiéndolas de una lista: las de su familia de
// ML que no están en ningún proyecto (marcadas de entrada) y, con el buscador,
// cualquier otra publicación de ML (p.ej. el mismo quilt que ML separa por
// tamaño en otra familia).
export function VariantesNuevas({ projectId, onAgregadas, conBuscador = false }: IProps) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [agregando, setAgregando] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [opciones, setOpciones] = useState<Opcion[] | null>(null);
  const [indice, setIndice] = useState<Record<string, ProyectoRef[]>>({});
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [cargandoLista, setCargandoLista] = useState(false);
  // Descarta una carga de la lista que termina después de agregar (índice viejo).
  const generacionLista = useRef(0);

  // marcarNuevas: sólo al abrir. Después de agregar, las nuevas que aparezcan
  // (p.ej. las de la familia de una publicación buscada) no se marcan solas.
  const cargar = useCallback(
    async (marcarNuevas: boolean) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/missing-variants`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const d = data as Datos;
        setDatos(d);
        setError(null);
        if (marcarNuevas) setMarcadas(new Set(d.nuevas.map((v) => v.sku)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error');
      }
    },
    [projectId],
  );

  useEffect(() => {
    cargar(true);
  }, [cargar]);

  // La lista completa (y a qué proyecto va cada SKU) se lee recién al buscar.
  async function cargarLista() {
    const generacion = ++generacionLista.current;
    setCargandoLista(true);
    try {
      const [rProd, rIdx] = await Promise.all([fetch('/api/productos'), fetch('/api/projects/indice-skus')]);
      const [prod, idx] = await Promise.all([rProd.json().catch(() => ({})), rIdx.json().catch(() => ({}))]);
      if (!rProd.ok || !Array.isArray(prod)) throw new Error(prod.error || `productos HTTP ${rProd.status}`);
      if (!rIdx.ok) throw new Error(idx.error || `índice HTTP ${rIdx.status}`);
      if (generacion !== generacionLista.current) return;
      // Sin distinguir mayúsculas, como el servidor.
      const vistas = new Set<string>();
      const lista: Opcion[] = [];
      for (const g of prod as ProductGroup[]) {
        for (const v of g.variantes) {
          if (vistas.has(v.sku.toUpperCase())) continue;
          vistas.add(v.sku.toUpperCase());
          const label = v.label || v.color;
          lista.push({ sku: v.sku, label, familia: g.base_name, status_ml: v.status_ml, texto: sinTildes(`${g.base_name} ${label} ${v.sku}`) });
        }
      }
      setIndice(idx);
      setOpciones(lista);
      setErrorLista(null);
    } catch (err) {
      if (generacion === generacionLista.current) setErrorLista(err instanceof Error ? err.message : 'Error');
    } finally {
      if (generacion === generacionLista.current) setCargandoLista(false);
    }
  }

  function buscar(q: string) {
    setBusqueda(q);
    if (q.trim() && !opciones && !cargandoLista) cargarLista();
  }

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
      // Todo lo marcado se mandó: quedó agregado o rechazado. La lista y el índice
      // se vuelven a leer en la próxima búsqueda.
      setMarcadas(new Set());
      setBusqueda('');
      setOpciones(null);
      generacionLista.current++;
      setCargandoLista(false);
      if (data.no_agregadas?.length) {
        toast.info(`${data.no_agregadas.length} no se agregaron: ya están en un proyecto o ya no están publicadas`);
      }
      if (!data.agregadas) return;
      toast.success(`${data.agregadas} variantes agregadas. Bajando sus fotos de ML…`);

      // sync_new: false — los swatches ya existen; con true también revivía los
      // que el usuario borró y siguen en metadata.variantes.
      const fotos = await fetch(`/api/projects/${projectId}/fetch-ml-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false, sync_new: false }),
      });
      const f = await fotos.json().catch(() => ({}));
      if (!fotos.ok) toast.error(`No se bajaron las fotos (${f.error || fotos.status}): usa «Traer fotos de ML» en Variantes`);
      else if (f.errors > 0) toast.error(`${f.errors} fotos no se pudieron bajar`);

      onAgregadas();
    } catch {
      toast.error('Error de conexion');
    } finally {
      await cargar(false);
      setAgregando(false);
    }
  }

  const errorFamilia = error && (
    <p className="text-xs text-destructive">No pude revisar las variantes de la familia: {error}</p>
  );
  const cargandoFamilia = !datos && !error && (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      Buscando variantes de la familia…
    </p>
  );
  // Sin buscador (Generar) sólo se muestra si hay nuevas. Con buscador el cuadro
  // se ve siempre: el buscador no depende de la familia.
  if (!conBuscador && !datos) return errorFamilia || cargandoFamilia;

  const nuevas = datos?.nuevas ?? [];
  const otros = datos?.en_otros_proyectos ?? [];
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

  if (!conBuscador && nuevas.length === 0) return notaOtros || null;

  const tokens = sinTildes(busqueda).split(/\s+/).filter(Boolean);
  const resultados =
    tokens.length && opciones ? opciones.filter((o) => tokens.every((t) => o.texto.includes(t))) : [];
  const deFamilia = new Set(nuevas.map((v) => v.sku));
  const marcadasFuera = opciones?.filter((o) => marcadas.has(o.sku) && !deFamilia.has(o.sku)) ?? [];
  const borradas = new Set((datos?.borradas ?? []).map((s) => s.toUpperCase()));
  // Lo que está en otro proyecto de la misma carpeta se puede agregar igual.
  const hermanos = new Set((datos?.hermanos ?? []).map((h) => h.id));

  return (
    <Card className={nuevas.length > 0 ? 'border-amber-300 bg-amber-50/50' : undefined}>
      <CardHeader>
        <CardTitle>Agregar variantes</CardTitle>
        {datos && datos.familias.length > 0 && (
          <p className="text-xs text-muted-foreground">Familia de ML: {datos.familias.join(' · ')}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {errorFamilia}
        {cargandoFamilia}
        {nuevas.length > 0 ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">Nuevas de la familia ({nuevas.length})</p>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {nuevas.map((v) => (
                <label key={v.sku} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={marcadas.has(v.sku)} onCheckedChange={() => alternar(v.sku)} />
                  <span className="min-w-0 flex-1 truncate">{v.label || v.color}</span>
                  {v.status_ml === 'paused' && <span className="text-xs text-amber-600">pausada</span>}
                  <span className="font-mono text-xs text-muted-foreground">{v.sku}</span>
                </label>
              ))}
            </div>
          </div>
        ) : datos && datos.familias.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            ✓ No hay variantes nuevas en la familia: {datos.en_proyecto} ya están en este proyecto.
          </p>
        ) : null}
        {conBuscador && borradas.size > 0 && (
          <p className="text-xs text-muted-foreground">
            {borradas.size} {borradas.size === 1 ? 'variante se borró' : 'variantes se borraron'} de la grilla: búscalas
            abajo para volver a agregarlas.
          </p>
        )}
        {notaOtros}

        {conBuscador && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={busqueda}
                onChange={(e) => buscar(e.target.value)}
                placeholder="Buscar otra publicación de ML (nombre, color o SKU)"
                className="pl-8"
              />
            </div>
            {errorLista && <p className="text-xs text-destructive">No pude cargar la lista de publicaciones: {errorLista}</p>}
            {cargandoLista && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Cargando publicaciones…
              </p>
            )}
            {tokens.length > 0 && opciones && (
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
                {resultados.length === 0 && <p className="text-xs text-muted-foreground">Sin resultados</p>}
                {resultados.slice(0, MAX_RESULTADOS).map((o) => {
                  const refs = indice[o.sku.toUpperCase()] ?? [];
                  const borrada = borradas.has(o.sku.toUpperCase());
                  const aca = !borrada && refs.some((r) => r.id === projectId);
                  const ajenos = refs.filter((r) => r.id !== projectId);
                  const otraCarpeta = ajenos.find((r) => !hermanos.has(r.id));
                  const libre = !aca && !otraCarpeta;
                  return (
                    <label
                      key={o.sku}
                      className={`flex items-center gap-2 text-sm ${libre ? 'cursor-pointer' : 'opacity-60'}`}
                    >
                      <Checkbox checked={aca || marcadas.has(o.sku)} disabled={!libre} onCheckedChange={() => alternar(o.sku)} />
                      <span className="min-w-0 flex-1 truncate">
                        {o.label} <span className="text-xs text-muted-foreground">· {o.familia}</span>
                      </span>
                      {o.status_ml === 'paused' && <span className="text-xs text-amber-600">pausada</span>}
                      {borrada && <span className="text-xs text-amber-600">borrada de la grilla</span>}
                      {aca && <span className="text-xs text-muted-foreground">ya está</span>}
                      {otraCarpeta && <span className="max-w-40 truncate text-xs text-muted-foreground">en {otraCarpeta.name}</span>}
                      {libre && ajenos.length > 0 && (
                        <span className="max-w-40 truncate text-xs text-muted-foreground">también en {ajenos[0].name}</span>
                      )}
                      <span className="font-mono text-xs text-muted-foreground">{o.sku}</span>
                    </label>
                  );
                })}
                {resultados.length > MAX_RESULTADOS && (
                  <p className="text-xs text-muted-foreground">
                    y {resultados.length - MAX_RESULTADOS} más: escribe más para acotar
                  </p>
                )}
              </div>
            )}
            {marcadasFuera.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {marcadasFuera.map((o) => (
                  <span key={o.sku} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                    {o.label} ({o.sku})
                    <button type="button" onClick={() => alternar(o.sku)} className="text-muted-foreground hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {(nuevas.length > 0 || conBuscador) && (
          <Button size="sm" onClick={agregar} disabled={agregando || marcadas.size === 0}>
            {agregando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Agregar {marcadas.size}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
