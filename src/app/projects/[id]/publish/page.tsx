'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft, ExternalLink, Save, Loader2, Plus, X, ChevronUp, ChevronDown,
  RefreshCw, Image as ImageIcon, ArrowRight,
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
  swatch_id: string;
  swatch_name: string;
  sku: string;
  item_id: string;
  titulo: string;
  status: string;
  permalink: string;
  ml_pictures: MlPicture[];
  generated_images: GeneratedImage[];
}

interface ListingState {
  listing: Listing;
  pictures: EditorPicture[];
  dirty: boolean;
  saving: boolean;
  selectedGenerated: GeneratedImage | null; // Currently selected image to insert
}

export default function PublishPage() {
  const { id } = useParams<{ id: string }>();
  const [listings, setListings] = useState<ListingState[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchListings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${id}/ml-listings`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setListings(data.map((l: Listing) => ({
          listing: l,
          pictures: l.ml_pictures.map((p) => ({ type: 'ml' as const, id: p.id, url: p.url })),
          dirty: false,
          saving: false,
          selectedGenerated: null,
        })));
      }
    } catch { toast.error('Error cargando publicaciones'); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { fetchListings(); }, [fetchListings]);

  // Select a generated image for insertion
  function selectGenerated(listingIdx: number, img: GeneratedImage | null) {
    setListings((prev) => prev.map((ls, i) =>
      i === listingIdx ? { ...ls, selectedGenerated: ls.selectedGenerated?.job_id === img?.job_id ? null : img } : ls
    ));
  }

  // Insert selected image at a specific position
  function insertAtPosition(listingIdx: number, position: number) {
    setListings((prev) => prev.map((ls, i) => {
      if (i !== listingIdx || !ls.selectedGenerated) return ls;
      if (ls.pictures.length >= 10) { toast.error('Maximo 10 fotos'); return ls; }
      if (ls.pictures.some((p) => p.source_url === ls.selectedGenerated!.url)) {
        toast.info('Ya esta agregada');
        return ls;
      }
      const pics = [...ls.pictures];
      pics.splice(position, 0, {
        type: 'generated',
        url: ls.selectedGenerated.url,
        source_url: ls.selectedGenerated.url,
        shot_type: ls.selectedGenerated.shot_type,
      });
      return { ...ls, pictures: pics, dirty: true, selectedGenerated: null };
    }));
  }

  // Add at end (quick add)
  function addAtEnd(listingIdx: number, img: GeneratedImage) {
    setListings((prev) => prev.map((ls, i) => {
      if (i !== listingIdx) return ls;
      if (ls.pictures.length >= 10) { toast.error('Maximo 10 fotos'); return ls; }
      if (ls.pictures.some((p) => p.source_url === img.url)) { toast.info('Ya esta agregada'); return ls; }
      return {
        ...ls,
        pictures: [...ls.pictures, { type: 'generated', url: img.url, source_url: img.url, shot_type: img.shot_type }],
        dirty: true,
      };
    }));
  }

  function removePicture(listingIdx: number, picIdx: number) {
    setListings((prev) => prev.map((ls, i) => {
      if (i !== listingIdx) return ls;
      return { ...ls, pictures: ls.pictures.filter((_, pi) => pi !== picIdx), dirty: true };
    }));
  }

  function movePicture(listingIdx: number, picIdx: number, direction: -1 | 1) {
    setListings((prev) => prev.map((ls, i) => {
      if (i !== listingIdx) return ls;
      const newIdx = picIdx + direction;
      if (newIdx < 0 || newIdx >= ls.pictures.length) return ls;
      const pics = [...ls.pictures];
      [pics[picIdx], pics[newIdx]] = [pics[newIdx], pics[picIdx]];
      return { ...ls, pictures: pics, dirty: true };
    }));
  }

  async function saveListing(listingIdx: number) {
    const ls = listings[listingIdx];
    if (!ls.listing.item_id) { toast.error('No hay item_id de ML'); return; }
    setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, saving: true } : l));

    const pictures = ls.pictures.map((p) => {
      if (p.type === 'ml' && p.id) return { id: p.id };
      return { source: p.source_url || p.url };
    });

    try {
      const res = await fetch('/api/ml/update-pictures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: ls.listing.item_id, pictures }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`${ls.listing.swatch_name}: ${pictures.length} fotos guardadas`);
        setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, dirty: false, saving: false } : l));
      } else {
        toast.error(`Error: ${data.error}`);
        setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, saving: false } : l));
      }
    } catch {
      toast.error('Error de conexion');
      setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, saving: false } : l));
    }
  }

  async function saveAll() {
    const dirtyIdxs = listings.map((l, i) => l.dirty ? i : -1).filter((i) => i >= 0);
    if (!dirtyIdxs.length) { toast.info('No hay cambios'); return; }
    for (const idx of dirtyIdxs) { await saveListing(idx); }
  }

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const dirtyCount = listings.filter((l) => l.dirty).length;

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href={`/projects/${id}`} className="mb-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-4 w-4" /> Volver al Proyecto
          </Link>
          <h1 className="text-2xl font-bold">Gestionar Publicaciones ML</h1>
          <p className="text-muted-foreground">{listings.length} variantes</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchListings}><RefreshCw className="mr-2 h-4 w-4" /> Refrescar</Button>
          {dirtyCount > 0 && <Button onClick={saveAll}><Save className="mr-2 h-4 w-4" /> Guardar todos ({dirtyCount})</Button>}
        </div>
      </div>

      <div className="space-y-6">
        {listings.map((ls, listingIdx) => {
          const hasSelection = !!ls.selectedGenerated;

          return (
            <Card key={ls.listing.swatch_id} className={ls.dirty ? 'ring-2 ring-blue-500' : ''}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-lg">{ls.listing.swatch_name}</CardTitle>
                    <Badge variant="outline" className="font-mono text-xs">{ls.listing.sku}</Badge>
                    {ls.listing.item_id && <Badge variant="secondary" className="text-xs">{ls.listing.item_id}</Badge>}
                    {ls.listing.status && (
                      <Badge variant={ls.listing.status === 'active' ? 'default' : 'secondary'} className="text-xs">{ls.listing.status}</Badge>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {ls.listing.permalink && (
                      <a href={ls.listing.permalink} target="_blank" rel="noopener noreferrer">
                        <Button variant="ghost" size="sm"><ExternalLink className="h-4 w-4" /></Button>
                      </a>
                    )}
                    {ls.dirty && (
                      <Button size="sm" onClick={() => saveListing(listingIdx)} disabled={ls.saving}>
                        {ls.saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        Guardar en ML
                      </Button>
                    )}
                  </div>
                </div>
                {hasSelection && (
                  <div className="mt-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-800 flex items-center gap-2">
                    <ArrowRight className="h-4 w-4" />
                    Haz click en una posicion de la publicacion para insertar la imagen seleccionada
                    <Button variant="ghost" size="sm" className="ml-auto h-6 text-xs" onClick={() => selectGenerated(listingIdx, null)}>Cancelar</Button>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-[1fr_auto_1fr] gap-4">
                  {/* LEFT: Publication images */}
                  <div>
                    <p className="text-sm font-medium mb-2">
                      Publicacion ({ls.pictures.length}/10)
                      {ls.dirty && <span className="text-blue-500 ml-2">modificado</span>}
                    </p>
                    <div className="space-y-1">
                      {/* Insert slot before first image */}
                      {hasSelection && (
                        <button
                          onClick={() => insertAtPosition(listingIdx, 0)}
                          className="w-full h-8 border-2 border-dashed border-blue-400 bg-blue-50 rounded flex items-center justify-center text-xs text-blue-600 hover:bg-blue-100 transition-colors"
                        >
                          <Plus className="h-3 w-3 mr-1" /> Insertar en posicion 1
                        </button>
                      )}

                      {ls.pictures.map((pic, picIdx) => (
                        <div key={picIdx}>
                          <div className="flex items-center gap-2 rounded-lg border p-1.5 group">
                            {/* Position number */}
                            <div className="w-6 text-center text-xs font-bold text-muted-foreground">{picIdx + 1}</div>

                            {/* Thumbnail */}
                            <div className="h-14 w-14 flex-shrink-0 rounded overflow-hidden bg-gray-100">
                              <img src={pic.url} alt={`Pos ${picIdx + 1}`} className="h-full w-full object-cover" />
                            </div>

                            {/* Info */}
                            <div className="flex-1 min-w-0">
                              {pic.type === 'generated' && (
                                <Badge variant="secondary" className="text-[10px] bg-green-100 text-green-800">nueva — {pic.shot_type}</Badge>
                              )}
                              {pic.type === 'ml' && (
                                <span className="text-[10px] text-muted-foreground">{pic.id?.substring(0, 20)}</span>
                              )}
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => movePicture(listingIdx, picIdx, -1)} disabled={picIdx === 0}>
                                <ChevronUp className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => movePicture(listingIdx, picIdx, 1)} disabled={picIdx === ls.pictures.length - 1}>
                                <ChevronDown className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500" onClick={() => removePicture(listingIdx, picIdx)}>
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>

                          {/* Insert slot after each image */}
                          {hasSelection && (
                            <button
                              onClick={() => insertAtPosition(listingIdx, picIdx + 1)}
                              className="w-full h-6 border-2 border-dashed border-blue-300 bg-blue-50/50 rounded flex items-center justify-center text-[10px] text-blue-500 hover:bg-blue-100 hover:border-blue-400 transition-colors mt-1"
                            >
                              <Plus className="h-2.5 w-2.5 mr-0.5" /> Posicion {picIdx + 2}
                            </button>
                          )}
                        </div>
                      ))}

                      {ls.pictures.length === 0 && !hasSelection && (
                        <div className="flex items-center justify-center h-24 text-sm text-muted-foreground border rounded">Sin fotos en ML</div>
                      )}
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="flex items-center"><div className="w-px h-full bg-border" /></div>

                  {/* RIGHT: Generated images */}
                  <div>
                    <p className="text-sm font-medium mb-2">
                      <ImageIcon className="h-4 w-4 inline mr-1" />
                      Generadas ({ls.listing.generated_images.length})
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {ls.listing.generated_images.map((img) => {
                        const alreadyAdded = ls.pictures.some((p) => p.source_url === img.url);
                        const isSelected = ls.selectedGenerated?.job_id === img.job_id;

                        return (
                          <div
                            key={img.job_id}
                            className={`relative group aspect-square rounded overflow-hidden bg-gray-100 border-2 transition-all cursor-pointer
                              ${isSelected ? 'border-blue-500 ring-2 ring-blue-300' : alreadyAdded ? 'border-gray-200 opacity-40' : 'border-gray-200 hover:border-blue-300'}`}
                            onClick={() => !alreadyAdded && selectGenerated(listingIdx, img)}
                          >
                            <img src={img.url} alt={img.shot_type} className="h-full w-full object-cover" />
                            <div className="absolute top-0.5 left-0.5">
                              <Badge variant="secondary" className="h-5 text-[10px] px-1">{img.shot_type}</Badge>
                            </div>
                            {img.qa_score != null && (
                              <div className="absolute top-0.5 right-0.5">
                                <Badge variant="outline" className="h-5 text-[10px] px-1 bg-white/80">{(img.qa_score * 100).toFixed(0)}%</Badge>
                              </div>
                            )}
                            {alreadyAdded && (
                              <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                                <Badge className="bg-green-600 text-[10px]">Agregada</Badge>
                              </div>
                            )}
                            {isSelected && (
                              <div className="absolute bottom-0 inset-x-0 bg-blue-600 text-white text-center text-[10px] py-0.5">
                                Seleccionada — elige posicion
                              </div>
                            )}
                            {!alreadyAdded && !isSelected && (
                              <div className="absolute bottom-0 inset-x-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 py-1">
                                <span className="text-[10px] text-white">Click para seleccionar</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {ls.listing.generated_images.length === 0 && (
                        <div className="col-span-3 flex items-center justify-center h-24 text-sm text-muted-foreground border rounded">Sin imagenes generadas</div>
                      )}
                    </div>

                    {/* Quick add all at end */}
                    {ls.listing.generated_images.filter((img) => !ls.pictures.some((p) => p.source_url === img.url)).length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 w-full text-xs"
                        onClick={() => {
                          for (const img of ls.listing.generated_images) {
                            if (!ls.pictures.some((p) => p.source_url === img.url)) {
                              addAtEnd(listingIdx, img);
                            }
                          }
                        }}
                      >
                        <Plus className="h-3 w-3 mr-1" /> Agregar todas al final
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
