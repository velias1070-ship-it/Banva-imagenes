'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Search, Copy, Loader2, CheckCircle, XCircle, ExternalLink, Trash2, Plus,
} from 'lucide-react';
import { toast } from 'sonner';

interface MlPicture {
  id: string;
  url: string;
  size: string;
}

interface ListingPreview {
  item_id: string;
  title: string;
  status: string;
  permalink: string;
  pictures: MlPicture[];
}

interface SearchResult {
  item_id: string;
  title: string;
  status: string;
  permalink: string;
  picture_count: number;
  thumbnail: string | null;
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
  const [sourceQuery, setSourceQuery] = useState('');
  const [sourcePreview, setSourcePreview] = useState<ListingPreview | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  const [targetQuery, setTargetQuery] = useState('');
  const [targetSearchResults, setTargetSearchResults] = useState<SearchResult[] | null>(null);
  const [loadingTargetSearch, setLoadingTargetSearch] = useState(false);

  const [targetSkus, setTargetSkus] = useState<string[]>(['']);
  const [targetItems, setTargetItems] = useState<Array<{ item_id: string; title: string }>>([]);
  const [replicating, setReplicating] = useState(false);
  const [results, setResults] = useState<ReplicateResult[] | null>(null);

  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(null);

  // Detect if input looks like a SKU (alphanumeric, no spaces) or a search query
  function looksLikeSku(input: string): boolean {
    return /^[A-Za-z0-9_.-]+$/.test(input) && input.length >= 3;
  }

