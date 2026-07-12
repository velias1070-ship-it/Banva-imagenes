'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  Search,
  ExternalLink,
  Loader2,
  X,
  Images,
  RefreshCw,
} from 'lucide-react';

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
}

interface ProductGroup {
  base_name: string;
  slug: string;
  tamano: string;
  categoria: string;
  family_name?: string | null;
  variantes: Variante[];
}

interface LivePic {
  id: string;
  url: string;
  full: string;
}

interface PicState {
  loading: boolean;
  error?: string;
  pics?: LivePic[];
}

// Sube una URL de mlstatic a un tamaño mayor y fuerza https.
// D_...-I.webp (thumb) -> -O.webp (medio) / -F.webp (full)
function mlImg(url: string | undefined, code: 'O' | 'F' = 'O'): string {
  if (!url) return '';
  return url
    .replace(/^http:/, 'https:')
    .replace(/-[A-Z]\.(webp|jpg|jpeg|png)(\?.*)?$/i, `-${code}.$1$2`);
}

// Categorías donde la talla se mide en "plazas" (cama). En toallas/alfombras/etc
// los dígitos del SKU NO son plazas, así que la derivación solo aplica aquí.
const BEDDING_CATS = new Set([
  'sabanas',
  'quilts',
  'plumones',
  'frazadas',
  'cubrecamas',
  'toppers',
  'cubre-colchon',
]);

// Deriva la talla en plazas desde el SKU cuando el campo estructurado falta.
// La talla se codifica como el ÚLTIMO token 10/15/20/25 del SKU (con límites de
// dígito para no cazar números de serie: JSAFAB4[15]P[20]W → toma 20, no 15).
function plazaFromSku(sku: string): string {
  const matches = sku.toUpperCase().match(/(?<!\d)(10|15|20|25)(?!\d)/g);
  if (!matches) return '';
  const code = matches[matches.length - 1];
  const map: Record<string, string> = {
    '10': '1 plaza',
    '15': '1.5 plazas',
    '20': '2 plazas',
    '25': '2.5 plazas',
  };
  return map[code] || '';
}

