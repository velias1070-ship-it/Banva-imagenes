'use client';

import { useState } from 'react';
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

interface ReplicateResult {
  sku: string;
  item_id: string | null;
  title: string | null;
  status: 'ok' | 'error';
  pictures_set: number;
  error?: string;
}

export default function ReplicatePage() {
  const [sourceSku, setSourceSku] = useState('');
  const [sourcePreview, setSourcePreview] = useState<ListingPreview | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  const [targetSkus, setTargetSkus] = useState<string[]>(['']);
  const [replicating, setReplicating] = useState(false);
  const [results, setResults] = useState<ReplicateResult[] | null>(null);

  async function fetchSource() {
    const sku = sourceSku.trim();
    if (!sku) return;
    setLoadingSource(true);
    setSourcePreview(null);
    setResults(null);
    try {
      const res = await fetch(`/api/replicate-pictures?sku=${encodeURIComponent(sku)}`);
      const data = await res.json();
      if (res.ok) {
        setSourcePreview(data);
      } else {
        toast.error(data.error || 'SKU no encontrado');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setLoadingSource(false);
    }
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
    const validTargets = targetSkus.map((s) => s.trim()).filter(Boolean);
    if (!sourcePreview || validTargets.length === 0) return;

    setReplicating(true);
    setResults(null);
    try {
      const res = await fetch('/api/replicate-pictures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_sku: sourceSku.trim(),
          target_skus: validTargets,
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
    // If pasting multiple SKUs (newline or comma separated), split them
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

  const validTargetCount = targetSkus.filter((s) => s.trim()).length;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Replicar Fotos entre Publicaciones</h1>
        <p className="text-muted-foreground">
          Copia las fotos de una publicación de ML a otras publicaciones instantáneamente
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
                placeholder="SKU origen (ej: JSAFAB400P20X)"
                value={sourceSku}
                onChange={(e) => setSourceSku(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchSource()}
              />
              <Button onClick={fetchSource} disabled={loadingSource || !sourceSku.trim()}>
                {loadingSource ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>

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
                  {sourcePreview.permalink && (
                    <a href={sourcePreview.permalink} target="_blank" rel="noopener noreferrer">
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  )}
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
            <p className="text-xs text-muted-foreground">
              Ingresa los SKUs donde quieres copiar las fotos. Puedes pegar varios separados por coma o salto de línea.
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

            <Button variant="outline" size="sm" onClick={addTargetField} className="w-full">
              <Plus className="h-3.5 w-3.5 mr-1" />
              Agregar destino
            </Button>

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
