'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Search, Copy, Loader2, CheckCircle, XCircle, ExternalLink, ImageIcon, CheckSquare, Square, ArrowLeftRight, Replace,
} from 'lucide-react';
import { toast } from 'sonner';

interface SearchResult {
  item_id: string;
  title: string;
  status: string;
  permalink: string;
  picture_count: number;
  thumbnail: string | null;
}

interface SourceDetail {
  item_id: string;
  title: string;
  status: string;
  permalink: string;
  pictures: Array<{ id: string; url: string; size: string }>;
}

interface ReplicateResult {
  sku: string;
  item_id: string | null;
  title: string | null;
  status: 'ok' | 'error';
  pictures_set: number;
  error?: string;
}

export default function ReplicatePage() {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [listings, setListings] = useState<SearchResult[]>([]);
  const [totalResults, setTotalResults] = useState(0);

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<SourceDetail | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [targetIds, setTargetIds] = useState<Set<string>>(new Set());

  const [selectedPicIds, setSelectedPicIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'swap_positions' | 'replace_all'>('swap_positions');

  const [replicating, setReplicating] = useState(false);
  const [results, setResults] = useState<ReplicateResult[] | null>(null);

  async function handleSearch() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setListings([]);
    setSourceId(null);
    setSourceDetail(null);
    setSelectedPicIds(new Set());
    setTargetIds(new Set());
    setResults(null);
    try {
      // Try as SKU first if it looks like one
      if (/^[A-Za-z0-9_.-]+$/.test(q) && !q.includes(' ')) {
        const skuRes = await fetch(`/api/replicate-pictures?sku=${encodeURIComponent(q)}`);
        if (skuRes.ok) {
          const data = await skuRes.json();
          setListings([{
            item_id: data.item_id,
            title: data.title,
            status: data.status,
            permalink: data.permalink,
            picture_count: data.pictures.length,
            thumbnail: data.pictures[0]?.url || null,
          }]);
          setTotalResults(1);
          setSearching(false);
          return;
        }
      }
      // Search by name
      const res = await fetch(`/api/replicate-pictures?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setListings(data.results || []);
      setTotalResults(data.total || 0);
      if (!data.results?.length) {
        toast.error('No se encontraron publicaciones');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSearching(false);
    }
  }

  async function selectSource(itemId: string) {
    if (sourceId === itemId) return;
    setSourceId(itemId);
    setSourceDetail(null);
    setLoadingSource(true);
    // Remove from targets if it was there
    setTargetIds((prev) => {
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
    try {
      const res = await fetch(`/api/replicate-pictures?item_id=${itemId}`);
      if (res.ok) {
        const detail = await res.json();
        setSourceDetail(detail);
        if (detail.pictures) {
          setSelectedPicIds(new Set(detail.pictures.map((p: any) => p.id)));
        }
      }
    } catch {
      toast.error('Error cargando fotos');
    } finally {
      setLoadingSource(false);
    }
  }

  function toggleTarget(itemId: string) {
    if (itemId === sourceId) return;
    setTargetIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function selectAllAsTargets() {
    const all = new Set(listings.filter((l) => l.item_id !== sourceId).map((l) => l.item_id));
    setTargetIds(all);
  }

  function clearTargets() {
    setTargetIds(new Set());
  }

  async function handleReplicate() {
    if (!sourceDetail || targetIds.size === 0) return;
    setReplicating(true);
    setResults(null);
    try {
      const res = await fetch('/api/replicate-pictures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_item_id: sourceDetail.item_id,
          target_item_ids: Array.from(targetIds),
          selected_picture_ids: Array.from(selectedPicIds),
          mode,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setResults(data.targets);
        const ok = data.summary.success;
        const err = data.summary.errors;
        if (ok > 0) toast.success(`${ok} publicación${ok !== 1 ? 'es' : ''} actualizada${ok !== 1 ? 's' : ''}`);
        if (err > 0) toast.error(`${err} error${err !== 1 ? 'es' : ''}`);
      } else {
        toast.error(data.error || 'Error replicando');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setReplicating(false);
    }
  }

  const statusColor = (s: string) => {
    if (s === 'active') return 'bg-green-100 text-green-700';
    if (s === 'paused') return 'bg-yellow-100 text-yellow-700';
    return 'bg-gray-100 text-gray-600';
  };

  // Extract variant name from title (last word typically)
  function variantName(title: string): string {
    // "Sabanas De 1.5 Plaza Infantil De 144 Hilos Premium Stars" → "Stars"
    const words = title.trim().split(/\s+/);
    return words[words.length - 1] || title;
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Replicar Fotos entre Publicaciones</h1>
        <p className="text-muted-foreground">
          Busca por nombre o SKU, selecciona origen y destinos, replica instantáneamente
        </p>
      </div>

      {/* Search */}
      <div className="flex gap-2 mb-6">
        <Input
          placeholder="Buscar: ej. sabanas infantiles 1.5 plaza, o un SKU..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="text-base"
        />
        <Button onClick={handleSearch} disabled={searching || !query.trim()} size="lg">
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
          {!searching && 'Buscar'}
        </Button>
      </div>

      {listings.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* LEFT: Listings list */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {listings.length} publicaciones{totalResults > listings.length ? ` de ${totalResults}` : ''}
              </p>
              <div className="flex gap-2">
                {sourceId && (
                  <>
                    <Button variant="outline" size="sm" onClick={selectAllAsTargets} className="text-xs h-7">
                      <CheckSquare className="h-3 w-3 mr-1" />
                      Seleccionar todas
                    </Button>
                    {targetIds.size > 0 && (
                      <Button variant="ghost" size="sm" onClick={clearTargets} className="text-xs h-7">
                        Limpiar
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>

            {!sourceId && (
              <p className="text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2">
                Haz click en una publicación para seleccionarla como <strong>origen</strong>
              </p>
            )}

            {sourceId && targetIds.size === 0 && (
              <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                Ahora marca las publicaciones <strong>destino</strong> con el checkbox, o usa "Seleccionar todas"
              </p>
            )}

            <div className="space-y-1">
              {listings.map((listing) => {
                const isSource = listing.item_id === sourceId;
                const isTarget = targetIds.has(listing.item_id);
                const resultForThis = results?.find((r) => r.item_id === listing.item_id || r.sku === listing.item_id);

                return (
                  <div
                    key={listing.item_id}
                    className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                      isSource
                        ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-300'
                        : isTarget
                        ? 'border-green-300 bg-green-50'
                        : resultForThis?.status === 'ok'
                        ? 'border-green-200 bg-green-50/50'
                        : resultForThis?.status === 'error'
                        ? 'border-red-200 bg-red-50/50'
                        : 'hover:bg-muted/50 cursor-pointer'
                    }`}
                  >
                    {/* Checkbox / Source indicator */}
                    <div className="flex-shrink-0">
                      {isSource ? (
                        <Badge className="text-[10px] bg-blue-600">ORIGEN</Badge>
                      ) : sourceId ? (
                        <button
                          onClick={() => toggleTarget(listing.item_id)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {isTarget ? (
                            <CheckSquare className="h-5 w-5 text-green-600" />
                          ) : (
                            <Square className="h-5 w-5" />
                          )}
                        </button>
                      ) : null}
                    </div>

                    {/* Thumbnail */}
                    {listing.thumbnail ? (
                      <img
                        src={listing.thumbnail}
                        alt=""
                        className="h-12 w-12 rounded object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="h-12 w-12 rounded bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <ImageIcon className="h-5 w-5 text-gray-300" />
                      </div>
                    )}

                    {/* Info */}
                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => !sourceId ? selectSource(listing.item_id) : isSource ? null : toggleTarget(listing.item_id)}
                    >
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{listing.title}</p>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground font-mono">{listing.item_id}</span>
                        <Badge variant="secondary" className={`text-[9px] h-4 px-1 ${statusColor(listing.status)}`}>
                          {listing.status}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{listing.picture_count} fotos</span>
                      </div>
                    </div>

                    {/* Result status */}
                    {resultForThis && (
                      <div className="flex-shrink-0">
                        {resultForThis.status === 'ok' ? (
                          <CheckCircle className="h-5 w-5 text-green-600" />
                        ) : (
                          <span title={resultForThis.error}><XCircle className="h-5 w-5 text-red-600" /></span>
                        )}
                      </div>
                    )}

                    {/* External link */}
                    {listing.permalink && (
                      <a
                        href={listing.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex-shrink-0"
                      >
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT: Source preview + action */}
          <div className="space-y-4">
            {/* Source preview */}
            {sourceId && (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Fotos Origen</CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7 text-muted-foreground"
                      onClick={() => { setSourceId(null); setSourceDetail(null); setSelectedPicIds(new Set()); setTargetIds(new Set()); setResults(null); }}
                    >
                      Cambiar
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {loadingSource ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : sourceDetail ? (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground truncate">{sourceDetail.title}</p>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-muted-foreground">
                          {selectedPicIds.size} de {sourceDetail.pictures.length} fotos seleccionadas
                        </p>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[10px] h-6 px-2"
                            onClick={() => setSelectedPicIds(new Set(sourceDetail.pictures.map((p) => p.id)))}
                          >
                            Todas
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[10px] h-6 px-2"
                            onClick={() => setSelectedPicIds(new Set())}
                          >
                            Ninguna
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {sourceDetail.pictures.map((pic, i) => {
                          const isSelected = selectedPicIds.has(pic.id);
                          return (
                            <div
                              key={pic.id}
                              className={`aspect-square rounded overflow-hidden bg-gray-100 relative cursor-pointer ring-2 transition-all ${
                                isSelected ? 'ring-blue-500 opacity-100' : 'ring-transparent opacity-40'
                              }`}
                              onClick={() => {
                                setSelectedPicIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(pic.id)) next.delete(pic.id);
                                  else next.add(pic.id);
                                  return next;
                                });
                              }}
                            >
                              <img
                                src={pic.url}
                                alt={`Foto ${i + 1}`}
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                              <span className={`absolute bottom-0 right-0 text-white text-[9px] px-1 rounded-tl ${
                                isSelected ? 'bg-blue-600' : 'bg-black/60'
                              }`}>
                                {i + 1}
                              </span>
                              {isSelected && (
                                <div className="absolute top-0.5 right-0.5">
                                  <CheckCircle className="h-3.5 w-3.5 text-blue-500 drop-shadow" />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            )}

            {/* Mode toggle */}
            {sourceDetail && selectedPicIds.size > 0 && (
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground mb-2 font-medium">Modo de replicado</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => setMode('swap_positions')}
                      className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs transition-colors ${
                        mode === 'swap_positions'
                          ? 'border-blue-400 bg-blue-50 text-blue-700 ring-1 ring-blue-300'
                          : 'border-gray-200 hover:bg-muted/50 text-muted-foreground'
                      }`}
                    >
                      <ArrowLeftRight className="h-4 w-4" />
                      <span className="font-medium">Swap posicion</span>
                      <span className="text-[10px] leading-tight text-center opacity-75">
                        Reemplaza solo las seleccionadas
                      </span>
                    </button>
                    <button
                      onClick={() => setMode('replace_all')}
                      className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs transition-colors ${
                        mode === 'replace_all'
                          ? 'border-blue-400 bg-blue-50 text-blue-700 ring-1 ring-blue-300'
                          : 'border-gray-200 hover:bg-muted/50 text-muted-foreground'
                      }`}
                    >
                      <Replace className="h-4 w-4" />
                      <span className="font-medium">Reemplazar todas</span>
                      <span className="text-[10px] leading-tight text-center opacity-75">
                        Borra fotos del destino
                      </span>
                    </button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Action */}
            {sourceDetail && targetIds.size > 0 && selectedPicIds.size > 0 && (
              <Card>
                <CardContent className="pt-6 space-y-3">
                  <div className="text-center">
                    <p className="text-2xl font-bold">{selectedPicIds.size}</p>
                    <p className="text-xs text-muted-foreground">
                      foto{selectedPicIds.size !== 1 ? 's' : ''} seleccionada{selectedPicIds.size !== 1 ? 's' : ''}
                    </p>
                    <p className="text-lg font-medium mt-1">→ {targetIds.size} destino{targetIds.size !== 1 ? 's' : ''}</p>
                    {mode === 'swap_positions' && (
                      <p className="text-[11px] text-blue-600 mt-1">
                        Solo se reemplazan las posiciones seleccionadas
                      </p>
                    )}
                  </div>

                  <Button
                    className="w-full"
                    size="lg"
                    disabled={replicating}
                    onClick={handleReplicate}
                  >
                    {replicating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {mode === 'swap_positions' ? 'Swapping...' : 'Replicando...'}
                      </>
                    ) : mode === 'swap_positions' ? (
                      <>
                        <ArrowLeftRight className="h-4 w-4 mr-2" />
                        Swap {selectedPicIds.size} foto{selectedPicIds.size !== 1 ? 's' : ''} en posicion
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4 mr-2" />
                        Replicar Fotos
                      </>
                    )}
                  </Button>

                  {results && (
                    <div className="text-center text-sm pt-2 border-t">
                      <span className="text-green-600 font-medium">
                        {results.filter((r) => r.status === 'ok').length} OK
                      </span>
                      {results.some((r) => r.status === 'error') && (
                        <span className="text-red-600 font-medium ml-3">
                          {results.filter((r) => r.status === 'error').length} errores
                        </span>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