// Talla efectiva: bed_size si viene, si no la derivada del SKU (solo cama).
function sizeOf(v: Variante, bedding: boolean): string {
  const bs = (v.bed_size || '').trim();
  if (bs) return bs;
  return bedding ? plazaFromSku(v.sku) : '';
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className={`h-9 rounded-md border bg-white px-2 text-sm ${
        value ? 'border-blue-400 text-blue-700' : 'text-gray-700'
      }`}
    >
      <option value="">{label}: todos</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export default function VariantesPage() {
  const [families, setFamilies] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Fotos en vivo por item_id
  const [picsByItem, setPicsByItem] = useState<Record<string, PicState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingAll, setLoadingAll] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [view, setView] = useState<'cards' | 'matrix'>('cards');
  // Filtros dentro de la familia elegida
  const [fSize, setFSize] = useState('');
  const [fColor, setFColor] = useState('');
  const [fTipo, setFTipo] = useState('');
  const [fText, setFText] = useState('');

  useEffect(() => {
    fetch('/api/productos')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setFamilies(data as ProductGroup[]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = useMemo(
    () => families.find((f) => f.slug === selectedSlug) || null,
    [families, selectedSlug]
  );

  // La vista "Comparar fotos" (matriz) necesita todas las fotos de todas las
  // variantes, asi que se disparan las cargas en vivo al entrar a esa vista.
  useEffect(() => {
    if (view === 'matrix' && selected) {
      void loadAllLive();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedSlug]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? families.filter(
          (f) =>
            f.base_name.toLowerCase().includes(q) ||
            (f.family_name || '').toLowerCase().includes(q) ||
            f.categoria.toLowerCase().includes(q) ||
            f.variantes.some(
              (v) =>
                v.sku.toLowerCase().includes(q) ||
                v.color.toLowerCase().includes(q)
            )
        )
      : families;
    return base.slice(0, 50);
  }, [families, query]);

  const fetchPics = useCallback(
    async (itemId: string): Promise<void> => {
      // Ya cargado o cargando: no repetir
      let already = false;
      setPicsByItem((prev) => {
        const cur = prev[itemId];
        if (cur && (cur.loading || cur.pics)) {
          already = true;
          return prev;
        }
        return { ...prev, [itemId]: { loading: true } };
      });
      if (already) return;

      try {
        const res = await fetch(
          `/api/ml/item-pictures?item_id=${encodeURIComponent(itemId)}`
        );
        const data = await res.json();
        if (!res.ok) {
          setPicsByItem((prev) => ({
            ...prev,
            [itemId]: { loading: false, error: data?.error || `Error ${res.status}` },
          }));
          return;
        }
        setPicsByItem((prev) => ({
          ...prev,
          [itemId]: { loading: false, pics: (data.pictures || []) as LivePic[] },
        }));
      } catch (err) {
        setPicsByItem((prev) => ({
          ...prev,
          [itemId]: { loading: false, error: err instanceof Error ? err.message : 'Error de red' },
        }));
      }
    },
    []
  );

  function toggleExpand(itemId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
        void fetchPics(itemId);
      }
      return next;
    });
  }

  // Carga las fotos en vivo de TODAS las variantes, con concurrencia limitada.
  async function loadAllLive() {
    if (!selected) return;
    const ids = selected.variantes
      .map((v) => v.item_id)
      .filter((id): id is string => !!id && /^ML[A-Z]\d+$/.test(id));
    setLoadingAll(true);
    setExpanded(new Set(ids));
    const CONCURRENCY = 5;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => fetchPics(id)));
    }
    setLoadingAll(false);
  }

  function selectFamily(slug: string) {
    setSelectedSlug(slug);
    setQuery('');
    setOpen(false);
    setExpanded(new Set());
    setPicsByItem({});
    setFSize('');
    setFColor('');
    setFTipo('');
    setFText('');
  }

  const totalVariantes = selected?.variantes.length ?? 0;
  const bedding = !!selected && BEDDING_CATS.has(selected.categoria);

  // Opciones de filtro derivadas de las variantes de la familia elegida.
  // Solo se muestra un desplegable si esa dimensión tiene 2+ valores distintos.
  const sizeOpts = useMemo(
    () => [...new Set((selected?.variantes || []).map((v) => sizeOf(v, bedding)).filter(Boolean))].sort(),
    [selected, bedding]
  );
  const colorOpts = useMemo(
    () => [...new Set((selected?.variantes || []).map((v) => v.color || '').filter(Boolean))].sort(),
    [selected]
  );
  const tipoOpts = useMemo(
    () => [...new Set((selected?.variantes || []).map((v) => v.tipo || '').filter(Boolean))].sort(),
    [selected]
  );

  const filteredVariantes = useMemo(() => {
    const t = fText.trim().toLowerCase();
    return (selected?.variantes || []).filter((v) => {
      if (fSize && sizeOf(v, bedding) !== fSize) return false;
      if (fColor && (v.color || '') !== fColor) return false;
      if (fTipo && (v.tipo || '') !== fTipo) return false;
      if (t) {
        const hay = `${v.sku} ${v.color} ${v.tipo || ''} ${sizeOf(v, bedding)} ${v.label || ''}`.toLowerCase();
        if (!hay.includes(t)) return false;
      }
      return true;
    });
  }, [selected, bedding, fSize, fColor, fTipo, fText]);

  const hasFilters = !!(fSize || fColor || fTipo || fText.trim());

  return (
    <div className="p-8">
      <Link
        href="/"
        className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Dashboard
      </Link>

      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Images className="h-6 w-6 text-blue-600" />
          Variantes en MercadoLibre
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Elige una familia de productos y mira la foto de cada una de sus
          publicaciones (color + tamaño) tal como están en ML.
        </p>
      </div>

      {/* Buscador de familia */}
      <div ref={wrapperRef} className="relative mb-6 max-w-xl">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={open ? query : selected ? `${selected.base_name}` : query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={loading ? 'Cargando familias…' : 'Buscar familia por nombre, color o SKU…'}
            className={`pl-9 ${open ? 'ring-2 ring-ring' : ''}`}
          />
        </div>
        {open && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[360px] overflow-y-auto rounded-md border bg-popover shadow-lg">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {loading ? 'Cargando…' : 'Sin resultados'}
              </div>
            ) : (
              filtered.map((f) => (
                <button
                  key={f.slug}
                  type="button"
                  onClick={() => selectFamily(f.slug)}
                  className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                    f.slug === selectedSlug ? 'bg-accent' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{f.base_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {f.variantes.length} publicaciones · {f.categoria}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Encabezado familia + acciones */}
      {selected && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{selected.base_name}</h2>
            <p className="text-sm text-muted-foreground">
              {totalVariantes} publicaciones · {selected.categoria}
              {loadingAll ? ' · cargando fotos…' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border">
              <button
                type="button"
                onClick={() => setView('cards')}
                className={`px-3 py-1.5 text-sm ${
                  view === 'cards'
                    ? 'bg-blue-50 font-medium text-blue-700'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                Tarjetas
              </button>
              <button
                type="button"
                onClick={() => setView('matrix')}
                className={`border-l px-3 py-1.5 text-sm ${
                  view === 'matrix'
                    ? 'bg-blue-50 font-medium text-blue-700'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                Comparar fotos
              </button>
            </div>
            <Button onClick={loadAllLive} disabled={loadingAll} variant="outline" size="sm">
              {loadingAll ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {view === 'matrix' ? 'Recargar' : 'Ver todas en vivo'}
            </Button>
          </div>
        </div>
      )}

      {/* Barra de filtros dentro de la familia */}
      {selected && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {sizeOpts.length >= 2 && (
            <FilterSelect label="Tamaño" value={fSize} onChange={setFSize} options={sizeOpts} />
          )}
          {colorOpts.length >= 2 && (
            <FilterSelect label="Color" value={fColor} onChange={setFColor} options={colorOpts} />
          )}
          {tipoOpts.length >= 2 && (
            <FilterSelect label="Diseño" value={fTipo} onChange={setFTipo} options={tipoOpts} />
          )}
          <input
            value={fText}
            onChange={(e) => setFText(e.target.value)}
            placeholder="Filtrar por SKU o color…"
            className="h-9 w-56 rounded-md border px-3 text-sm"
          />
          <span className="text-xs text-muted-foreground">
            {filteredVariantes.length} de {totalVariantes}
          </span>
          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setFSize('');
                setFColor('');
                setFTipo('');
                setFText('');
              }}
              className="text-xs text-blue-600 hover:underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      )}

      {/* Grilla de publicaciones (vista Tarjetas) */}
      {selected && view === 'cards' && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filteredVariantes.map((v) => {
            const itemId = v.item_id;
            const state = itemId ? picsByItem[itemId] : undefined;
            const livePics = state?.pics;
            const mainSrc =
              (livePics && livePics[0]?.url) || mlImg(v.thumbnail, 'O');
            const isExpanded = itemId ? expanded.has(itemId) : false;

            return (
              <div
                key={v.sku + (itemId || '')}
                className="flex flex-col overflow-hidden rounded-lg border bg-white shadow-sm"
              >
                <div className="relative aspect-square bg-gray-50">
                  {mainSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={mainSrc}
                      alt={v.label || v.color}
                      loading="lazy"
                      className="h-full w-full cursor-zoom-in object-contain"
                      onClick={() =>
                        setLightbox((livePics && livePics[0]?.full) || mlImg(v.thumbnail, 'F'))
                      }
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      Sin foto
                    </div>
                  )}
                  {sizeOf(v, bedding) && (
                    <Badge
                      variant="secondary"
                      className="absolute left-2 top-2 text-[10px]"
                    >
                      {sizeOf(v, bedding)}
                    </Badge>
                  )}
                </div>

                <div className="flex flex-1 flex-col gap-1 p-3">
                  <div className="truncate text-sm font-medium" title={v.label || v.color}>
                    {v.color}
                    {v.tipo ? <span className="text-muted-foreground"> · {v.tipo}</span> : null}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground" title={v.sku}>
                    {v.sku}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    {itemId ? (
                      <button
                        type="button"
                        onClick={() => toggleExpand(itemId)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                      >
                        {state?.loading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Images className="h-3 w-3" />
                        )}
                        {state?.pics ? `${state.pics.length} fotos` : 'Ver fotos'}
                      </button>
                    ) : (
                      <span className="text-[11px] text-amber-600">Sin item_id</span>
                    )}
                    {v.permalink && (
                      <a
                        href={v.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                        title="Abrir en MercadoLibre"
                      >
                        <ExternalLink className="h-3 w-3" />
                        ML
                      </a>
                    )}
                  </div>

                  {/* Tira de todas las fotos (en vivo) */}
                  {isExpanded && (
                    <div className="mt-2">
                      {state?.error ? (
                        <p className="text-[11px] text-red-600">{state.error}</p>
                      ) : state?.loading ? (
                        <p className="text-[11px] text-muted-foreground">Cargando fotos…</p>
                      ) : state?.pics && state.pics.length > 0 ? (
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {state.pics.map((p) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              key={p.id}
                              src={p.url}
                              alt=""
                              loading="lazy"
                              onClick={() => setLightbox(p.full)}
                              className="h-16 w-16 flex-shrink-0 cursor-zoom-in rounded border object-cover"
                            />
                          ))}
                        </div>
                      ) : state?.pics ? (
                        <p className="text-[11px] text-muted-foreground">Sin fotos</p>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Matriz de comparación (vista Comparar fotos):
          filas = variantes, columnas = posición de foto (#1..#N) en vivo */}
      {selected && view === 'matrix' && (() => {
        const rows = filteredVariantes;
        const maxCols = rows.reduce((m, v) => {
          const n = v.item_id ? picsByItem[v.item_id]?.pics?.length ?? 0 : 0;
          return Math.max(m, n);
        }, 0);
        const cols = Math.max(maxCols, 1);
        return (
          <div
            className="overflow-auto rounded-lg border bg-white"
            style={{ maxHeight: 'calc(100vh - 220px)' }}
          >
            <table className="border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-30 border-b border-r bg-gray-50 px-3 py-2 text-left font-medium">
                    Variante
                  </th>
                  {Array.from({ length: cols }).map((_, j) => (
                    <th
                      key={j}
                      className="sticky top-0 z-20 border-b bg-gray-50 px-2 py-2 text-center font-medium text-muted-foreground"
                    >
                      #{j + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const itemId = v.item_id;
                  const state = itemId ? picsByItem[itemId] : undefined;
                  const pics = state?.pics || [];
                  return (
                    <tr key={v.sku + (itemId || '')} className="hover:bg-gray-50/40">
                      <td className="sticky left-0 z-10 border-b border-r bg-white px-3 py-2 align-top">
                        <div className="flex items-center gap-2">
                          {v.thumbnail ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={mlImg(v.thumbnail, 'O')}
                              alt=""
                              className="h-10 w-10 flex-shrink-0 rounded border object-cover"
                            />
                          ) : null}
                          <div className="min-w-0">
                            <div className="whitespace-nowrap text-sm font-medium">
                              {v.color}
                              {v.tipo ? (
                                <span className="text-muted-foreground"> · {v.tipo}</span>
                              ) : null}
                              {sizeOf(v, bedding) ? (
                                <span className="text-muted-foreground"> · {sizeOf(v, bedding)}</span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {v.sku}
                              </span>
                              {v.permalink && (
                                <a
                                  href={v.permalink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:text-blue-700"
                                  title="Abrir en MercadoLibre"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      {Array.from({ length: cols }).map((_, j) => {
                        const p = pics[j];
                        return (
                          <td key={j} className="border-b px-1 py-1 text-center align-middle">
                            {p ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={p.url}
                                alt=""
                                loading="lazy"
                                onClick={() => setLightbox(p.full)}
                                className="mx-auto h-20 w-20 cursor-zoom-in rounded border object-cover"
                              />
                            ) : state?.error && j === 0 ? (
                              <span className="text-[10px] text-red-600" title={state.error}>
                                error
                              </span>
                            ) : state?.loading && j === 0 ? (
                              <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                            ) : (
                              <div className="mx-auto h-20 w-20 rounded border border-dashed bg-gray-50/60" />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}

      {!selected && !loading && (
        <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
          Busca y elige una familia arriba para ver sus variantes.
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setLightbox(null)}
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt=""
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
