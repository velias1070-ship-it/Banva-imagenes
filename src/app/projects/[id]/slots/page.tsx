'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Settings2, Loader2, ImageIcon, ExternalLink, Download, MoveRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface Slot {
  id: string;
  position: number;
  name: string;
  expected_shot_type: string | null;
  size_dependent: boolean;
  notes: string | null;
}

interface SwatchEntry {
  id: string;
  sku_suffix: string | null;
  name: string;
  storage_path: string;
  display_order: number;
  marked_done_at: string | null;
  color: string | null;
  tipo: string | null;
  bed_size: string | null;
  label: string;
  ml_item_id: string | null;
  ml_permalink: string | null;
}

interface Hero {
  id: string;
  filename: string;
  storage_path: string;
  shot_type: string | null;
  display_order: number;
  slot_position: number | null;
  applies_to_designs: string[] | null;
  applies_to_sizes: string[] | null;
}

type CellStatus = 'match' | 'drift' | 'only_ml' | 'only_system' | 'empty';

interface Cell {
  swatch_id: string;
  position: number;
  system: { job_id: string; url: string } | null;
  ml: { ml_picture_id: string; url: string } | null;
  status: CellStatus;
}

interface State {
  slots: Slot[];
  swatches: SwatchEntry[];
  heroes: Hero[];
  cells: Cell[];
}

const STATUS_COLOR: Record<CellStatus, string> = {
  match: 'bg-emerald-500',
  drift: 'bg-amber-500',
  only_ml: 'bg-blue-500',
  only_system: 'bg-orange-500',
  empty: 'bg-rose-500/30',
};

const STATUS_LABEL: Record<CellStatus, string> = {
  match: 'ML = Sistema',
  drift: 'Drift (sistema nuevo, ML viejo)',
  only_ml: 'Solo en ML',
  only_system: 'Solo en sistema',
  empty: 'Vacío',
};

