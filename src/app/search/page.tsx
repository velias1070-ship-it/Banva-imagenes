'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Download, ExternalLink, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface SearchResult {
  id: string;
  status: string;
  attempt: number;
  output_storage_path: string;
  qa_score: number | null;
  image_url: string;
  created_at: string;
  swatch: { name: string; sku_suffix: string | null } | null;
  hero_shot: { filename: string; shot_type: string } | null;
  project: { id: string; name: string } | null;
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('approved');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim() && !statusFilter) return;

    setSearching(true);
    setSearched(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);

      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      if (res.ok) {
        setResults(data.results || []);
        setTotal(data.total || 0);
      }
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Buscar Imagenes</h1>
        <p className="text-muted-foreground">Busca por SKU, nombre de producto, color o tipo de toma</p>
      </div>

      <form onSubmit={handleSearch} className="mb-6 flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Ej: TXV23QLRM30GR, Roma Gris, lifestyle..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="approved">Aprobadas</SelectItem>
            <SelectItem value="flagged">Flagged</SelectItem>
            <SelectItem value="retry">Retry</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={searching}>
          {searching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
          Buscar
        </Button>
      </form>

      {searched && (
        <p className="mb-4 text-sm text-muted-foreground">
          {total} resultado{total !== 1 ? 's' : ''}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {results.map((r) => {
          const swatch = r.swatch as SearchResult['swatch'];
          const hero = r.hero_shot as SearchResult['hero_shot'];

          return (
            <Card key={r.id} className="overflow-hidden">
              <div className="aspect-square bg-gray-100 relative">
                <img
                  src={r.image_url}
                  alt={swatch?.name || 'Generated'}
                  className="h-full w-full object-cover"
                />
                <Badge
                  className="absolute top-2 right-2 text-xs"
                  variant={r.status === 'approved' ? 'default' : 'secondary'}
                >
                  {r.status}
                </Badge>
              </div>
              <CardContent className="p-3">
                <p className="font-medium text-sm truncate">{swatch?.name || 'Variante'}</p>
                {swatch?.sku_suffix && (
                  <p className="text-xs font-mono text-muted-foreground">{swatch.sku_suffix}</p>
                )}
                <p className="text-xs text-muted-foreground truncate">
                  {hero?.shot_type} &middot; {r.project?.name || 'Proyecto'}
                </p>
                {r.qa_score != null && (
                  <p className="text-xs text-muted-foreground">QA: {(r.qa_score * 100).toFixed(0)}%</p>
                )}
                <div className="flex gap-1.5 mt-2">
                  <a href={r.image_url} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm" className="h-7 text-xs">
                      <ExternalLink className="h-3 w-3 mr-1" />
                      Ver
                    </Button>
                  </a>
                  <a href={r.image_url} download>
                    <Button variant="outline" size="sm" className="h-7 text-xs">
                      <Download className="h-3 w-3 mr-1" />
                      Descargar
                    </Button>
                  </a>
                  {r.project && (
                    <Link href={`/projects/${r.project.id}/results`}>
                      <Button variant="ghost" size="sm" className="h-7 text-xs">
                        Proyecto
                      </Button>
                    </Link>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {searched && results.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No se encontraron imagenes para esta busqueda
        </div>
      )}
    </div>
  );
}
