'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, AlertTriangle, CheckCircle, ExternalLink, TrendingUp } from 'lucide-react';

interface PendingAction {
  id: string;
  mandatory: boolean;
  metadata?: Record<string, unknown>;
}

interface PerformanceItem {
  item_id: string;
  title: string;
  status: string;
  thumbnail: string;
  permalink: string;
  price: number;
  available_quantity: number;
  listing_type_id: string;
  health: number | null;
  pending_actions: PendingAction[];
  priority: number;
}

interface PerformanceData {
  total: number;
  with_pending: number;
  items: PerformanceItem[];
}

const ACTION_LABELS: Record<string, string> = {
  // Common ML health actions
  ITEM_PICTURE_QUALITY: 'Mejorar calidad de fotos',
  ITEM_DESCRIPTION: 'Agregar/mejorar descripcion',
  ITEM_ATTRIBUTES: 'Completar atributos',
  ITEM_SHIPPING_MODE: 'Configurar envio',
  ITEM_FREE_SHIPPING: 'Activar envio gratis',
  CATALOG_PRODUCT_ID: 'Vincular a catalogo',
  ITEM_VIDEO: 'Agregar video',
  ITEM_VARIATIONS: 'Agregar variaciones',
  ITEM_LISTING_TYPE: 'Cambiar tipo de publicacion',
  ITEM_PRICE: 'Revisar precio',
  ITEM_STOCK: 'Revisar stock',
  ITEM_TITLE: 'Mejorar titulo',
  MANUFACTURING_TIME: 'Configurar tiempo de fabricacion',
};

function getActionLabel(actionId: string): string {
  return ACTION_LABELS[actionId] || actionId.replace(/_/g, ' ').toLowerCase();
}

function getHealthColor(health: number | null): string {
  if (health === null) return 'text-gray-400';
  if (health >= 0.8) return 'text-green-600';
  if (health >= 0.5) return 'text-yellow-600';
  return 'text-red-600';
}

function getHealthBg(health: number | null): string {
  if (health === null) return 'bg-gray-100';
  if (health >= 0.8) return 'bg-green-50 border-green-200';
  if (health >= 0.5) return 'bg-yellow-50 border-yellow-200';
  return 'bg-red-50 border-red-200';
}

export default function PerformancePage() {
  const [data, setData] = useState<PerformanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'healthy'>('all');

  async function fetchPerformance() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/performance');
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      const result = await resp.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchPerformance();
  }, []);

  const filteredItems = data?.items.filter((item) => {
    if (filter === 'pending') return item.pending_actions.length > 0;
    if (filter === 'healthy') return item.pending_actions.length === 0;
    return true;
  }) || [];

  const totalMandatory = data?.items.reduce(
    (sum, item) => sum + item.pending_actions.filter((a) => a.mandatory).length,
    0
  ) || 0;

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Performance MercadoLibre</h1>
          <p className="text-muted-foreground">
            Salud de publicaciones y acciones pendientes
          </p>
        </div>
        <Button onClick={fetchPerformance} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Consultando...' : 'Actualizar'}
        </Button>
      </div>

      {error && (
        <Card className="mb-6 border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <p className="text-red-700">{error}</p>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid gap-4 md:grid-cols-4 mb-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Publicaciones
                </CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data.total}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Con Acciones Pendientes
                </CardTitle>
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-yellow-600">
                  {data.with_pending}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Acciones Obligatorias
                </CardTitle>
                <AlertTriangle className="h-4 w-4 text-red-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600">{totalMandatory}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Saludables
                </CardTitle>
                <CheckCircle className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">
                  {data.total - data.with_pending}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Filters */}
          <div className="flex gap-2 mb-4">
            {(['all', 'pending', 'healthy'] as const).map((f) => (
              <Button
                key={f}
                variant={filter === f ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? `Todas (${data.total})` :
                 f === 'pending' ? `Pendientes (${data.with_pending})` :
                 `Saludables (${data.total - data.with_pending})`}
              </Button>
            ))}
          </div>

          {/* Items table */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Publicacion</th>
                      <th className="px-4 py-3 text-center font-medium text-muted-foreground">Salud</th>
                      <th className="px-4 py-3 text-center font-medium text-muted-foreground">Precio</th>
                      <th className="px-4 py-3 text-center font-medium text-muted-foreground">Stock</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Acciones Pendientes</th>
                      <th className="px-4 py-3 text-center font-medium text-muted-foreground">Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((item) => (
                      <tr key={item.item_id} className="border-b hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            {item.thumbnail && (
                              <img
                                src={item.thumbnail}
                                alt=""
                                className="h-10 w-10 rounded object-cover"
                              />
                            )}
                            <div>
                              <p className="font-medium line-clamp-1">{item.title}</p>
                              <p className="text-xs text-muted-foreground">
                                {item.item_id}
                                {item.status !== 'active' && (
                                  <Badge variant="secondary" className="ml-2 text-xs">
                                    {item.status}
                                  </Badge>
                                )}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`font-bold ${getHealthColor(item.health)}`}>
                            {item.health !== null
                              ? `${Math.round(item.health * 100)}%`
                              : '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center font-mono">
                          ${item.price?.toLocaleString('es-CL')}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={item.available_quantity === 0 ? 'text-red-600 font-bold' : ''}>
                            {item.available_quantity}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {item.pending_actions.length === 0 ? (
                            <span className="text-green-600 text-xs">Sin pendientes</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {item.pending_actions.map((action) => (
                                <Badge
                                  key={action.id}
                                  variant={action.mandatory ? 'destructive' : 'secondary'}
                                  className="text-xs"
                                >
                                  {getActionLabel(action.id)}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <a
                            href={item.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center text-blue-600 hover:text-blue-800"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </td>
                      </tr>
                    ))}
                    {filteredItems.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                          {loading ? 'Cargando...' : 'No hay publicaciones en este filtro'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {!data && !error && !loading && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <TrendingUp className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              Presiona Actualizar para consultar la salud de tus publicaciones
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
