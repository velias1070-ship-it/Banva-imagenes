'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft, ExternalLink, Save, Loader2, Plus, X, ChevronUp, ChevronDown,
  RefreshCw, Image as ImageIcon,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

interface MlPicture {
  id: string;
  url: string;
  size: string;
}

interface GeneratedImage {
  job_id: string;
  url: string;
  storage_path: string;
  shot_type: string;
  qa_score: number | null;
}

// A picture in the editor: either from ML or generated
interface EditorPicture {
  type: 'ml' | 'generated';
  id?: string;        // ML picture id
  url: string;
  source_url?: string; // For generated: the Supabase storage URL to send to ML
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
  pictures: EditorPicture[];  // Current arrangement
  dirty: boolean;
  saving: boolean;
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
          pictures: l.ml_pictures.map((p) => ({
            type: 'ml' as const,
            id: p.id,
            url: p.url,
          })),
          dirty: false,
          saving: false,
        })));
      }
    } catch {
      toast.error('Error cargando publicaciones');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchListings(); }, [fetchListings]);

  function addPicture(listingIdx: number, img: GeneratedImage) {
    setListings((prev) => prev.map((ls, i) => {
      if (i !== listingIdx) return ls;
      if (ls.pictures.length >= 10) {
        toast.error('Maximo 10 fotos por publicacion');
        return ls;
      }
      // Check if already added
      if (ls.pictures.some((p) => p.source_url === img.url)) {
        toast.info('Ya esta agregada');
        return ls;
      }
      return {
        ...ls,
        pictures: [...ls.pictures, {
          type: 'generated' as const,
          url: img.url,
          source_url: img.url,
          shot_type: img.shot_type,
        }],
        dirty: true,
      };
    }));
  }

  function removePicture(listingIdx: number, picIdx: number) {
    setListings((prev) => prev.map((ls, i) => {
      if (i !== listingIdx) return ls;
      return {
        ...ls,
        pictures: ls.pictures.filter((_, pi) => pi !== picIdx),
        dirty: true,
      };
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
    if (!ls.listing.item_id) {
      toast.error('No hay item_id de ML para esta variante');
      return;
    }

    setListings((prev) => prev.map((l, i) => i === listingIdx ? { ...l, saving: true } : l));

    const pictures = ls.pictures.map((p) => {
      if (p.type === 'ml' && p.id) return { id: p.id };
      if (p.source_url) return { source: p.source_url };
      return { source: p.url };
    });

    try {
      const res = await fetch('/api/ml/update-pictures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: ls.listing.item_id, pictures }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`${ls.listing.swatch_name}: ${pictures.length} fotos guardadas en ML`);
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
    if (dirtyIdxs.length === 0) {
      toast.info('No hay cambios por guardar');
      return;
    }
    for (const idx of dirtyIdxs) {
      await saveListing(idx);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
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
          <Button variant="outline" onClick={fetchListings}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refrescar
          </Button>
          {dirtyCount > 0 && (
            <Button onClick={saveAll}>
              <Save className="mr-2 h-4 w-4" /> Guardar todos ({dirtyCount})
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {listings.map((ls, listingIdx) => (
          <Card key={ls.listing.swatch_id} className={ls.dirty ? 'ring-2 ring-blue-500' : ''}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-lg">{ls.listing.swatch_name}</CardTitle>
                  <Badge variant="outline" className="font-mono text-xs">{ls.listing.sku}</Badge>
                  {ls.listing.item_id && (
                    <Badge variant="secondary" className="text-xs">{ls.listing.item_id}</Badge>
                  )}
                  {ls.listing.status && (
                    <Badge variant={ls.listing.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                      {ls.listing.status}
                    </Badge>
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
                      Guardar
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[1fr_auto_1fr] gap-4">
                {/* Left: Current arrangement */}
                <div>
                  <p className="text-sm font-medium mb-2">
                    Publicacion ({ls.pictures.length}/10)
                    {ls.dirty && <span className="text-blue-500 ml-2">modificado</span>}
                  </p>
                  <div className="grid grid-cols-5 gap-2">
                    {ls.pictures.map((pic, picIdx) => (
                      <div key={picIdx} className="relative group aspect-square rounded overflow-hidden bg-gray-100 border">
                        <img src={pic.url} alt={`Pos ${picIdx + 1}`} className="h-full w-full object-cover" />
                        <div className="absolute top-0.5 left-0.5">
                          <Badge className="h-5 text-[10px] px-1">{picIdx + 1}</Badge>
                        </div>
                        {pic.type === 'generated' && (
                          <div className="absolute top-0.5 right-0.5">
                            <Badge variant="secondary" className="h-5 text-[10px] px-1 bg-green-100 text-green-800">new</Badge>
                          </div>
                        )}
                        <div className="absolute bottom-0 inset-x-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-0.5 py-0.5">
                          <Button
                            variant="ghost" size="sm" className="h-6 w-6 p-0 text-white hover:bg-white/20"
                            onClick={() => movePicture(listingIdx, picIdx, -1)}
                            disabled={picIdx === 0}
                          >
                            <ChevronUp className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost" size="sm" className="h-6 w-6 p-0 text-white hover:bg-white/20"
                            onClick={() => movePicture(listingIdx, picIdx, 1)}
                            disabled={picIdx === ls.pictures.length - 1}
                          >
                            <ChevronDown className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-400 hover:bg-white/20"
                            onClick={() => removePicture(listingIdx, picIdx)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    {ls.pictures.length === 0 && (
                      <div className="col-span-5 flex items-center justify-center h-24 text-sm text-muted-foreground border rounded">
                        Sin fotos en ML
                      </div>
                    )}
                  </div>
                </div>

                {/* Divider */}
                <div className="flex items-center">
                  <div className="w-px h-full bg-border" />
                </div>

                {/* Right: Generated images available to add */}
                <div>
                  <p className="text-sm font-medium mb-2">
                    <ImageIcon className="h-4 w-4 inline mr-1" />
                    Generadas ({ls.listing.generated_images.length})
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {ls.listing.generated_images.map((img) => {
                      const alreadyAdded = ls.pictures.some((p) => p.source_url === img.url);
                      return (
                        <div key={img.job_id} className={`relative group aspect-square rounded overflow-hidden bg-gray-100 border ${alreadyAdded ? 'opacity-40' : ''}`}>
                          <img src={img.url} alt={img.shot_type} className="h-full w-full object-cover" />
                          <div className="absolute top-0.5 left-0.5">
                            <Badge variant="secondary" className="h-5 text-[10px] px-1">{img.shot_type}</Badge>
                          </div>
                          {img.qa_score != null && (
                            <div className="absolute top-0.5 right-0.5">
                              <Badge variant="outline" className="h-5 text-[10px] px-1 bg-white/80">
                                {(img.qa_score * 100).toFixed(0)}%
                              </Badge>
                            </div>
                          )}
                          {!alreadyAdded && (
                            <div className="absolute bottom-0 inset-x-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center py-1">
                              <Button
                                variant="ghost" size="sm" className="h-6 text-xs text-white hover:bg-white/20"
                                onClick={() => addPicture(listingIdx, img)}
                              >
                                <Plus className="h-3 w-3 mr-1" /> Agregar
                              </Button>
                            </div>
                          )}
                          {alreadyAdded && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <Badge className="bg-green-600 text-xs">Agregada</Badge>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {ls.listing.generated_images.length === 0 && (
                      <div className="col-span-4 flex items-center justify-center h-24 text-sm text-muted-foreground border rounded">
                        Sin imagenes generadas
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
