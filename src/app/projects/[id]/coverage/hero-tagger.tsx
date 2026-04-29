'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

interface Hero {
  id: string;
  filename: string;
  storage_path: string;
  shot_type: string | null;
  applies_to_designs: string[] | null;
  applies_to_sizes: string[] | null;
}

interface Design {
  slug: string;
  name: string;
}

interface Props {
  projectId: string;
  heroes: Hero[];
  designs: Design[];
  sizes: string[];
}

export function HeroTagger({ projectId, heroes, designs, sizes }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<Record<string, { designs: Set<string>; sizes: Set<string>; saving: boolean }>>(
    () => {
      const init: Record<string, { designs: Set<string>; sizes: Set<string>; saving: boolean }> = {};
      for (const h of heroes) {
        init[h.id] = {
          designs: new Set(h.applies_to_designs || []),
          sizes: new Set(h.applies_to_sizes || []),
          saving: false,
        };
      }
      return init;
    }
  );

  function toggle(heroId: string, kind: 'designs' | 'sizes', value: string) {
    setEditing((prev) => {
      const cur = prev[heroId];
      const next = new Set(cur[kind]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [heroId]: { ...cur, [kind]: next } };
    });
  }

  async function save(heroId: string) {
    const cur = editing[heroId];
    setEditing((prev) => ({ ...prev, [heroId]: { ...prev[heroId], saving: true } }));
    try {
      const res = await fetch(`/api/projects/${projectId}/heroes/${heroId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          applies_to_designs: Array.from(cur.designs),
          applies_to_sizes: Array.from(cur.sizes),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (typeof err.error === 'string' && err.error.includes('column')) {
          toast.error('Faltan columnas en hero_shots — aplicá la migración 015');
        } else {
          toast.error(`Error: ${err.error || res.status}`);
        }
        return;
      }
      toast.success('Tags guardados');
      router.refresh();
    } finally {
      setEditing((prev) => ({ ...prev, [heroId]: { ...prev[heroId], saving: false } }));
    }
  }

  return (
    <div className="mt-8 space-y-3">
      <h2 className="text-lg font-semibold">Heros · etiquetar</h2>
      <p className="text-sm text-muted-foreground">
        Marcá a qué diseños y tamaños aplica cada hero. Sin marcas = genérico (aplica a todos).
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        {heroes.map((h) => {
          const state = editing[h.id];
          const isGeneric = state.designs.size === 0 && state.sizes.size === 0;
          return (
            <Card key={h.id}>
              <CardHeader className="flex flex-row items-center gap-3 pb-3">
                <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded bg-gray-100">
                  {h.storage_path && (
                    <img
                      src={`${SUPABASE_URL}/storage/v1/object/public/images/${h.storage_path}`}
                      alt={h.filename}
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <CardTitle className="truncate text-sm">{h.filename}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {h.shot_type}
                    {isGeneric ? ' · genérico' : ''}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Diseños</div>
                  <div className="flex flex-wrap gap-1">
                    {designs.map((d) => {
                      const on = state.designs.has(d.slug);
                      return (
                        <Badge
                          key={d.slug}
                          variant={on ? 'default' : 'outline'}
                          onClick={() => toggle(h.id, 'designs', d.slug)}
                          className="cursor-pointer text-[10px]"
                        >
                          {on && <Check className="mr-1 h-3 w-3" />}
                          {d.name}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Tamaños</div>
                  <div className="flex flex-wrap gap-1">
                    {sizes.map((s) => {
                      const on = state.sizes.has(s);
                      return (
                        <Badge
                          key={s}
                          variant={on ? 'default' : 'outline'}
                          onClick={() => toggle(h.id, 'sizes', s)}
                          className="cursor-pointer text-[10px]"
                        >
                          {on && <Check className="mr-1 h-3 w-3" />}
                          {s}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
                <Button size="sm" onClick={() => save(h.id)} disabled={state.saving} className="w-full">
                  {state.saving ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                  Guardar
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
