'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft, ExternalLink, Save, Loader2, Plus, X,
  RefreshCw, Image as ImageIcon, GripVertical, Copy, RotateCcw,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

interface MlPicture { id: string; url: string; size: string }
interface GeneratedImage { job_id: string; url: string; storage_path: string; shot_type: string; qa_score: number | null }

interface EditorPicture {
  type: 'ml' | 'generated';
  id?: string;
  url: string;
  source_url?: string;
  shot_type?: string;
}

interface Listing {
  swatch_id: string; swatch_name: string; sku: string; item_id: string;
  titulo: string; status: string; permalink: string;
  ml_pictures: MlPicture[]; generated_images: GeneratedImage[];
}

interface ListingState {
  listing: Listing; pictures: EditorPicture[];
  dirty: boolean; saving: boolean;
}

type DragSource =
  | { kind: 'reorder'; listingIdx: number; picIdx: number }
  | { kind: 'add'; listingIdx: number; img: GeneratedImage };

export default function PublishPage() {
  const { id } = useParams<{ id: string }>();
  const [listings, setListings] = useState<ListingState[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [dropPosition, setDropPosition] = useState<{ listingIdx: number; position: number } | null>(null);
  const dragRef = useRef<DragSource | null>(null);
  const [replicateSource, setReplicateSource] = useState<number | null>(null);
  const [replicating, setReplicating] = useState(false);
  const [regeneratingJobs, setRegeneratingJobs] = useState<Set<string>>(new Set());

  const fetchListings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${id}/ml-listings`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setListings(data.map((l: Listing) => ({
          listing: l,
          pictures: l.ml_pictures.map((p) => ({ type: 'ml' as const, id: p.id, url: p.url })),
          dirty: false, saving: false,
        })));
      }
    } catch { toast.error('Error cargando publicaciones'); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { fetchListings(); }, [fetchListings]);

  function handleDragStart(e: React.DragEvent, source: DragSource) {
    dragRef.current = source;
    setDragging(true);
    e.dataTransfer.effectAllowed = source.kind === 'reorder' ? 'move' : 'copy';
    // Use a transparent drag image for smoother feel
    const el = e.currentTarget as HTMLElement;
    if (el) {
      e.dataTransfer.setDragImage(el, 30, 30);
    }
  }

  function handleDragEnd() {
    dragRef.current = null;
    setDragging(false);
    setDropPosition(null);
  }

  function getDropPosition(e: React.DragEvent, listingIdx: number, container: HTMLElement): number {
    const children = Array.from(container.querySelectorAll('[data-pic-idx]'));
    const mouseY = e.clientY;

    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (mouseY < midY) return i;
    }
    return children.length;
  }

  function handleContainerDragOver(e: React.DragEvent, listingIdx: number) {
    e.preventDefault();
    const drag = dragRef.current;
    if (!drag || drag.listingIdx !== listingIdx) return;

    const container = e.currentTarget as HTMLElement;
    const pos = getDropPosition(e, listingIdx, container);
    setDropPosition({ listingIdx, position: pos });
  }

  function handleContainerDrop(e: React.DragEvent, listingIdx: number) {
    e.preventDefault();
    const drag = dragRef.current;
    if (!drag || drag.listingIdx !== listingIdx) return;

    const container = e.currentTarget as HTMLElement;
    const position = getDropPosition(e, listingIdx, container);

    if (drag.kind === 'reorder') {
      setListings((prev) => prev.map((ls, i) => {
        if (i !== listingIdx) return ls;
        const pics = [...ls.pictures];
        const [moved] = pics.splice(drag.picIdx, 1);
        const insertAt = position > drag.picIdx ? position - 1 : position;
        pics.splice(insertAt, 0, moved);
        return { ...ls, pictures: pics, dirty: true };
      }));
    } else if (drag.kind === 'add') {
      setListings((prev) => prev.map((ls, i) => {
        if (i !== listingIdx) return ls;
        if (ls.pictures.length >= 10) { toast.error('Maximo 10 fotos'); return ls; }
        if (ls.pictures.some((p) => p.source_url === drag.img.url)) { toast.info('Ya agregada'); return ls; }
        const pics = [...ls.pictures];
        pics.splice(position, 0, {
          type: 'generated', url: drag.img.url, source_url: drag.img.url, shot_type: drag.img.shot_type,
        });
        return { ...ls, pictures: pics, dirty: true };
      }));
    }

    handleDragEnd();
  }

  function removePicture(listingIdx: number, picIdx: number) {
    setListings((prev) => prev.map((ls, i) =>
      i !== listingIdx ? ls : { ...ls, pictures: ls.pictures.filter((_, pi) => pi !== picIdx), dirty: true }
    ));
  }

  function addAtEnd(listingIdx: number, img: GeneratedImage) {
    setListings((prev) => prev.map((ls, i) => {
      if (i !== listingIdx) return ls;
      if (ls.pictures.length >= 10) { toast.error('Maximo 10 fotos'); return ls; }
      if (ls.pictures.some((p) => p.source_url === img.url)) { toast.info('Ya agregada'); return ls; }
      return { ...ls, pictures: [...ls.pictures, { type: 'generated', url: img.url, source_url: img.url, shot_type: img.shot_type }], dirty: true };
    }));
  }

  async function saveListing(listingIdx: number) {
    const ls = listings[listingIdx];
    if (!ls.listing.item_id) { toast.error('No hay item_id'); return; }
    setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, saving: true } : l));
    const pictures = ls.pictures.map((p) => p.type === 'ml' && p.id ? { id: p.id } : { source: p.source_url || p.url });
    try {
      const res = await fetch('/api/ml/update-pictures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_id: ls.listing.item_id, pictures }) });
      const data = await res.json();
      if (data.success) {
        toast.success(`${ls.listing.swatch_name}: ${pictures.length} fotos guardadas`);
        setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, dirty: false, saving: false } : l));
      } else {
        toast.error(`Error: ${data.error}`);
        setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, saving: false } : l));
      }
    } catch { toast.error('Error de conexion'); setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, saving: false } : l)); }
  }

  async function handleRegenerate(jobId: string) {
    setRegeneratingJobs((prev) => new Set(prev).add(jobId));
    try {
      const res = await fetch(`/api/projects/${id}/results/${jobId}`, { method: 'POST' });
      if (res.ok) {
        toast.success('Regenerando imagen — se actualizara automaticamente');
        // Poll until done
        const poll = setInterval(async () => {
          const updated = await fetch(`/api/projects/${id}/results`);
          if (updated.ok) {
            const allJobs = await updated.json();
            const job = allJobs.find((j: { id: string }) => j.id === jobId);
            if (job && !['generating', 'qa_pending', 'qa_processing', 'pending'].includes(job.status)) {
              clearInterval(poll);
              setRegeneratingJobs((prev) => { const next = new Set(prev); next.delete(jobId); return next; });
              if (job.status === 'approved') {
                toast.success('Imagen regenerada y aprobada');
              } else {
                toast.error(`Regeneracion termino con estado: ${job.status}`);
              }
              fetchListings(); // Refresh all data
            }
          }
        }, 5000);
      } else {
        toast.error('Error iniciando regeneracion');
        setRegeneratingJobs((prev) => { const next = new Set(prev); next.delete(jobId); return next; });
      }
    } catch {
      toast.error('Error de conexion');
      setRegeneratingJobs((prev) => { const next = new Set(prev); next.delete(jobId); return next; });
    }
  }

  async function saveAll() {
    const dirty = listings.map((l, i) => l.dirty ? i : -1).filter((i) => i >= 0);
    if (!dirty.length) { toast.info('No hay cambios'); return; }
    for (const idx of dirty) { await saveListing(idx); }
  }

  async function replicatePictures(sourceIdx: number, targetSkus: string[]) {
    const source = listings[sourceIdx];
    if (!source.listing.sku) return;
    if (!targetSkus.length) { toast.error('No hay destinos validos'); return; }

    setReplicating(true);
    try {
      const res = await fetch('/api/ml/replicate-pictures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_sku: source.listing.sku, target_skus: targetSkus }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`${data.source.pictures} fotos replicadas a ${data.success} publicaciones`);
        if (data.errors > 0) toast.error(`${data.errors} errores al replicar`);
        fetchListings();
      } else {
        toast.error(data.error || 'Error al replicar');
      }
    } catch { toast.error('Error de conexion'); }
    finally { setReplicating(false); setReplicateSource(null); }
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

  const dirtyCount = listings.filter((l) => l.dirty).length;

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href={`/projects/${id}`} className="mb-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-4 w-4" /> Volver al Proyecto
          </Link>
          <h1 className="text-2xl font-bold">Gestionar Publicaciones ML</h1>
          <p className="text-muted-foreground">{listings.length} variantes — arrastra las fotos para reordenar</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchListings}><RefreshCw className="mr-2 h-4 w-4" /> Refrescar</Button>
          {dirtyCount > 0 && <Button onClick={saveAll}><Save className="mr-2 h-4 w-4" /> Guardar todos ({dirtyCount})</Button>}
        </div>
      </div>

      <div className="space-y-6">
        {listings.map((ls, listingIdx) => (
          <Card key={ls.listing.swatch_id} className={ls.dirty ? 'ring-2 ring-blue-500' : ''}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-wrap">
                  <CardTitle className="text-lg">{ls.listing.swatch_name}</CardTitle>
                  <Badge variant="outline" className="font-mono text-xs">{ls.listing.sku}</Badge>
                  {ls.listing.item_id && <Badge variant="secondary" className="text-xs">{ls.listing.item_id}</Badge>}
                  {ls.listing.status && <Badge variant={ls.listing.status === 'active' ? 'default' : 'secondary'} className="text-xs">{ls.listing.status}</Badge>}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {ls.listing.permalink && <a href={ls.listing.permalink} target="_blank" rel="noopener noreferrer"><Button variant="ghost" size="sm"><ExternalLink className="h-4 w-4" /></Button></a>}
                  {ls.listing.ml_pictures.length > 0 && (
                    <Button
                      variant="outline" size="sm"
                      onClick={() => setReplicateSource(replicateSource === listingIdx ? null : listingIdx)}
                      disabled={replicating}
                      className={replicateSource === listingIdx ? 'border-purple-500 text-purple-700' : ''}
                    >
                      <Copy className="mr-1 h-3.5 w-3.5" /> Replicar
                    </Button>
                  )}
                  {ls.dirty && (
                    <Button size="sm" onClick={() => saveListing(listingIdx)} disabled={ls.saving}>
                      {ls.saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Guardar en ML
                    </Button>
                  )}
                </div>
              </div>
              {/* Replicate panel */}
              {replicateSource === listingIdx && (
                <ReplicatePanel
                  sourceSku={ls.listing.sku}
                  sourceName={ls.listing.swatch_name}
                  pictureCount={ls.listing.ml_pictures.length}
                  replicating={replicating}
                  onReplicate={(targetSkus) => replicatePictures(listingIdx, targetSkus)}
                  onCancel={() => setReplicateSource(null)}
                />
              )}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[1fr_auto_1fr] gap-6">
                {/* LEFT: listing images with full-container drop zone */}
                <div>
                  <p className="text-sm font-medium mb-2">Publicacion ({ls.pictures.length}/10){ls.dirty && <span className="text-blue-500 ml-2">modificado</span>}</p>
                  <div
                    className={`min-h-[80px] rounded-lg p-1 transition-colors ${dragging && dragRef.current?.listingIdx === listingIdx ? 'bg-blue-50/50' : ''}`}
                    onDragOver={(e) => handleContainerDragOver(e, listingIdx)}
                    onDragLeave={() => setDropPosition(null)}
                    onDrop={(e) => handleContainerDrop(e, listingIdx)}
                  >
                    {ls.pictures.map((pic, picIdx) => {
                      const isDropBefore = dropPosition?.listingIdx === listingIdx && dropPosition?.position === picIdx;
                      const isDropAfter = dropPosition?.listingIdx === listingIdx && dropPosition?.position === picIdx + 1 && picIdx === ls.pictures.length - 1;
                      const isDragSource = dragRef.current?.kind === 'reorder' && dragRef.current.listingIdx === listingIdx && dragRef.current.picIdx === picIdx;

                      return (
                        <div key={picIdx} data-pic-idx={picIdx}>
                          {isDropBefore && <div className="h-1.5 bg-blue-500 rounded-full mx-2 my-1 animate-pulse" />}
                          <div
                            className={`flex items-center gap-2 rounded-lg border p-1.5 group transition-all mb-1
                              ${isDragSource ? 'opacity-30 scale-95' : 'opacity-100'}
                              ${isDropBefore || isDropAfter ? '' : ''}`}
                            draggable
                            onDragStart={(e) => handleDragStart(e, { kind: 'reorder', listingIdx, picIdx })}
                            onDragEnd={handleDragEnd}
                          >
                            <GripVertical className="h-4 w-4 text-muted-foreground/40 flex-shrink-0 cursor-grab active:cursor-grabbing" />
                            <div className="w-5 text-center text-xs font-bold text-muted-foreground">{picIdx + 1}</div>
                            <div className="h-12 w-12 flex-shrink-0 rounded overflow-hidden bg-gray-100">
                              <img src={pic.url} alt="" className="h-full w-full object-cover pointer-events-none" />
                            </div>
                            <div className="flex-1 min-w-0">
                              {pic.type === 'generated'
                                ? <Badge variant="secondary" className="text-[10px] bg-green-100 text-green-800">nueva — {pic.shot_type}</Badge>
                                : <span className="text-[10px] text-muted-foreground">ML</span>}
                            </div>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => removePicture(listingIdx, picIdx)}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          {isDropAfter && <div className="h-1.5 bg-blue-500 rounded-full mx-2 my-1 animate-pulse" />}
                        </div>
                      );
                    })}

                    {ls.pictures.length === 0 && (
                      <div className={`flex items-center justify-center h-24 text-sm border-2 border-dashed rounded-lg transition-colors ${dragging ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-gray-200 text-muted-foreground'}`}>
                        {dragging ? 'Soltar aqui' : 'Sin fotos — arrastra desde la derecha'}
                      </div>
                    )}

                    {/* Bottom drop indicator */}
                    {dropPosition?.listingIdx === listingIdx && dropPosition.position === ls.pictures.length && ls.pictures.length > 0 && (
                      <div className="h-1.5 bg-blue-500 rounded-full mx-2 my-1 animate-pulse" />
                    )}
                  </div>
                </div>

                <div className="flex items-center"><div className="w-px h-full bg-border" /></div>

                {/* RIGHT: generated images */}
                <div>
                  <p className="text-sm font-medium mb-2"><ImageIcon className="h-4 w-4 inline mr-1" />Generadas ({ls.listing.generated_images.length})</p>
                  <div className="grid grid-cols-3 gap-2">
                    {ls.listing.generated_images.map((img) => {
                      const added = ls.pictures.some((p) => p.source_url === img.url);
                      return (
                        <div
                          key={img.job_id}
                          draggable={!added}
                          onDragStart={(e) => handleDragStart(e, { kind: 'add', listingIdx, img })}
                          onDragEnd={handleDragEnd}
                          className={`relative group aspect-square rounded-lg overflow-hidden bg-gray-100 border-2 transition-all
                            ${added ? 'border-green-200 opacity-40 cursor-default' : 'border-gray-200 cursor-grab active:cursor-grabbing hover:border-blue-300 hover:shadow-md'}`}
                        >
                          <img src={img.url} alt={img.shot_type} className="h-full w-full object-cover pointer-events-none" />
                          <div className="absolute top-1 left-1"><Badge variant="secondary" className="text-[10px] px-1 h-5">{img.shot_type}</Badge></div>
                          {img.qa_score != null && <div className="absolute top-1 right-1"><Badge variant="outline" className="text-[10px] px-1 h-5 bg-white/80">{(img.qa_score * 100).toFixed(0)}%</Badge></div>}
                          {regeneratingJobs.has(img.job_id) ? (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                              <div className="flex items-center gap-1 text-white text-[10px]"><RotateCcw className="h-3 w-3 animate-spin" /> Regenerando...</div>
                            </div>
                          ) : added ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/20 gap-1">
                              <Badge className="bg-green-600 text-[10px]">Agregada</Badge>
                              <Button variant="ghost" size="sm" className="h-5 text-[10px] text-white hover:bg-white/20" onClick={(e) => { e.stopPropagation(); handleRegenerate(img.job_id); }}>
                                <RotateCcw className="h-2.5 w-2.5 mr-0.5" /> Regenerar
                              </Button>
                            </div>
                          ) : (
                            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-2 pt-6 flex items-end justify-center gap-1">
                              <Button variant="ghost" size="sm" className="h-5 text-[10px] text-white px-1.5 hover:bg-white/20" onClick={(e) => { e.stopPropagation(); addAtEnd(listingIdx, img); }}>
                                <Plus className="h-2.5 w-2.5 mr-0.5" />al final
                              </Button>
                              <Button variant="ghost" size="sm" className="h-5 text-[10px] text-white px-1.5 hover:bg-white/20" onClick={(e) => { e.stopPropagation(); handleRegenerate(img.job_id); }}>
                                <RotateCcw className="h-2.5 w-2.5 mr-0.5" />regenerar
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {ls.listing.generated_images.length === 0 && (
                      <div className="col-span-3 flex items-center justify-center h-24 text-sm text-muted-foreground border rounded-lg">Sin imagenes generadas</div>
                    )}
                  </div>
                  {ls.listing.generated_images.filter((img) => !ls.pictures.some((p) => p.source_url === img.url)).length > 1 && (
                    <Button variant="outline" size="sm" className="mt-3 w-full text-xs" onClick={() => { for (const img of ls.listing.generated_images) addAtEnd(listingIdx, img); }}>
                      <Plus className="h-3 w-3 mr-1" /> Agregar todas al final
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// --- Replicate Panel ---
interface RelatedItem { sku_venta: string; titulo: string; group: string }

function ReplicatePanel({
  sourceSku, sourceName, pictureCount, replicating, onReplicate, onCancel,
}: {
  sourceSku: string;
  sourceName: string;
  pictureCount: number;
  replicating: boolean;
  onReplicate: (targetSkus: string[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [related, setRelated] = useState<RelatedItem[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(true);

  // Fetch related listings from ml_items_map via the debug endpoint
  useEffect(() => {
    async function fetchRelated() {
      setLoadingRelated(true);
      try {
        // Get SKU prefix — strip last 2 chars (color code) to find same product line
        // e.g. TXV23QLAT25BE → TXV23QLAT (all Atenas sizes + colors)
        // Try progressively shorter prefixes to find related items
        const prefixes: string[] = [];
        // Remove color suffix (usually 2 chars)
        const withoutColor = sourceSku.replace(/[A-Z]{2}$/, '');
        prefixes.push(withoutColor); // Same product+size, different color
        // Remove size (usually 2 digits before color)
        const withoutSize = withoutColor.replace(/\d{2}$/, '');
        if (withoutSize.length >= 6) prefixes.push(withoutSize); // Same product, all sizes

        const allItems: RelatedItem[] = [];
        const seen = new Set<string>();
        seen.add(sourceSku);

        for (const prefix of prefixes) {
          const res = await fetch(`/api/ml/debug?path=/users/1953806321/items/search?seller_sku=${prefix}*%26limit=50`);
          // Fallback: search via our productos API or directly in ml_items_map
        }

        // Use a simpler approach: call a search on ml_items_map
        const searchRes = await fetch(`/api/productos`);
        const productos = await searchRes.json();

        if (Array.isArray(productos)) {
          // Find all groups that contain the source SKU
          for (const group of productos) {
            const hasSource = group.variantes.some((v: { sku: string }) => v.sku === sourceSku);
            if (!hasSource) continue;

            // This group contains the source — all other variants are related
            for (const v of group.variantes) {
              if (v.sku === sourceSku || seen.has(v.sku)) continue;
              seen.add(v.sku);
              allItems.push({ sku_venta: v.sku, titulo: `${group.base_name} ${v.color} (${group.tamano})`, group: group.tamano || 'mismo tamano' });
            }
          }

          // Also find same color in OTHER sizes (different groups with same base product)
          const sourceGroup = productos.find((g: { variantes: { sku: string }[] }) => g.variantes.some((v: { sku: string }) => v.sku === sourceSku));
          if (sourceGroup) {
            const baseWords = sourceGroup.base_name.split(/\s+/).filter((w: string) => w.length > 3);
            for (const group of productos) {
              if (group.tamano === sourceGroup.tamano) continue; // Already covered above
              const nameMatches = baseWords.every((w: string) => group.base_name.toLowerCase().includes(w.toLowerCase()));
              if (!nameMatches) continue;

              for (const v of group.variantes) {
                if (seen.has(v.sku)) continue;
                seen.add(v.sku);
                allItems.push({ sku_venta: v.sku, titulo: `${group.base_name} ${v.color} (${group.tamano})`, group: group.tamano || 'otro tamano' });
              }
            }
          }
        }

        setRelated(allItems);
      } catch { /* ignore */ }
      finally { setLoadingRelated(false); }
    }
    fetchRelated();
  }, [sourceSku]);

  function toggle(sku: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  }

  function selectGroup(group: string) {
    const skus = related.filter((r) => r.group === group).map((r) => r.sku_venta);
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = skus.every((s) => next.has(s));
      if (allSelected) { skus.forEach((s) => next.delete(s)); }
      else { skus.forEach((s) => next.add(s)); }
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(related.map((r) => r.sku_venta)));
  }

  // Group by tamano/size
  const groups = new Map<string, RelatedItem[]>();
  for (const item of related) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group)!.push(item);
  }

  return (
    <div className="mt-3 rounded-lg border border-purple-200 bg-purple-50 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium text-purple-800">
          Replicar {pictureCount} fotos de <span className="font-bold">{sourceName} ({sourceSku})</span> a:
        </p>
        <div className="flex gap-2">
          {related.length > 0 && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={selectAll}>Seleccionar todas ({related.length})</Button>}
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>Cancelar</Button>
        </div>
      </div>

      {loadingRelated ? (
        <div className="flex items-center gap-2 text-sm text-purple-600 py-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Buscando publicaciones relacionadas...
        </div>
      ) : related.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No se encontraron publicaciones relacionadas</p>
      ) : (
        <>
          {Array.from(groups.entries()).map(([group, items]) => (
            <div key={group} className="mb-2">
              <button className="text-xs text-purple-600 mb-1 hover:underline" onClick={() => selectGroup(group)}>
                {group} ({items.length})
              </button>
              <div className="flex flex-wrap gap-1.5">
                {items.map((item) => (
                  <button
                    key={item.sku_venta}
                    onClick={() => toggle(item.sku_venta)}
                    className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${selected.has(item.sku_venta) ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-purple-700 border-purple-300 hover:bg-purple-100'}`}
                  >
                    {item.titulo}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {selected.size > 0 && (
        <div className="flex gap-2 mt-3">
          <Button
            size="sm"
            disabled={replicating}
            onClick={() => onReplicate(Array.from(selected))}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {replicating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Copy className="mr-2 h-4 w-4" />}
            Replicar a {selected.size} publicacion{selected.size > 1 ? 'es' : ''}
          </Button>
        </div>
      )}
    </div>
  );
}