export default function ProjectSlotsPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [editingSlots, setEditingSlots] = useState(false);
  const [hoverCell, setHoverCell] = useState<{ url: string; x: number; y: number } | null>(null);
  const [filterStatus, setFilterStatus] = useState<'all' | CellStatus>('all');
  const [filterTipo, setFilterTipo] = useState<string>('all');
  const [filterColor, setFilterColor] = useState<string>('all');
  const [filterSize, setFilterSize] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMoving, setBulkMoving] = useState(false);
  const [singleMoving, setSingleMoving] = useState<string | null>(null);
  const [generatingSlot, setGeneratingSlot] = useState<number | null>(null);
  const [singleGenerating, setSingleGenerating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${id}/slots/state`);
      const data = await res.json();
      if (res.ok) setState(data);
      else toast.error(data.error || 'Error cargando estado');
    } catch {
      toast.error('Error de red');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleImportMl() {
    setImporting(true);
    try {
      const res = await fetch(`/api/projects/${id}/slots/import-ml`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(`${data.pictures_imported} fotos importadas de ${data.swatches_with_ml} publicaciones ML`);
        await load();
      } else {
        toast.error(data.error || 'Error importando');
      }
    } finally {
      setImporting(false);
    }
  }

  async function handleAdoptFromMl() {
    const onlyMlCount = state?.cells.filter((c) => c.status === 'only_ml').length || 0;
    if (onlyMlCount === 0) {
      toast.info('No hay fotos en ML pendientes de adoptar');
      return;
    }
    if (!confirm(`Adoptar ${onlyMlCount} foto(s) de ML al sistema?\n\nSe descargan y quedan como jobs aprobados (sin gastar Gemini). Después podés replicar a hermanos, marcar listo, etc.`)) {
      return;
    }
    setAdopting(true);
    try {
      const res = await fetch(`/api/projects/${id}/slots/adopt-from-ml`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'only_ml' }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.adopted > 0) {
          toast.success(`${data.adopted} foto(s) adoptadas al sistema${data.error_count ? ` · ${data.error_count} con error` : ''}`);
        } else {
          toast.info(data.message || 'Nada para adoptar');
        }
        await load();
      } else {
        toast.error(data.error || 'Error adoptando');
      }
    } finally {
      setAdopting(false);
    }
  }

  function toggleSelected(swatchId: string, position: number) {
    const key = `${swatchId}|${position}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleColumn(position: number) {
    if (!state) return;
    const cellsInCol = visibleSwatches
      .map((s) => ({ key: `${s.id}|${position}`, hasMl: !!cellByKey.get(`${s.id}|${position}`)?.ml }))
      .filter((c) => c.hasMl);
    if (cellsInCol.length === 0) {
      toast.info('No hay fotos ML en esta columna');
      return;
    }
    const allSelected = cellsInCol.every((c) => selected.has(c.key));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const c of cellsInCol) next.delete(c.key);
      } else {
        for (const c of cellsInCol) next.add(c.key);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function moveCells(moves: Array<{ swatch_id: string; from_position: number; to_position: number }>) {
    const res = await fetch(`/api/projects/${id}/slots/move-ml`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moves }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || 'Error moviendo');
      return false;
    }
    const total = (data.moved || 0) + (data.swapped || 0);
    toast.success(
      `${total} celda(s) actualizada(s)${data.swapped ? ` · ${data.swapped} swap` : ''}${
        data.error_count ? ` · ${data.error_count} error(es)` : ''
      }`
    );
    return true;
  }

  async function handleSingleMove(swatchId: string, fromPos: number, toPos: number) {
    const key = `${swatchId}|${fromPos}`;
    setSingleMoving(key);
    try {
      const ok = await moveCells([{ swatch_id: swatchId, from_position: fromPos, to_position: toPos }]);
      if (ok) await load();
    } finally {
      setSingleMoving(null);
    }
  }

  async function generateRequest(body: { position?: number; cells?: Array<{ swatch_id: string; position: number }> }, dryRun: boolean) {
    const res = await fetch(`/api/projects/${id}/slots/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, dry_run: dryRun }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || 'Error');
      return null;
    }
    return data;
  }

  async function handleGenerateColumn(position: number) {
    setGeneratingSlot(position);
    try {
      const preview = await generateRequest({ position }, true);
      if (!preview) return;
      if (preview.generable === 0) {
        toast.info(
          `Nada para generar en slot #${position} (${preview.skipped_count} ya tienen contenido o sin hero asignado)`
        );
        return;
      }
      const cost = (preview.estimated_cost_usd as number).toFixed(2);
      const dedup = preview.dedup_siblings || 0;
      const ok = confirm(
        `Generar slot #${position}?\n\n` +
          `→ ${preview.generable} celda(s) a generar con Gemini\n` +
          (dedup > 0
            ? `→ ${dedup} hermano(s) de mismo color → cubrir despues con "Replicar a hermanos" ($0)\n`
            : '') +
          `→ ${preview.skipped_count - dedup} skip (ya tienen contenido o sin hero match)\n` +
          `→ Costo estimado Gemini: ~$${cost} USD\n\n` +
          `Se encolan como batch normal — progreso en /results.`
      );
      if (!ok) return;
      const result = await generateRequest({ position }, false);
      if (!result) return;
      toast.success(
        `${result.queued} jobs encolados (batch ${result.batch_id.slice(0, 8)})${
          (result.dedup_siblings || 0) > 0
            ? ` · ${result.dedup_siblings} hermano(s) listos para replicar despues`
            : ''
        }`
      );
      await load();
    } finally {
      setGeneratingSlot(null);
    }
  }

  async function handleReplicateSiblings(position: number) {
    setGeneratingSlot(position);
    try {
      const res = await fetch(`/api/projects/${id}/slots/replicate-siblings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ position }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Error replicando');
        return;
      }
      if ((data.replicated || 0) === 0) {
        toast.info(data.message || 'Nada para replicar');
        return;
      }
      toast.success(
        `${data.replicated} hermano(s) cubiertos desde ${data.sources} fuente(s) ($0 Gemini)`
      );
      await load();
    } finally {
      setGeneratingSlot(null);
    }
  }

  async function handleGenerateCell(swatchId: string, position: number) {
    const key = `${swatchId}|${position}`;
    setSingleGenerating(key);
    try {
      const result = await generateRequest({ cells: [{ swatch_id: swatchId, position }] }, false);
      if (!result) return;
      if (result.queued === 0) {
        toast.info('No se pudo generar (sin hero match o ya existe)');
        return;
      }
      toast.success('Job encolado — se procesa en background');
      await load();
    } finally {
      setSingleGenerating(null);
    }
  }

  async function handleBulkMove(toPos: number) {
    const moves = Array.from(selected).map((key) => {
      const [swatch_id, posStr] = key.split('|');
      return { swatch_id, from_position: parseInt(posStr, 10), to_position: toPos };
    });
    setBulkMoving(true);
    try {
      const ok = await moveCells(moves);
      if (ok) {
        clearSelection();
        await load();
      }
    } finally {
      setBulkMoving(false);
    }
  }

  const cellByKey = useMemo(() => {
    const map = new Map<string, Cell>();
    if (state) for (const c of state.cells) map.set(`${c.swatch_id}|${c.position}`, c);
    return map;
  }, [state]);

  const filterOptions = useMemo(() => {
    if (!state) return { tipos: [], colors: [], sizes: [] };
    const tipos = new Set<string>();
    const colors = new Set<string>();
    const sizes = new Set<string>();
    for (const s of state.swatches) {
      if (s.tipo) tipos.add(s.tipo);
      if (s.color) colors.add(s.color);
      if (s.bed_size) sizes.add(s.bed_size);
    }
    const sortSize = (a: string, b: string) => {
      const na = parseFloat(a) || 999;
      const nb = parseFloat(b) || 999;
      return na - nb || a.localeCompare(b);
    };
    return {
      tipos: Array.from(tipos).sort(),
      colors: Array.from(colors).sort(),
      sizes: Array.from(sizes).sort(sortSize),
    };
  }, [state]);

  const visibleSwatches = useMemo(() => {
    if (!state) return [];
    return state.swatches.filter((s) => {
      if (filterTipo !== 'all' && s.tipo !== filterTipo) return false;
      if (filterColor !== 'all' && s.color !== filterColor) return false;
      if (filterSize !== 'all' && s.bed_size !== filterSize) return false;
      if (filterStatus !== 'all' && state.slots.length > 0) {
        const hasMatch = state.slots.some((slot) => {
          const c = cellByKey.get(`${s.id}|${slot.position}`);
          return c?.status === filterStatus;
        });
        if (!hasMatch) return false;
      }
      return true;
    });
  }, [state, filterTipo, filterColor, filterSize, filterStatus, cellByKey]);

  const counts = useMemo(() => {
    const c: Record<CellStatus, number> = { match: 0, drift: 0, only_ml: 0, only_system: 0, empty: 0 };
    if (state) for (const cell of state.cells) c[cell.status]++;
    return c;
  }, [state]);

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando estado de slots…
      </div>
    );
  }

  if (!state) {
    return <div className="p-8 text-muted-foreground">No se pudo cargar.</div>;
  }

  const hasSlots = state.slots.length > 0;

  return (
    <div className="p-6 space-y-4">
      <Link href={`/projects/${id}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> Volver al proyecto
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Posiciones de imagen (slots)</h1>
          <p className="text-sm text-muted-foreground">
            {state.slots.length} slot{state.slots.length !== 1 ? 's' : ''} · {state.swatches.length} variantes ·{' '}
            {state.cells.length} celdas
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditingSlots(true)}>
            <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Editar slots
          </Button>
          <Button variant="outline" size="sm" onClick={handleImportMl} disabled={importing}>
            {importing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Importar ML
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdoptFromMl}
            disabled={adopting || counts.only_ml === 0}
            title={counts.only_ml === 0 ? 'No hay fotos solo-ML para adoptar' : `Adoptar ${counts.only_ml} foto(s) ML al sistema`}
          >
            {adopting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
            Adoptar 🔵 al sistema {counts.only_ml > 0 ? `(${counts.only_ml})` : ''}
          </Button>
        </div>
      </div>

      {/* Status legend + counts */}
      <div className="flex flex-wrap gap-2 text-xs">
        {(['match', 'drift', 'only_ml', 'only_system', 'empty'] as CellStatus[]).map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(filterStatus === s ? 'all' : s)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition ${
              filterStatus === s ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-muted'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[s]}`} />
            {STATUS_LABEL[s]} ({counts[s]})
          </button>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground">
        💡 <span className="font-medium">Click</span> en celda con ML = mover · <span className="font-medium">Click en celda vacía</span> ⚡ = generar · <span className="font-medium">Shift+Click</span> = multi-seleccionar · <span className="font-medium">Click en header</span> = seleccionar columna · <span className="font-medium">⚡ Generar (N)</span> en header = generar columna entera
      </p>

      {/* Filters */}
      {(filterOptions.tipos.length > 1 || filterOptions.colors.length > 1 || filterOptions.sizes.length > 1) && (
        <div className="flex gap-2 flex-wrap">
          {filterOptions.tipos.length > 1 && (
            <Select value={filterTipo} onValueChange={setFilterTipo}>
              <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Tipo" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los tipos</SelectItem>
                {filterOptions.tipos.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {filterOptions.colors.length > 1 && (
            <Select value={filterColor} onValueChange={setFilterColor}>
              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue placeholder="Color" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los colores</SelectItem>
                {filterOptions.colors.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {filterOptions.sizes.length > 1 && (
            <Select value={filterSize} onValueChange={setFilterSize}>
              <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Tamaño" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los tamaños</SelectItem>
                {filterOptions.sizes.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {(filterTipo !== 'all' || filterColor !== 'all' || filterSize !== 'all' || filterStatus !== 'all') && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setFilterTipo('all');
                setFilterColor('all');
                setFilterSize('all');
                setFilterStatus('all');
              }}
            >
              Limpiar filtros
            </Button>
          )}
        </div>
      )}

      {hasSlots && state.heroes.length > 0 && (
        <HeroSlotAssigner
          projectId={id}
          heroes={state.heroes}
          slots={state.slots}
          onUpdated={load}
        />
      )}

      {!hasSlots && (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <ImageIcon className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">No hay slots definidos todavia</p>
          <p className="text-xs text-muted-foreground mt-1">
            Definí las posiciones de imagen del proyecto (ej: 1=Packshot, 2=Medidas, 3=Lifestyle…)
          </p>
          <Button onClick={() => setEditingSlots(true)} size="sm" className="mt-4">
            <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Definir slots
          </Button>
        </div>
      )}

      {hasSlots && (
        <div className="rounded-lg border bg-white overflow-auto">
          <table className="text-xs border-collapse">
            <thead className="bg-muted sticky top-0 z-10">
              <tr>
                <th className="sticky left-0 z-20 bg-muted border-r border-b px-3 py-2 text-left font-medium min-w-[200px]">
                  Variante
                </th>
                {state.slots.map((slot) => {
                  const colCellsAll = visibleSwatches.map((s) => {
                    const c = cellByKey.get(`${s.id}|${slot.position}`);
                    return { key: `${s.id}|${slot.position}`, hasMl: !!c?.ml, isEmpty: (c?.status || 'empty') === 'empty', hasSystem: !!c?.system };
                  });
                  const colCells = colCellsAll.filter((c) => c.hasMl);
                  const emptyCount = colCellsAll.filter((c) => c.isEmpty).length;
                  const filledSystemCount = colCellsAll.filter((c) => c.hasSystem).length;
                  const colSelectedCount = colCells.filter((c) => selected.has(c.key)).length;
                  const allColSelected = colCells.length > 0 && colSelectedCount === colCells.length;
                  const heroAssigned = state.heroes.some((h) => h.slot_position === slot.position);
                  const isGenerating = generatingSlot === slot.position;
                  // "Replicar a hermanos" tiene sentido solo si:
                  //   - el slot NO es por-tamaño (sino cada hermano es legitimamente distinto)
                  //   - hay al menos un job aprobado en la columna
                  //   - hay al menos un sibling vacio que cubrir
                  const canReplicate = !slot.size_dependent && filledSystemCount > 0 && emptyCount > 0;
                  return (
                    <th
                      key={slot.id}
                      className={`border-b border-r px-2 py-2 text-center font-medium min-w-[80px] select-none transition ${
                        allColSelected ? 'bg-blue-200' : colSelectedCount > 0 ? 'bg-blue-100' : 'hover:bg-muted/70'
                      }`}
                    >
                      <div
                        className="cursor-pointer"
                        onClick={() => toggleColumn(slot.position)}
                        title={`Click: ${allColSelected ? 'deseleccionar' : 'seleccionar'} ${colCells.length} foto(s) ML`}
                      >
                        <div className="font-semibold">#{slot.position}</div>
                        <div className="font-normal text-muted-foreground truncate max-w-[100px]" title={slot.name}>
                          {slot.name}
                        </div>
                        {slot.size_dependent && (
                          <Badge variant="outline" className="mt-0.5 text-[8px] h-3 px-1">por-tamaño</Badge>
                        )}
                        {colCells.length > 0 && (
                          <div className="text-[9px] text-muted-foreground mt-0.5">
                            {colSelectedCount > 0 ? `${colSelectedCount}/` : ''}{colCells.length} ML
                          </div>
                        )}
                      </div>
                      {emptyCount > 0 && heroAssigned && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleGenerateColumn(slot.position); }}
                          disabled={isGenerating}
                          className="mt-1 w-full text-[9px] rounded bg-purple-100 hover:bg-purple-200 text-purple-900 px-1 py-0.5 disabled:opacity-50 transition"
                          title={
                            slot.size_dependent
                              ? `Generar las ${emptyCount} celda(s) vacías (slot por-tamaño: 1 job por celda)`
                              : `Generar (1 job por color, los hermanos se cubren después con Replicar)`
                          }
                        >
                          {isGenerating ? '⏳ procesando…' : `⚡ Generar (${emptyCount})`}
                        </button>
                      )}
                      {canReplicate && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleReplicateSiblings(slot.position); }}
                          disabled={isGenerating}
                          className="mt-1 w-full text-[9px] rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-900 px-1 py-0.5 disabled:opacity-50 transition"
                          title={`Copiar fotos a hermanos del mismo color que estén vacíos en este slot ($0)`}
                        >
                          {isGenerating ? '⏳' : `↻ Replicar`}
                        </button>
                      )}
                      {emptyCount > 0 && !heroAssigned && (
                        <div className="mt-1 text-[9px] text-rose-600" title="Asigná un hero a este slot en el panel Heroes → Slots">
                          sin hero
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleSwatches.map((swatch) => (
                <tr key={swatch.id} className="hover:bg-muted/30">
                  <td className="sticky left-0 z-10 bg-white border-r border-b px-3 py-2 align-top">
                    <div className="flex items-center gap-2">
                      {swatch.storage_path && (
                        <img
                          src={`https://${process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/^https?:\/\//, '')}/storage/v1/object/public/images/${swatch.storage_path}`}
                          alt=""
                          className="h-8 w-8 rounded object-cover flex-shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="font-medium truncate">{swatch.label}</div>
                        <div className="text-[10px] text-muted-foreground font-mono truncate">{swatch.sku_suffix}</div>
                      </div>
                      {swatch.ml_permalink && (
                        <a href={swatch.ml_permalink} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </td>
                  {state.slots.map((slot) => {
                    const cell = cellByKey.get(`${swatch.id}|${slot.position}`);
                    const status = cell?.status || 'empty';
                    const thumb = cell?.system?.url || cell?.ml?.url;
                    const cellKey = `${swatch.id}|${slot.position}`;
                    const isSelected = selected.has(cellKey);
                    const isMoving = singleMoving === cellKey;
                    const isGenerating = singleGenerating === cellKey;
                    const hasMl = !!cell?.ml;
                    const isEmpty = status === 'empty';
                    const heroForSlot = state.heroes.some((h) => h.slot_position === slot.position);
                    const canGenerate = isEmpty && heroForSlot;
                    const otherSlots = state.slots.filter((s) => s.position !== slot.position);
                    return (
                      <td
                        key={slot.id}
                        className={`border-r border-b p-1 text-center ${isSelected ? 'bg-blue-100' : ''}`}
                        title={`${STATUS_LABEL[status]}${slot.size_dependent ? ' · slot por-tamaño' : ''}${hasMl ? ' · click para mover' : canGenerate ? ' · click para generar' : ''}`}
                        onMouseEnter={(e) => {
                          if (thumb) setHoverCell({ url: thumb, x: e.clientX, y: e.clientY });
                        }}
                        onMouseLeave={() => setHoverCell(null)}
                      >
                        <CellAction
                          hasMl={hasMl}
                          canGenerate={canGenerate}
                          isSelected={isSelected}
                          isMoving={isMoving}
                          isGenerating={isGenerating}
                          status={status}
                          thumb={thumb}
                          onShiftClick={() => toggleSelected(swatch.id, slot.position)}
                          onMoveTo={(toPos) => handleSingleMove(swatch.id, slot.position, toPos)}
                          onGenerate={() => handleGenerateCell(swatch.id, slot.position)}
                          slots={otherSlots}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Hover preview */}
      {hoverCell && (
        <div
          className="fixed z-50 pointer-events-none rounded-lg border bg-white shadow-2xl p-1"
          style={{ left: hoverCell.x + 16, top: hoverCell.y + 16, maxWidth: '320px' }}
        >
          <img src={hoverCell.url} alt="" className="rounded max-h-[300px]" />
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full border bg-white shadow-2xl px-4 py-2">
          <span className="text-sm font-medium">{selected.size} celda{selected.size !== 1 ? 's' : ''} seleccionada{selected.size !== 1 ? 's' : ''}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={bulkMoving}>
                {bulkMoving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <MoveRight className="mr-1.5 h-3.5 w-3.5" />}
                Mover a slot…
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="max-h-[300px] overflow-y-auto">
              <DropdownMenuLabel>Mover a…</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {state.slots.map((s) => (
                <DropdownMenuItem key={s.id} onClick={() => handleBulkMove(s.position)}>
                  #{s.position} — {s.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Slot editor */}
      <SlotEditorDialog
        open={editingSlots}
        onOpenChange={setEditingSlots}
        projectId={id}
        slots={state.slots}
        onSaved={(saved) => {
          setState((prev) => prev ? { ...prev, slots: saved } : prev);
          setEditingSlots(false);
        }}
      />
    </div>
  );
}

// ── Slot editor dialog ──

function SlotEditorDialog({
  open,
  onOpenChange,
  projectId,
  slots,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  slots: Slot[];
  onSaved: (saved: Slot[]) => void;
}) {
  type Draft = {
    position: number;
    name: string;
    expected_shot_type: string | null;
    size_dependent: boolean;
  };

  const [draft, setDraft] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(
        slots.length > 0
          ? slots.map((s) => ({
              position: s.position,
              name: s.name,
              expected_shot_type: s.expected_shot_type,
              size_dependent: s.size_dependent,
            }))
          : [{ position: 1, name: 'Packshot fondo blanco', expected_shot_type: 'main', size_dependent: false }]
      );
    }
  }, [open, slots]);

  function addRow() {
    const nextPos = (draft[draft.length - 1]?.position || 0) + 1;
    setDraft([...draft, { position: nextPos, name: '', expected_shot_type: null, size_dependent: false }]);
  }

  function removeRow(i: number) {
    setDraft(draft.filter((_, idx) => idx !== i));
  }

  function update(i: number, patch: Partial<Draft>) {
    setDraft(draft.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/slots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slots: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Error guardando');
        return;
      }
      toast.success(`${data.length} slots guardados`);
      onSaved(data);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Definir posiciones de imagen</DialogTitle>
          <DialogDescription>
            Cada posición es un &quot;slot&quot; con rol fijo (ej: 1 = packshot blanco, 2 = medidas).
            Marcá <span className="font-medium">por-tamaño</span> si la foto cambia según el tamaño de cama.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {draft.map((d, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-center">
              <Input
                type="number"
                value={d.position}
                onChange={(e) => update(i, { position: parseInt(e.target.value) || 1 })}
                className="col-span-1 h-8"
                min={1}
              />
              <Input
                placeholder="Nombre del slot"
                value={d.name}
                onChange={(e) => update(i, { name: e.target.value })}
                className="col-span-5 h-8"
              />
              <Select
                value={d.expected_shot_type || 'none'}
                onValueChange={(v) => update(i, { expected_shot_type: v === 'none' ? null : v })}
              >
                <SelectTrigger className="col-span-3 h-8 text-xs"><SelectValue placeholder="Shot type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— sin tipo —</SelectItem>
                  <SelectItem value="main">main</SelectItem>
                  <SelectItem value="lifestyle">lifestyle</SelectItem>
                  <SelectItem value="detail">detail</SelectItem>
                  <SelectItem value="doblada">doblada</SelectItem>
                  <SelectItem value="flatlay">flatlay</SelectItem>
                </SelectContent>
              </Select>
              <label className="col-span-2 flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={d.size_dependent}
                  onChange={(e) => update(i, { size_dependent: e.target.checked })}
                  className="h-3.5 w-3.5"
                />
                por-tamaño
              </label>
              <button
                onClick={() => removeRow(i)}
                className="col-span-1 text-muted-foreground hover:text-destructive text-xs"
              >
                ✕
              </button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRow} className="w-full">
            + Agregar slot
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Hero → Slot assignment panel ──

function HeroSlotAssigner({
  projectId,
  heroes,
  slots,
  onUpdated,
}: {
  projectId: string;
  heroes: Hero[];
  slots: Slot[];
  onUpdated: () => void;
}) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  async function setSlot(heroId: string, slotPos: number | null) {
    setSavingId(heroId);
    try {
      const res = await fetch(`/api/projects/${projectId}/heroes/${heroId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot_position: slotPos }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Error guardando');
        return;
      }
      toast.success(slotPos ? `Hero asignado al slot ${slotPos}` : 'Hero sin slot');
      onUpdated();
    } finally {
      setSavingId(null);
    }
  }

  const assigned = heroes.filter((h) => h.slot_position).length;
  const total = heroes.length;
  const supabaseBase = process.env.NEXT_PUBLIC_SUPABASE_URL;

  return (
    <div className="rounded-lg border bg-white">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50"
      >
        <div className="flex items-center gap-2 text-sm">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold">Heroes → Slots</span>
          <Badge variant="outline" className="text-[10px]">
            {assigned}/{total} asignados
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">{collapsed ? '▸ expandir' : '▾ colapsar'}</span>
      </button>
      {!collapsed && (
        <div className="border-t p-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {heroes.map((h) => (
            <div key={h.id} className="flex items-center gap-2 rounded border p-2">
              <div className="h-12 w-12 flex-shrink-0 rounded overflow-hidden bg-gray-100">
                {h.storage_path && (
                  <img
                    src={`${supabaseBase}/storage/v1/object/public/images/${h.storage_path}`}
                    alt={h.filename}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate" title={h.filename}>
                  {h.filename}
                </p>
                <p className="text-[10px] text-muted-foreground">{h.shot_type || '—'}</p>
              </div>
              <Select
                value={h.slot_position ? String(h.slot_position) : 'none'}
                onValueChange={(v) => setSlot(h.id, v === 'none' ? null : parseInt(v, 10))}
                disabled={savingId === h.id}
              >
                <SelectTrigger className="h-7 w-[100px] text-xs">
                  <SelectValue placeholder="Slot" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— ninguno —</SelectItem>
                  {slots.map((s) => (
                    <SelectItem key={s.id} value={String(s.position)}>
                      #{s.position} {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {savingId === h.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Per-cell click action: dropdown for "mover a slot" ──

function CellAction({
  hasMl,
  canGenerate,
  isSelected,
  isMoving,
  isGenerating,
  status,
  thumb,
  onShiftClick,
  onMoveTo,
  onGenerate,
  slots,
}: {
  hasMl: boolean;
  canGenerate: boolean;
  isSelected: boolean;
  isMoving: boolean;
  isGenerating: boolean;
  status: CellStatus;
  thumb: string | null | undefined;
  onShiftClick: () => void;
  onMoveTo: (toPos: number) => void;
  onGenerate: () => void;
  slots: Slot[];
}) {
  const [open, setOpen] = useState(false);
  const interactive = hasMl || canGenerate;

  const visual = (
    <div className={`relative h-12 w-12 mx-auto rounded ${STATUS_COLOR[status]} ${thumb ? 'overflow-hidden' : ''} ${isSelected ? 'ring-2 ring-blue-500 ring-offset-1' : ''} ${interactive ? 'cursor-pointer' : 'cursor-default'} group`}>
      {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
      {!thumb && <div className="h-full w-full" />}
      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-white ${STATUS_COLOR[status]}`} />
      {canGenerate && !isGenerating && (
        <div className="absolute inset-0 flex items-center justify-center bg-purple-500/0 hover:bg-purple-500/40 transition opacity-0 group-hover:opacity-100">
          <span className="text-white text-lg drop-shadow">⚡</span>
        </div>
      )}
      {(isMoving || isGenerating) && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70">
          <Loader2 className="h-3 w-3 animate-spin" />
        </div>
      )}
    </div>
  );

  if (!hasMl && !canGenerate) return visual;

  // Empty cell with hero assigned → click directly generates (no menu)
  if (!hasMl && canGenerate) {
    return (
      <button
        type="button"
        className="block"
        onClick={onGenerate}
        disabled={isGenerating}
        title="Generar esta foto con el hero asignado al slot"
      >
        {visual}
      </button>
    );
  }

  // Has ML photo → dropdown to move
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        asChild
        onClick={(e) => {
          if (e.shiftKey) {
            e.preventDefault();
            onShiftClick();
          }
        }}
      >
        <button type="button" className="block">{visual}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-h-[300px] overflow-y-auto">
        <DropdownMenuLabel>Mover a slot…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {slots.length === 0 && (
          <DropdownMenuItem disabled>(sin otros slots)</DropdownMenuItem>
        )}
        {slots.map((s) => (
          <DropdownMenuItem key={s.id} onClick={() => { onMoveTo(s.position); setOpen(false); }}>
            #{s.position} — {s.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