  async function fetchSource() {
    const q = sourceQuery.trim();
    if (!q) return;
    setLoadingSource(true);
    setSourcePreview(null);
    setSearchResults(null);
    setResults(null);
    try {
      if (looksLikeSku(q)) {
        // Try SKU first
        const res = await fetch(`/api/replicate-pictures?sku=${encodeURIComponent(q)}`);
        if (res.ok) {
          setSourcePreview(await res.json());
          return;
        }
      }
      // Fallback to name search
      const res = await fetch(`/api/replicate-pictures?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.results?.length) {
        setSearchResults(data.results);
      } else {
        toast.error('No se encontraron publicaciones');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setLoadingSource(false);
    }
  }

  async function selectSearchResult(itemId: string) {
    setSearchResults(null);
    setLoadingSource(true);
    try {
      const res = await fetch(`/api/replicate-pictures?item_id=${itemId}`);
      if (res.ok) {
        setSourcePreview(await res.json());
      } else {
        toast.error('Error cargando publicación');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setLoadingSource(false);
    }
  }

  // Target search by name
  async function searchTargets() {
    const q = targetQuery.trim();
    if (!q) return;
    setLoadingTargetSearch(true);
    setTargetSearchResults(null);
    try {
      const res = await fetch(`/api/replicate-pictures?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.results?.length) {
        setTargetSearchResults(data.results);
      } else {
        toast.error('No se encontraron publicaciones');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setLoadingTargetSearch(false);
    }
  }

  function addTargetFromSearch(result: SearchResult) {
    if (targetItems.some((t) => t.item_id === result.item_id)) {
      toast.info('Ya agregado');
      return;
    }
    setTargetItems((prev) => [...prev, { item_id: result.item_id, title: result.title }]);
  }

  function removeTargetItem(itemId: string) {
    setTargetItems((prev) => prev.filter((t) => t.item_id !== itemId));
  }

  function addTargetField() {
    setTargetSkus((prev) => [...prev, '']);
  }

  function removeTargetField(index: number) {
    setTargetSkus((prev) => prev.filter((_, i) => i !== index));
  }

  function updateTargetSku(index: number, value: string) {
    setTargetSkus((prev) => prev.map((s, i) => (i === index ? value : s)));
  }

  async function handleReplicate() {
    const validSkus = targetSkus.map((s) => s.trim()).filter(Boolean);
    const validItemIds = targetItems.map((t) => t.item_id);
    if (!sourcePreview || (validSkus.length === 0 && validItemIds.length === 0)) return;

    setReplicating(true);
    setResults(null);
    try {
      const res = await fetch('/api/replicate-pictures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_item_id: sourcePreview.item_id,
          target_skus: validSkus.length > 0 ? validSkus : undefined,
          target_item_ids: validItemIds.length > 0 ? validItemIds : undefined,
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

  function handlePasteTargets(e: React.ClipboardEvent<HTMLInputElement>, index: number) {
    const pasted = e.clipboardData.getData('text');
    const skus = pasted.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (skus.length > 1) {
      e.preventDefault();
      setTargetSkus((prev) => {
        const before = prev.slice(0, index);
        const after = prev.slice(index + 1);
        return [...before, ...skus, ...after];
      });
    }
  }

  const validTargetCount = targetSkus.filter((s) => s.trim()).length + targetItems.length;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Replicar Fotos entre Publicaciones</h1>
        <p className="text-muted-foreground">
          Copia las fotos de una publicación de ML a otras instantáneamente. Busca por SKU o nombre.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* SOURCE */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Publicación Origen</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="SKU o nombre del producto..."
                value={sourceQuery}
                onChange={(e) => setSourceQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchSource()}
              />
              <Button onClick={fetchSource} disabled={loadingSource || !sourceQuery.trim()}>
                {loadingSource ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>

            {/* Search results list */}
            {searchResults && (
              <div className="space-y-1 max-h-80 overflow-y-auto border rounded-lg p-2">
                <p className="text-xs text-muted-foreground px-1 mb-1">
                  {searchResults.length} resultados — selecciona uno:
                </p>
                {searchResults.map((r) => (
                  <button
                    key={r.item_id}
                    className="w-full flex items-center gap-3 rounded-lg p-2 hover:bg-muted/50 text-left transition-colors"
                    onClick={() => selectSearchResult(r.item_id)}
                  >
                    {r.thumbnail ? (
                      <img src={r.thumbnail} alt="" className="h-10 w-10 rounded object-cover flex-shrink-0" />
                    ) : (
                      <div className="h-10 w-10 rounded bg-gray-100 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{r.title}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground font-mono">{r.item_id}</span>
                        <Badge
                          variant="secondary"
                          className={`text-[9px] h-4 px-1 ${r.status === 'active' ? 'bg-green-100 text-green-700' : ''}`}
                        >
                          {r.status}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{r.picture_count} fotos</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Selected source preview */}
            {sourcePreview && (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{sourcePreview.title}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {sourcePreview.item_id}
                      </Badge>
                      <Badge
                        variant="secondary"
                        className={`text-[10px] ${sourcePreview.status === 'active' ? 'bg-green-100 text-green-700' : ''}`}
                      >
                        {sourcePreview.status}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {sourcePreview.permalink && (
                      <a href={sourcePreview.permalink} target="_blank" rel="noopener noreferrer">
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => { setSourcePreview(null); setSourceQuery(''); }}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground mb-2">
                    {sourcePreview.pictures.length} fotos a copiar:
                  </p>
                  <div className="grid grid-cols-5 gap-1.5">
                    {sourcePreview.pictures.map((pic, i) => (
                      <div key={pic.id} className="aspect-square rounded overflow-hidden bg-gray-100 relative">
                        <img
                          src={pic.url}
                          alt={`Foto ${i + 1}`}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                        <span className="absolute bottom-0 right-0 bg-black/60 text-white text-[9px] px-1 rounded-tl">
                          {i + 1}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* TARGETS */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Publicaciones Destino</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Search targets by name */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">
                Buscar por nombre para agregar destinos:
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Buscar publicación por nombre..."
                  value={targetQuery}
                  onChange={(e) => setTargetQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && searchTargets()}
                />
                <Button
                  variant="outline"
                  onClick={searchTargets}
                  disabled={loadingTargetSearch || !targetQuery.trim()}
                >
                  {loadingTargetSearch ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </div>

              {targetSearchResults && (
                <div className="space-y-1 max-h-48 overflow-y-auto border rounded-lg p-2 mt-2">
                  {targetSearchResults.map((r) => {
                    const isAdded = targetItems.some((t) => t.item_id === r.item_id);
                    return (
                      <button
                        key={r.item_id}
                        className={`w-full flex items-center gap-3 rounded-lg p-2 text-left transition-colors ${
                          isAdded ? 'bg-green-50 opacity-60' : 'hover:bg-muted/50'
                        }`}
                        onClick={() => addTargetFromSearch(r)}
                        disabled={isAdded}
                      >
                        {r.thumbnail ? (
                          <img src={r.thumbnail} alt="" className="h-8 w-8 rounded object-cover flex-shrink-0" />
                        ) : (
                          <div className="h-8 w-8 rounded bg-gray-100 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs truncate">{r.title}</p>
                          <span className="text-[10px] text-muted-foreground font-mono">{r.item_id}</span>
                        </div>
                        {isAdded ? (
                          <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
                        ) : (
                          <Plus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selected target items from search */}
            {targetItems.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Seleccionados:</p>
                {targetItems.map((t) => (
                  <div key={t.item_id} className="flex items-center gap-2 rounded-lg border p-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs truncate">{t.title}</p>
                      <span className="text-[10px] text-muted-foreground font-mono">{t.item_id}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-red-500 hover:text-red-700 flex-shrink-0"
                      onClick={() => removeTargetItem(t.item_id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Manual SKU input */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">
                O ingresa SKUs directamente:
              </p>
              <div className="space-y-2">
                {targetSkus.map((sku, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      placeholder={`SKU destino ${i + 1}`}
                      value={sku}
                      onChange={(e) => updateTargetSku(i, e.target.value)}
                      onPaste={(e) => handlePasteTargets(e, i)}
                    />
                    {targetSkus.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-red-500 hover:text-red-700 flex-shrink-0"
                        onClick={() => removeTargetField(i)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={addTargetField} className="w-full mt-2">
                <Plus className="h-3.5 w-3.5 mr-1" />
                Agregar SKU
              </Button>
            </div>

            <Button
              className="w-full"
              disabled={!sourcePreview || validTargetCount === 0 || replicating}
              onClick={handleReplicate}
            >
              {replicating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Replicando...
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-2" />
                  Replicar {sourcePreview?.pictures.length || 0} fotos a {validTargetCount} destino{validTargetCount !== 1 ? 's' : ''}
                </>
              )}
            </Button>

            {/* Results */}
            {results && (
              <div className="space-y-2 pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground">Resultados:</p>
                {results.map((r, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-3 rounded-lg border p-3 ${
                      r.status === 'ok' ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
                    }`}
                  >
                    {r.status === 'ok' ? (
                      <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {r.sku}
                        {r.item_id && (
                          <span className="text-xs text-muted-foreground ml-2">{r.item_id}</span>
                        )}
                      </p>
                      {r.title && (
                        <p className="text-xs text-muted-foreground truncate">{r.title}</p>
                      )}
                      {r.status === 'ok' && (
                        <p className="text-xs text-green-700">{r.pictures_set} fotos replicadas</p>
                      )}
                      {r.error && (
                        <p className="text-xs text-red-700">{r.error}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
