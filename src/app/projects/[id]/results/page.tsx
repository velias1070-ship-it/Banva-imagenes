'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft, Download, CheckCircle, AlertTriangle, XCircle,
  ImageIcon, RotateCcw, ChevronDown, ChevronRight,
  Upload, Loader2, BedSingle, Star, Pencil, Send,
  Globe, ExternalLink, GripVertical, X, Plus, Save, ArrowLeftRight,
  Palette, Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

// ── Types ──

interface JobWithRelations {
  id: string;
  status: string;
  attempt: number;
  hero_shot_id: string | null;
  output_storage_path: string | null;
  qa_score: number | null;
  qa_feedback: string | null;
  qa_detail: {
    product_fidelity?: number;
    hero_contamination?: number;
    [key: string]: number | undefined;
  } | null;
  error_message: string | null;
  hero_shot: { filename: string; shot_type: string; storage_path: string } | null;
  swatch: { id: string; name: string; color_description: string | null; storage_path: string; display_order: number } | null;
}

interface MlListingData {
  item_id: string;
  titulo: string;
  status: string;
  permalink: string;
  ml_pictures: Array<{ id: string; url: string; size: string }>;
}

interface SwatchResultGroup {
  swatch: {
    id: string;
    name: string;
    sku_suffix: string | null;
    color_description: string | null;
    storage_path: string;
    display_order: number;
  };
  jobs: JobWithRelations[];
  ml_listing: MlListingData | null;
}

interface EditorPicture {
  type: 'ml' | 'generated';
  id?: string;
  url: string;
  source_url?: string;
  shot_type?: string;
}

function getStorageUrl(path: string, attempt?: number): string {
  const cacheBuster = attempt ? `?v=${attempt}` : '';
  return `${SUPABASE_URL}/storage/v1/object/public/images/${path}${cacheBuster}`;
}

type FilterTab = 'all' | 'approved' | 'retry' | 'flagged' | 'error' | 'qa_pending' | 'ml_active' | 'ml_paused';

export default function ResultsPage() {
  const { id } = useParams<{ id: string }>();
  const [groups, setGroups] = useState<SwatchResultGroup[]>([]);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [collapsedSwatches, setCollapsedSwatches] = useState<Set<string> | null>(null);
  const [editingJob, setEditingJob] = useState<string | null>(null);
  // Lifted to parent because JobCard is defined inside ResultsPage and
  // re-creates its function reference on every poll (every 10s). That
  // remounts all JobCards, which would reset a child's local state.
  // Keeping the edit instruction here survives the remount.
  const [editInstructions, setEditInstructions] = useState<Record<string, string>>({});
  const [importingCannon, setImportingCannon] = useState(false);
  const [importingCannonSwatch, setImportingCannonSwatch] = useState<Set<string>>(new Set());
  // Projects where per-swatch Cannon import button is enabled
  const PER_SWATCH_CANNON_PROJECTS = new Set([
    'f047dcc1-1c96-440c-99af-e7c0af622f89',
    '5252726f-7f69-48be-88eb-de895e138737',
    '4af255ae-39ba-4c7a-b425-f794ec65e4a7',
    '1967331d-7d07-49af-92c6-7f77e5292b72', // sabanas 1.5 y 2.0 144h
  ]);
  const showPerSwatchCannon = PER_SWATCH_CANNON_PROJECTS.has(id);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    success: number; errors: number; skipped: number; total_images: number;
    total_new_images?: number; total_kept_images?: number;
    details?: { sku: string; item_id: string; titulo: string; status: string; error?: string; pictures_new?: number; pictures_kept?: number; pictures_total?: number }[];
  } | null>(null);

  // ML panel state per swatch
  const [mlPanelOpen, setMlPanelOpen] = useState<Set<string>>(new Set());
  const [mlPictures, setMlPictures] = useState<Map<string, EditorPicture[]>>(new Map());
  const [mlDirty, setMlDirty] = useState<Map<string, boolean>>(new Map());
  const [mlSaving, setMlSaving] = useState<Map<string, boolean>>(new Map());

  // ML import state
  const [mlImporting, setMlImporting] = useState<Set<string>>(new Set());

  // ML photo selector dialog state
  const [mlSelectorOpen, setMlSelectorOpen] = useState(false);
  const [mlSelectorSwatchId, setMlSelectorSwatchId] = useState<string | null>(null);
  const [mlSelectorPictures, setMlSelectorPictures] = useState<Array<{ id: string; url: string; size: string }>>([]);
  const [mlSelectorSelected, setMlSelectorSelected] = useState<Set<string>>(new Set());
  const [mlSelectorSwatchName, setMlSelectorSwatchName] = useState('');

  // Replicate dialog state
  const [replicateOpen, setReplicateOpen] = useState(false);
  const [replicating, setReplicating] = useState(false);

  // Replicate by SKU state
  const [replicateSku, setReplicateSku] = useState('');
  const [replicateSkuSearching, setReplicateSkuSearching] = useState(false);
  const [replicateSkuResult, setReplicateSkuResult] = useState<{
    sku: string;
    item_id: string;
    titulo: string;
    status: string;
    permalink: string;
    pictures: { id: string; url: string; size: string }[];
  } | null>(null);
  const [replicateTargetSwatch, setReplicateTargetSwatch] = useState<string>('');

  // Project brand
  const [projectBrandId, setProjectBrandId] = useState<string | null>(null);

  // Swap state: click generated image → click ML position to replace
  const [swapSource, setSwapSource] = useState<{ swatchId: string; url: string; shotType?: string } | null>(null);

  // Drag state for ML panel
  const [dragging, setDragging] = useState(false);
  const [dropSwatchId, setDropSwatchId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<number | null>(null);
  const dragRef = useRef<{
    kind: 'reorder' | 'add';
    swatchId: string;
    picIdx?: number;
    job?: JobWithRelations;
  } | null>(null);

  // Derive flat jobs list from groups
  const allJobs = useMemo(() => groups.flatMap((g) => g.jobs), [groups]);

  const fetchResults = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}/results-with-listings`);
      if (res.ok) {
        const data: SwatchResultGroup[] = await res.json();
        setGroups(data);

        // Initialize ML pictures for groups that haven't been touched
        setMlPictures((prev) => {
          const next = new Map(prev);
          for (const g of data) {
            if (!next.has(g.swatch.id) || !prev.has(g.swatch.id)) {
              if (g.ml_listing) {
                next.set(g.swatch.id, g.ml_listing.ml_pictures.map((p) => ({
                  type: 'ml' as const, id: p.id, url: p.url,
                })));
              } else {
                next.set(g.swatch.id, []);
              }
            }
          }
          return next;
        });
      }
    } catch {
      // silent
    }
  }, [id]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // Fetch project brand_id once
  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.brand_id) setProjectBrandId(data.brand_id);
      })
      .catch(() => {});
  }, [id]);

  // ── AUTO-POLL + HEALTH CHECK ──
  const hasActiveJobs = allJobs.some((j) =>
    ['pending', 'generating', 'qa_pending', 'qa_processing'].includes(j.status)
  );

  useEffect(() => {
    if (!hasActiveJobs) return;
    const pollInterval = setInterval(fetchResults, 10_000);
    const healthInterval = setInterval(() => {
      fetch(`/api/cron/health-check?project_id=${id}`).catch(() => {});
    }, 30_000);
    fetch(`/api/cron/health-check?project_id=${id}`).catch(() => {});
    return () => {
      clearInterval(pollInterval);
      clearInterval(healthInterval);
    };
  }, [hasActiveJobs, fetchResults, id]);

  // ── Filter groups ──
  const filteredGroups = useMemo<SwatchResultGroup[]>(() => {
    if (activeTab === 'all') return groups;

    if (activeTab === 'ml_active') {
      return groups.filter((g) => g.ml_listing?.status === 'active');
    }

    if (activeTab === 'ml_paused') {
      return groups.filter((g) => g.ml_listing?.status === 'paused');
    }

    return groups
      .map((g) => ({
        ...g,
        jobs: activeTab === 'qa_pending'
          ? g.jobs.filter((j) => j.status === 'qa_pending' || j.status === 'qa_processing')
          : g.jobs.filter((j) => j.status === activeTab),
      }))
      .filter((g) => g.jobs.length > 0);
  }, [groups, activeTab]);

  // ── Counts ──
  const approvedCount = allJobs.filter((j) => j.status === 'approved').length;
  const retryCount = allJobs.filter((j) => j.status === 'retry').length;
  const flaggedCount = allJobs.filter((j) => j.status === 'flagged').length;
  const errorCount = allJobs.filter((j) => j.status === 'error').length;
  const qaPendingCount = allJobs.filter((j) => j.status === 'qa_pending' || j.status === 'qa_processing').length;
  const mlActiveCount = groups.filter((g) => g.ml_listing?.status === 'active').length;
  const mlPausedCount = groups.filter((g) => g.ml_listing?.status === 'paused').length;

  // ── Start collapsed ──
  useEffect(() => {
    if (collapsedSwatches === null && filteredGroups.length > 0) {
      setCollapsedSwatches(new Set(filteredGroups.map((g) => g.swatch.id)));
    }
  }, [filteredGroups, collapsedSwatches]);

  const collapsed = collapsedSwatches ?? new Set(filteredGroups.map((g) => g.swatch.id));

  // ── Swatch collapse ──
  function toggleSwatchCollapse(swatchId: string) {
    setCollapsedSwatches((prev) => {
      const next = new Set(prev);
      if (next.has(swatchId)) next.delete(swatchId);
      else next.add(swatchId);
      return next;
    });
  }

  // ── ML Panel toggle ──
  function toggleMlPanel(swatchId: string) {
    setMlPanelOpen((prev) => {
      const next = new Set(prev);
      if (next.has(swatchId)) next.delete(swatchId);
      else next.add(swatchId);
      return next;
    });
  }

  // ── ML Panel operations ──
  function addAllApproved(swatchId: string) {
    const group = groups.find((g) => g.swatch.id === swatchId);
    if (!group) return;
    const approved = group.jobs.filter(
      (j) => j.status === 'approved' && j.output_storage_path
    );
    setMlPictures((prev) => {
      const next = new Map(prev);
      const current = [...(next.get(swatchId) || [])];
      for (const job of approved) {
        const url = getStorageUrl(job.output_storage_path!);
        if (current.length >= 10) break;
        if (current.some((p) => p.source_url === url)) continue;
        current.push({
          type: 'generated',
          url,
          source_url: url,
          shot_type: job.hero_shot?.shot_type,
        });
      }
      next.set(swatchId, current);
      return next;
    });
    setMlDirty((prev) => new Map(prev).set(swatchId, true));
  }

  function addJobToMlPanel(swatchId: string, job: JobWithRelations) {
    if (!job.output_storage_path) return;
    const url = getStorageUrl(job.output_storage_path);
    setMlPictures((prev) => {
      const next = new Map(prev);
      const current = [...(next.get(swatchId) || [])];
      if (current.length >= 10) { toast.error('Maximo 10 fotos'); return prev; }
      if (current.some((p) => p.source_url === url)) { toast.info('Ya agregada'); return prev; }
      current.push({
        type: 'generated',
        url,
        source_url: url,
        shot_type: job.hero_shot?.shot_type,
      });
      next.set(swatchId, current);
      return next;
    });
    setMlDirty((prev) => new Map(prev).set(swatchId, true));
  }

  function removeMlPicture(swatchId: string, picIdx: number) {
    setMlPictures((prev) => {
      const next = new Map(prev);
      const current = [...(next.get(swatchId) || [])];
      current.splice(picIdx, 1);
      next.set(swatchId, current);
      return next;
    });
    setMlDirty((prev) => new Map(prev).set(swatchId, true));
  }

  // ── Swap: click generated → click ML position ──
  function selectForSwap(swatchId: string, job: JobWithRelations) {
    if (!job.output_storage_path) return;
    const url = getStorageUrl(job.output_storage_path);
    // Toggle: click same image again to deselect
    if (swapSource?.url === url) {
      setSwapSource(null);
    } else {
      setSwapSource({ swatchId, url, shotType: job.hero_shot?.shot_type });
    }
  }

  function swapWithMlPosition(swatchId: string, posIdx: number) {
    if (!swapSource || swapSource.swatchId !== swatchId) return;
    setMlPictures((prev) => {
      const next = new Map(prev);
      const current = [...(next.get(swatchId) || [])];
      // Replace the picture at posIdx with the generated image
      current[posIdx] = {
        type: 'generated',
        url: swapSource.url,
        source_url: swapSource.url,
        shot_type: swapSource.shotType,
      };
      next.set(swatchId, current);
      return next;
    });
    setMlDirty((prev) => new Map(prev).set(swatchId, true));
    setSwapSource(null);
    toast.success(`Posición ${posIdx + 1} reemplazada`);
  }

  // ── ML Panel drag & drop ──
  function handleMlDragStart(
    e: React.DragEvent,
    source: { kind: 'reorder' | 'add'; swatchId: string; picIdx?: number; job?: JobWithRelations }
  ) {
    dragRef.current = source;
    setDragging(true);
    e.dataTransfer.effectAllowed = source.kind === 'reorder' ? 'move' : 'copy';
    const el = e.currentTarget as HTMLElement;
    if (el) e.dataTransfer.setDragImage(el, 24, 24);
  }

  function handleMlDragEnd() {
    dragRef.current = null;
    setDragging(false);
    setDropSwatchId(null);
    setDropPosition(null);
  }

  function getMlDropPosition(e: React.DragEvent, container: HTMLElement): number {
    const children = Array.from(container.querySelectorAll('[data-ml-pic-idx]'));
    const mouseY = e.clientY;
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (mouseY < midY) return i;
    }
    return children.length;
  }

  function handleMlContainerDragOver(e: React.DragEvent, swatchId: string) {
    e.preventDefault();
    const drag = dragRef.current;
    if (!drag || drag.swatchId !== swatchId) return;
    const container = e.currentTarget as HTMLElement;
    const pos = getMlDropPosition(e, container);
    setDropSwatchId(swatchId);
    setDropPosition(pos);
  }

  function handleMlContainerDrop(e: React.DragEvent, swatchId: string) {
    e.preventDefault();
    const drag = dragRef.current;
    if (!drag || drag.swatchId !== swatchId) return;

    const container = e.currentTarget as HTMLElement;
    const position = getMlDropPosition(e, container);

    if (drag.kind === 'reorder' && drag.picIdx != null) {
      setMlPictures((prev) => {
        const next = new Map(prev);
        const pics = [...(next.get(swatchId) || [])];
        const [moved] = pics.splice(drag.picIdx!, 1);
        const insertAt = position > drag.picIdx! ? position - 1 : position;
        pics.splice(insertAt, 0, moved);
        next.set(swatchId, pics);
        return next;
      });
      setMlDirty((prev) => new Map(prev).set(swatchId, true));
    } else if (drag.kind === 'add' && drag.job) {
      if (!drag.job.output_storage_path) return;
      const url = getStorageUrl(drag.job.output_storage_path);
      setMlPictures((prev) => {
        const next = new Map(prev);
        const pics = [...(next.get(swatchId) || [])];
        if (pics.length >= 10) { toast.error('Maximo 10 fotos'); return prev; }
        if (pics.some((p) => p.source_url === url)) { toast.info('Ya agregada'); return prev; }
        pics.splice(position, 0, {
          type: 'generated',
          url,
          source_url: url,
          shot_type: drag.job!.hero_shot?.shot_type,
        });
        next.set(swatchId, pics);
        return next;
      });
      setMlDirty((prev) => new Map(prev).set(swatchId, true));
    }

    handleMlDragEnd();
  }

  // ── ML Panel save ──
  async function saveSwatchML(swatchId: string) {
    const group = groups.find((g) => g.swatch.id === swatchId);
    if (!group?.ml_listing?.item_id) return;

    setMlSaving((prev) => new Map(prev).set(swatchId, true));

    const pics = mlPictures.get(swatchId) || [];
    const pictures = pics.map((p) =>
      p.type === 'ml' && p.id ? { id: p.id } : { source: p.source_url || p.url }
    );

    try {
      const res = await fetch('/api/ml/update-pictures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: group.ml_listing.item_id, pictures }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`${group.swatch.name}: ${pictures.length} fotos guardadas en ML`);
        setMlDirty((prev) => new Map(prev).set(swatchId, false));
        // Refresh to get updated ML picture IDs
        fetchResults();
      } else {
        toast.error(`Error: ${data.error}`);
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setMlSaving((prev) => new Map(prev).set(swatchId, false));
    }
  }

  // ── Import ML pictures as results ──
  function handleImportMlPictures(swatchId: string) {
    const group = groups.find((g) => g.swatch.id === swatchId);
    if (!group?.ml_listing?.ml_pictures?.length) {
      toast.error('No hay fotos en la publicacion de ML');
      return;
    }
    const pics = group.ml_listing.ml_pictures;
    setMlSelectorSwatchId(swatchId);
    setMlSelectorSwatchName(group.swatch.name);
    setMlSelectorPictures(pics);
    setMlSelectorSelected(new Set(pics.map((p) => p.id)));
    setMlSelectorOpen(true);
  }

  async function handleConfirmMlImport() {
    if (!mlSelectorSwatchId || mlSelectorSelected.size === 0) return;
    const swatchId = mlSelectorSwatchId;
    const selectedIds = Array.from(mlSelectorSelected);
    setMlSelectorOpen(false);
    setMlImporting((prev) => new Set(prev).add(swatchId));
    try {
      const res = await fetch(`/api/projects/${id}/import-ml-pictures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swatch_id: swatchId, picture_ids: selectedIds }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`${data.imported} fotos importadas de ML para ${data.swatch}`);
        fetchResults();
      } else {
        toast.error(data.error || `Error importando`);
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setMlImporting((prev) => {
        const next = new Set(prev);
        next.delete(swatchId);
        return next;
      });
    }
  }

  // ── Replicate by SKU ──
  async function handleSkuLookup() {
    const sku = replicateSku.trim();
    if (!sku) return;
    setReplicateSkuSearching(true);
    setReplicateSkuResult(null);
    try {
      const res = await fetch(`/api/projects/${id}/lookup-sku?sku=${encodeURIComponent(sku)}`);
      const data = await res.json();
      if (res.ok) {
        setReplicateSkuResult(data);
      } else {
        toast.error(data.error || 'SKU no encontrado');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setReplicateSkuSearching(false);
    }
  }

  async function handleReplicate() {
    if (!replicateSkuResult || !replicateTargetSwatch) return;
    setReplicating(true);
    try {
      // Step 1: Import ML photos as heroes
      const importRes = await fetch(`/api/projects/${id}/import-heroes-from-ml`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: replicateSkuResult.item_id }),
      });
      const importData = await importRes.json();
      if (!importRes.ok || !importData.hero_ids?.length) {
        toast.error(importData.error || 'Error importando fotos de ML');
        setReplicating(false);
        return;
      }

      toast.info(`${importData.imported} fotos importadas como heroes. Generando batch...`);

      // Step 2: Create generation batch with imported heroes + target swatch
      const genRes = await fetch(`/api/projects/${id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hero_ids: importData.hero_ids,
          swatch_ids: [replicateTargetSwatch],
        }),
      });
      const genData = await genRes.json();
      if (genRes.ok) {
        toast.success(
          `Replicando: ${genData.total_combinations} imagenes de ${replicateSkuResult.sku}. Costo ~$${genData.estimated_cost_usd.toFixed(2)}`
        );
        setReplicateOpen(false);
        setReplicateSku('');
        setReplicateSkuResult(null);
        setReplicateTargetSwatch('');
        // Start polling for new results
        setTimeout(fetchResults, 3000);
      } else {
        toast.error(genData.error || 'Error creando batch');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setReplicating(false);
    }
  }

  // ── Job actions ──
  async function handleDownloadAll() {
    toast.info('Preparando descarga ZIP...');
    try {
      const res = await fetch(`/api/projects/${id}/download`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `banva-project-${id}-approved.zip`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Descarga iniciada');
      } else {
        toast.error('Error preparando descarga');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleRegenerate(jobId: string) {
    toast.info('Regenerando imagen...');
    try {
      const res = await fetch(`/api/projects/${id}/results/${jobId}`, {
        method: 'POST',
      });
      if (res.ok) {
        // Optimistic update
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            jobs: g.jobs.map((j) =>
              j.id === jobId ? { ...j, status: 'generating' } : j
            ),
          }))
        );
        toast.success('Regenerando — se actualizara automaticamente');
        const poll = setInterval(async () => {
          try {
            const updated = await fetch(`/api/projects/${id}/results-with-listings`);
            if (updated.ok) {
              const data: SwatchResultGroup[] = await updated.json();
              const thisJob = data.flatMap((g) => g.jobs).find((j) => j.id === jobId);
              setGroups(data);
              if (thisJob && thisJob.status !== 'generating' && thisJob.status !== 'qa_pending' && thisJob.status !== 'qa_processing') {
                clearInterval(poll);
                if (thisJob.status === 'approved') {
                  toast.success('Imagen regenerada y aprobada por QA');
                } else if (thisJob.status === 'flagged') {
                  toast.error('Imagen regenerada pero rechazada por QA');
                } else {
                  toast.error(`Regeneracion termino con estado: ${thisJob.status}`);
                }
              }
            }
          } catch { /* ignore */ }
        }, 5000);
      } else {
        toast.error('Error iniciando regeneracion');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleBrandRegen(jobId: string) {
    toast.info('Regenerando con Brand...');
    try {
      const res = await fetch(`/api/projects/${id}/results/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'brand_only' }),
      });
      if (res.ok) {
        // Optimistic update
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            jobs: g.jobs.map((j) =>
              j.id === jobId ? { ...j, status: 'generating' } : j
            ),
          }))
        );
        toast.success('Regenerando con Brand — se actualizara automaticamente');
        const poll = setInterval(async () => {
          try {
            const updated = await fetch(`/api/projects/${id}/results-with-listings`);
            if (updated.ok) {
              const data: SwatchResultGroup[] = await updated.json();
              const thisJob = data.flatMap((g) => g.jobs).find((j) => j.id === jobId);
              setGroups(data);
              if (thisJob && thisJob.status !== 'generating' && thisJob.status !== 'qa_pending' && thisJob.status !== 'qa_processing') {
                clearInterval(poll);
                if (thisJob.status === 'approved') {
                  toast.success('Brand regen completada y aprobada');
                } else if (thisJob.status === 'flagged') {
                  toast.error('Brand regen completada pero rechazada por QA');
                } else {
                  toast.error(`Brand regen termino con estado: ${thisJob.status}`);
                }
              }
            }
          } catch { /* ignore */ }
        }, 5000);
      } else {
        toast.error('Error iniciando brand regen');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleDownloadOne(jobId: string) {
    try {
      const res = await fetch(`/api/projects/${id}/download?jobId=${jobId}`);
      if (res.ok) {
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition');
        const match = disposition?.match(/filename="(.+)"/);
        const filename = match?.[1] || `${jobId}.png`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast.error('Error descargando imagen');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleImportCannonForSwatch(swatchId: string) {
    setImportingCannonSwatch((prev) => new Set(prev).add(swatchId));
    try {
      const res = await fetch(`/api/projects/${id}/import-cannon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swatch_ids: [swatchId], force: true }),
      });
      const data = await res.json();
      if (res.ok) {
        const detail = data.details?.[0];
        if (detail?.images_imported > 0) {
          toast.success(`${detail.images_imported} imagenes importadas de Cannon`);
          await fetchResults();
        } else if (detail?.errors?.length) {
          toast.error(detail.errors[0]);
        } else {
          toast.error('No se importaron imagenes');
        }
      } else {
        toast.error(data.error || 'Error importando');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setImportingCannonSwatch((prev) => {
        const next = new Set(prev);
        next.delete(swatchId);
        return next;
      });
    }
  }

  async function handleImportCannon() {
    setImportingCannon(true);
    try {
      const res = await fetch(`/api/projects/${id}/import-cannon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`${data.total_images} imagenes importadas de Cannon (${data.success} swatches)`);
        if (data.errors > 0) {
          toast.error(`${data.errors} swatches con errores`);
        }
        fetchResults();
      } else {
        toast.error(data.error || 'Error importando');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setImportingCannon(false);
    }
  }

  async function handleEditImage(jobId: string, instruction: string) {
    if (!instruction.trim()) return;
    toast.info('Editando imagen...');
    setEditingJob(null);
    // Clear the saved instruction for this job once submitted
    setEditInstructions((prev) => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
    try {
      const res = await fetch(`/api/projects/${id}/results/${jobId}/edit-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success('Editando — se actualizara automaticamente');
        const poll = setInterval(async () => {
          try {
            const updated = await fetch(`/api/projects/${id}/results-with-listings`);
            if (updated.ok) {
              const allData: SwatchResultGroup[] = await updated.json();
              setGroups(allData);
              const newJob = allData.flatMap((g) => g.jobs).find((j) => j.id === data.new_job_id);
              if (newJob && !['generating', 'qa_pending', 'qa_processing'].includes(newJob.status)) {
                clearInterval(poll);
                toast.success('Imagen editada');
              }
            }
          } catch { /* ignore */ }
        }, 5000);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Error editando');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleUseAsHero(jobId: string) {
    toast.info('Guardando como hero shot...');
    try {
      const res = await fetch(`/api/projects/${id}/results/${jobId}/save-as-hero`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Guardado como hero: ${data.filename} (${data.shot_type})`);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Error guardando como hero');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleUseAsSwatch(jobId: string) {
    if (!confirm('¿Usar esta imagen como nuevo swatch? Las futuras generaciones usarán esta imagen como referencia de diseño.')) return;
    try {
      const res = await fetch(`/api/projects/${id}/results/${jobId}/use-as-swatch`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      await res.json();
      toast.success('Swatch actualizado — futuras generaciones usarán esta imagen');
      fetchResults();
    } catch {
      toast.error('Error al actualizar swatch');
    }
  }

  async function handleGenerate15P(jobId: string) {
    toast.info('Generando variante 1.5 plaza...');
    try {
      const res = await fetch(`/api/projects/${id}/results/${jobId}/resize`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        const skuMsg = data.target_sku ? ` (SKU: ${data.target_sku})` : '';
        toast.success(`Generando 1.5P${skuMsg} — se agregara automaticamente`);
        const poll = setInterval(async () => {
          try {
            const updated = await fetch(`/api/projects/${id}/results-with-listings`);
            if (updated.ok) {
              const allData: SwatchResultGroup[] = await updated.json();
              setGroups(allData);
              const newJob = allData.flatMap((g) => g.jobs).find((j) => j.id === data.new_job_id);
              if (newJob && !['generating', 'qa_pending', 'qa_processing'].includes(newJob.status)) {
                clearInterval(poll);
                if (newJob.status === 'approved') {
                  toast.success('Variante 1.5P generada y aprobada');
                } else {
                  toast.info(`Variante 1.5P terminada con estado: ${newJob.status}`);
                }
              }
            }
          } catch { /* ignore */ }
        }, 5000);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Error generando variante 1.5P');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleOverride(jobId: string, newStatus: 'approved' | 'flagged') {
    const res = await fetch(`/api/projects/${id}/results/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    if (res.ok) {
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          jobs: g.jobs.map((j) =>
            j.id === jobId ? { ...j, status: newStatus } : j
          ),
        }))
      );
      toast.success(`Imagen ${newStatus === 'approved' ? 'aprobada' : 'rechazada'}`);
    }
  }

  async function handlePublishToML(dryRun: boolean, mode: 'prepend' | 'append' | 'replace' = 'prepend') {
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await fetch('/api/ml/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: id, dry_run: dryRun, mode }),
      });
      const data = await res.json();
      if (res.ok) {
        setPublishResult(data);
        if (dryRun) {
          toast.info(`Preview: ${data.total_new_images} nuevas + ${data.total_kept_images} existentes en ${data.success} publicaciones`);
        } else {
          if (data.errors > 0) {
            toast.error(`Publicado con ${data.errors} errores. ${data.success} exitosos.`);
          } else {
            toast.success(`${data.total_new_images} imagenes nuevas publicadas en ${data.success} publicaciones de ML (${data.total_kept_images} existentes mantenidas)`);
          }
        }
      } else {
        toast.error(data.error || 'Error publicando');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setPublishing(false);
    }
  }

  // ── Helpers ──
  function statusIcon(status: string) {
    switch (status) {
      case 'approved':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'retry':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'flagged':
        return <AlertTriangle className="h-4 w-4 text-orange-500" />;
      case 'error':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'qa_pending':
      case 'qa_processing':
        return <RotateCcw className="h-4 w-4 text-purple-500 animate-spin" />;
      case 'generating':
        return <RotateCcw className="h-4 w-4 text-blue-500 animate-spin" />;
      default:
        return null;
    }
  }

  function mlStatusColor(status: string): string {
    switch (status) {
      case 'active': return 'bg-green-100 text-green-800 border-green-200';
      case 'paused': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'closed': return 'bg-red-100 text-red-800 border-red-200';
      default: return '';
    }
  }

  // ── JobCard ──
  function JobCard({ job, swatchId }: { job: JobWithRelations; swatchId: string }) {
    const isPanelOpen = mlPanelOpen.has(swatchId);
    const isApproved = job.status === 'approved' && job.output_storage_path;
    const group = groups.find((g) => g.swatch.id === swatchId);
    const hasListing = !!group?.ml_listing;

    return (
      <Card className="overflow-hidden">
        <div
          className="aspect-square bg-gray-100 relative"
          draggable={!!(isPanelOpen && isApproved && hasListing)}
          onDragStart={(e) => {
            if (isPanelOpen && isApproved && hasListing) {
              handleMlDragStart(e, { kind: 'add', swatchId, job });
            }
          }}
          onDragEnd={handleMlDragEnd}
          style={isPanelOpen && isApproved && hasListing ? { cursor: 'grab' } : undefined}
        >
          {job.output_storage_path ? (
            <img
              src={getStorageUrl(job.output_storage_path, job.attempt)}
              alt={job.swatch?.name || 'Generated image'}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-gray-400">
              {job.status === 'error' ? job.error_message || 'Error' : 'Sin imagen'}
            </div>
          )}
          {/* Drag hint overlay */}
          {isPanelOpen && isApproved && hasListing && (
            <div className="absolute top-1 right-1 opacity-0 hover:opacity-100 transition-opacity">
              <Badge variant="secondary" className="text-[10px] bg-blue-100 text-blue-700">
                Arrastrar a ML
              </Badge>
            </div>
          )}
        </div>
        <CardContent className="p-3">
          <div className="mb-2">
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium truncate">{job.swatch?.name || 'Variante'}</p>
              <span
                className="text-[10px] font-mono text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(job.id);
                  toast.success('ID copiado');
                }}
                title={`ID: ${job.id} (click to copy)`}
              >
                #{job.id.substring(0, 8)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {job.hero_shot ? `${job.hero_shot.filename} · ${job.hero_shot.shot_type}` : 'Importado de ML'}
            </p>
          </div>

          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              {statusIcon(job.status)}
              <Badge
                variant={
                  job.status === 'approved' ? 'default' :
                  job.status === 'error' ? 'destructive' : 'secondary'
                }
                className="text-xs"
              >
                {job.status}
              </Badge>
            </div>
            {job.qa_score !== null && (
              <span
                className="text-xs font-medium cursor-help"
                title={job.qa_feedback || 'Sin feedback'}
              >
                QA: {(job.qa_score * 100).toFixed(0)}%
                {job.qa_detail?.hero_contamination != null && job.qa_detail.hero_contamination > 0.3 && (
                  <span className="ml-1 text-orange-500" title={`Hero contamination: ${(job.qa_detail.hero_contamination * 100).toFixed(0)}%`}>
                    !
                  </span>
                )}
              </span>
            )}
            {(job.status === 'qa_pending' || job.status === 'qa_processing') && (
              <span className="text-xs text-purple-600 flex items-center gap-1">
                <RotateCcw className="h-3 w-3 animate-spin" />
                QA...
              </span>
            )}
          </div>

          {job.qa_feedback && job.status !== 'approved' && (
            <p className="text-xs text-muted-foreground mb-2 line-clamp-2" title={job.qa_feedback}>
              {job.qa_feedback}
            </p>
          )}

          {job.status === 'generating' && (
            <div className="flex items-center gap-2 text-xs text-blue-600">
              <RotateCcw className="h-3 w-3 animate-spin" />
              Generando...
            </div>
          )}
          {(job.status === 'qa_pending' || job.status === 'qa_processing') && (
            <div className="flex items-center gap-2 text-xs text-purple-600">
              <RotateCcw className="h-3 w-3 animate-spin" />
              QA en progreso...
            </div>
          )}
          {job.status !== 'pending' && job.status !== 'generating' && job.status !== 'qa_pending' && job.status !== 'qa_processing' && (
            <div className="flex gap-1.5 flex-wrap">
              {job.output_storage_path && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleDownloadOne(job.id)}
                >
                  <Download className="h-3 w-3" />
                </Button>
              )}
              {job.status === 'approved' && job.output_storage_path && (
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-7 text-xs ${editingJob === job.id ? 'bg-blue-50 text-blue-700' : 'text-blue-600'}`}
                  onClick={() => setEditingJob(editingJob === job.id ? null : job.id)}
                >
                  <Pencil className="h-3 w-3 mr-1" />
                  Editar
                </Button>
              )}
              {/* Add to ML / Swap buttons when panel is open */}
              {isPanelOpen && isApproved && hasListing && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs text-green-600"
                    onClick={() => addJobToMlPanel(swatchId, job)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    ML
                  </Button>
                  <Button
                    variant={swapSource?.url === getStorageUrl(job.output_storage_path!) ? 'default' : 'outline'}
                    size="sm"
                    className={`h-7 text-xs ${swapSource?.url === getStorageUrl(job.output_storage_path!) ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'text-amber-600'}`}
                    onClick={() => selectForSwap(swatchId, job)}
                  >
                    <ArrowLeftRight className="h-3 w-3 mr-1" />
                    Swap
                  </Button>
                </>
              )}
              {(job.status === 'flagged' || job.status === 'error') && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs text-blue-600"
                  onClick={() => handleRegenerate(job.id)}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Regenerar
                </Button>
              )}
              {projectBrandId && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs text-purple-600"
                  onClick={() => handleBrandRegen(job.id)}
                >
                  <Palette className="h-3 w-3 mr-1" />
                  Brand
                </Button>
              )}
              {job.status === 'approved' && job.output_storage_path && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs text-orange-600"
                  onClick={() => handleUseAsSwatch(job.id)}
                  title="Usar esta imagen como swatch para futuras generaciones"
                >
                  <Palette className="h-3 w-3 mr-1" />
                  Swatch
                </Button>
              )}
              {job.status !== 'approved' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 flex-1 text-xs text-green-600"
                  onClick={() => handleOverride(job.id, 'approved')}
                >
                  Aprobar
                </Button>
              )}
              {job.status !== 'flagged' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 flex-1 text-xs text-red-600"
                  onClick={() => handleOverride(job.id, 'flagged')}
                >
                  Rechazar
                </Button>
              )}
            </div>
          )}

          {/* Edit panel */}
          {editingJob === job.id && (
            <EditPanel
              jobId={job.id}
              instruction={editInstructions[job.id] || ''}
              onInstructionChange={(v) => setEditInstructions((prev) => ({ ...prev, [job.id]: v }))}
              onUseAsHero={() => handleUseAsHero(job.id)}
              onGenerate15P={() => handleGenerate15P(job.id)}
              onEditImage={(instruction) => handleEditImage(job.id, instruction)}
            />
          )}
        </CardContent>
      </Card>
    );
  }

  // ── ML Panel (sidebar within each swatch section) ──
  function MlPanel({ group }: { group: SwatchResultGroup }) {
    const swatchId = group.swatch.id;
    const listing = group.ml_listing;
    const pics = mlPictures.get(swatchId) || [];
    const isDirty = mlDirty.get(swatchId) || false;
    const isSaving = mlSaving.get(swatchId) || false;

    if (!listing) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center p-4">
          <Globe className="h-6 w-6 text-muted-foreground/30 mb-2" />
          <p className="text-xs text-muted-foreground">Sin publicacion ML</p>
          {group.swatch.sku_suffix && (
            <p className="text-[10px] text-muted-foreground mt-1">SKU: {group.swatch.sku_suffix}</p>
          )}
        </div>
      );
    }

    const approvedJobs = group.jobs.filter(
      (j) => j.status === 'approved' && j.output_storage_path
    );
    const addableCount = approvedJobs.filter((j) => {
      const url = getStorageUrl(j.output_storage_path!);
      return !pics.some((p) => p.source_url === url);
    }).length;

    return (
      <div className="flex flex-col h-full">
        {/* Header info + Save button */}
        <div className="flex items-center justify-between mb-2 px-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate">
              {listing.item_id}
            </span>
            {listing.permalink && (
              <a href={listing.permalink} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
                <ExternalLink className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </a>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {isDirty && (
              <Button
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => saveSwatchML(swatchId)}
                disabled={isSaving}
              >
                {isSaving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    <Save className="h-3 w-3 mr-1" />
                    Guardar
                  </>
                )}
              </Button>
            )}
            <span className="text-[10px] text-muted-foreground">{pics.length}/10</span>
          </div>
        </div>

        {/* Swap hint */}
        {swapSource?.swatchId === swatchId && (
          <div className="mb-2 rounded-md bg-amber-50 border border-amber-200 px-2 py-1.5 text-[11px] text-amber-700">
            Click en la posición que quieres reemplazar
          </div>
        )}

        {/* Picture list with drag-drop */}
        <div
          className={`flex-1 min-h-[60px] rounded-lg p-1 transition-colors overflow-y-auto ${
            dragging && dragRef.current?.swatchId === swatchId ? 'bg-blue-50/50' : ''
          } ${swapSource?.swatchId === swatchId ? 'ring-2 ring-amber-300' : ''}`}
          onDragOver={(e) => handleMlContainerDragOver(e, swatchId)}
          onDragLeave={() => { setDropSwatchId(null); setDropPosition(null); }}
          onDrop={(e) => handleMlContainerDrop(e, swatchId)}
        >
          {pics.map((pic, picIdx) => {
            const isDropBefore = dropSwatchId === swatchId && dropPosition === picIdx;
            const isDropAfter = dropSwatchId === swatchId && dropPosition === picIdx + 1 && picIdx === pics.length - 1;
            const isDragSource = dragRef.current?.kind === 'reorder' && dragRef.current.swatchId === swatchId && dragRef.current.picIdx === picIdx;

            return (
              <div key={`${pic.type}-${pic.id || pic.url}-${picIdx}`} data-ml-pic-idx={picIdx}>
                {isDropBefore && <div className="h-1 bg-blue-500 rounded-full mx-1 my-0.5 animate-pulse" />}
                <div
                  className={`flex items-center gap-1.5 rounded-md border p-1 group transition-all mb-1 ${
                    isDragSource ? 'opacity-30 scale-95' : 'opacity-100'
                  } ${swapSource?.swatchId === swatchId ? 'cursor-pointer hover:border-amber-400 hover:bg-amber-50' : ''}`}
                  draggable={!swapSource}
                  onDragStart={(e) => !swapSource && handleMlDragStart(e, { kind: 'reorder', swatchId, picIdx })}
                  onDragEnd={handleMlDragEnd}
                  onClick={() => swapSource?.swatchId === swatchId && swapWithMlPosition(swatchId, picIdx)}
                >
                  <GripVertical className="h-3 w-3 text-muted-foreground/40 flex-shrink-0 cursor-grab active:cursor-grabbing" />
                  <div className="w-4 text-center text-[10px] font-bold text-muted-foreground flex-shrink-0">{picIdx + 1}</div>
                  <div className="h-10 w-10 flex-shrink-0 rounded overflow-hidden bg-gray-100">
                    <img src={pic.url} alt="" className="h-full w-full object-cover pointer-events-none" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {pic.type === 'generated' ? (
                      <Badge variant="secondary" className="text-[9px] px-1 h-4 bg-green-100 text-green-800">nueva</Badge>
                    ) : (
                      <span className="text-[9px] text-muted-foreground">ML</span>
                    )}
                  </div>
                  <button
                    className="h-5 w-5 flex items-center justify-center text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 rounded hover:bg-red-50"
                    onClick={() => removeMlPicture(swatchId, picIdx)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {isDropAfter && <div className="h-1 bg-blue-500 rounded-full mx-1 my-0.5 animate-pulse" />}
              </div>
            );
          })}

          {pics.length === 0 && (
            <div className={`flex items-center justify-center h-16 text-[10px] border border-dashed rounded-lg transition-colors ${
              dragging && dragRef.current?.swatchId === swatchId
                ? 'border-blue-400 bg-blue-50 text-blue-600'
                : 'border-gray-200 text-muted-foreground'
            }`}>
              {dragging ? 'Soltar aqui' : 'Sin fotos'}
            </div>
          )}

          {/* Bottom drop indicator */}
          {dropSwatchId === swatchId && dropPosition === pics.length && pics.length > 0 && (
            <div className="h-1 bg-blue-500 rounded-full mx-1 my-0.5 animate-pulse" />
          )}
        </div>

        {/* Action buttons */}
        <div className="mt-2 space-y-1.5">
          {addableCount > 0 && pics.length < 10 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full h-7 text-[10px]"
              onClick={() => addAllApproved(swatchId)}
            >
              <Plus className="h-3 w-3 mr-1" />
              Agregar todas ({addableCount})
            </Button>
          )}
          {isDirty && (
            <Button
              size="sm"
              className="w-full h-7 text-[10px]"
              onClick={() => saveSwatchML(swatchId)}
              disabled={isSaving}
            >
              {isSaving ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Save className="h-3 w-3 mr-1" />
              )}
              Guardar en ML
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ── Render ──
  return (
    <div className="p-8">
      <Link href={`/projects/${id}`} className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Proyecto
      </Link>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Resultados</h1>
          <p className="text-muted-foreground">
            {allJobs.length} imagenes generadas &middot; {approvedCount} aprobadas
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={handleImportCannon}
            disabled={importingCannon}
          >
            {importingCannon ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            {importingCannon ? 'Importando...' : 'Importar de Cannon'}
          </Button>
          <Button
            variant="outline"
            onClick={() => setReplicateOpen(true)}
          >
            <Copy className="mr-2 h-4 w-4" />
            Replicar Publicacion
          </Button>
        {approvedCount > 0 && (
          <>
            <Button variant="outline" onClick={handleDownloadAll}>
              <Download className="mr-2 h-4 w-4" />
              ZIP ({approvedCount})
            </Button>
            <Button
              variant="outline"
              onClick={() => handlePublishToML(true, 'prepend')}
              disabled={publishing}
            >
              {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Preview ML
            </Button>
            <Button
              onClick={() => handlePublishToML(false, 'prepend')}
              disabled={publishing}
              title="Agrega las nuevas al inicio, mantiene las existentes despues"
            >
              {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Publicar (nuevas primero)
            </Button>
            <Button
              variant="outline"
              onClick={() => handlePublishToML(false, 'append')}
              disabled={publishing}
              title="Mantiene las existentes, agrega las nuevas al final"
            >
              Agregar al final
            </Button>
          </>
        )}
        </div>
      </div>

      {/* Publish result panel */}
      {publishResult && (
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">
                {publishResult.details?.[0]?.status === 'success' && !publishing
                  ? 'Resultado de publicacion'
                  : 'Preview de publicacion'}
              </h3>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setPublishResult(null)}>
                Cerrar
              </Button>
            </div>
            <div className="flex gap-4 text-sm mb-3 flex-wrap">
              <span className="text-green-600">{publishResult.success} exitosos</span>
              {publishResult.errors > 0 && <span className="text-red-600">{publishResult.errors} errores</span>}
              {publishResult.skipped > 0 && <span className="text-yellow-600">{publishResult.skipped} omitidos</span>}
              <span className="text-muted-foreground">{publishResult.total_images} imagenes total</span>
            </div>
            {publishResult.details && (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {publishResult.details.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1 border-t">
                    {d.status === 'success' ? (
                      <CheckCircle className="h-3 w-3 text-green-500 flex-shrink-0" />
                    ) : d.status === 'error' ? (
                      <XCircle className="h-3 w-3 text-red-500 flex-shrink-0" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-yellow-500 flex-shrink-0" />
                    )}
                    <span className="font-mono">{d.sku}</span>
                    <span className="text-muted-foreground truncate">{d.titulo || d.item_id}</span>
                    {d.error && <span className="text-red-500 truncate ml-auto">{d.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as FilterTab)}>
        {/* Tabs + controls */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="all">Todas ({allJobs.length})</TabsTrigger>
            <TabsTrigger value="ml_active" className="text-xs">ML Activas ({mlActiveCount})</TabsTrigger>
            <TabsTrigger value="ml_paused" className="text-xs">ML Pausadas ({mlPausedCount})</TabsTrigger>
            <TabsTrigger value="approved">Aprobadas ({approvedCount})</TabsTrigger>
            <TabsTrigger value="retry">Retry ({retryCount})</TabsTrigger>
            <TabsTrigger value="flagged">Flagged ({flaggedCount})</TabsTrigger>
            <TabsTrigger value="qa_pending">QA ({qaPendingCount})</TabsTrigger>
            <TabsTrigger value="error">Errores ({errorCount})</TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            {filteredGroups.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={() => {
                  if (collapsed.size === filteredGroups.length) {
                    setCollapsedSwatches(new Set());
                  } else {
                    setCollapsedSwatches(new Set(filteredGroups.map((g) => g.swatch.id)));
                  }
                }}
              >
                {collapsed.size === filteredGroups.length ? 'Expandir todo' : 'Colapsar todo'}
              </Button>
            )}
          </div>
        </div>

        <TabsContent value={activeTab}>
          {filteredGroups.length === 0 ? (
            <Card>
              <CardContent className="py-12">
                <div className="flex flex-col items-center justify-center text-center">
                  <ImageIcon className="mb-4 h-12 w-12 text-muted-foreground/50" />
                  <p className="text-muted-foreground">
                    {allJobs.length === 0
                      ? 'No hay resultados aun. Genera variantes primero.'
                      : 'No hay imagenes en esta categoria'}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {filteredGroups.map((group) => {
                const swatchId = group.swatch.id;
                const isCollapsed = collapsed.has(swatchId);
                const isPanelOpen = mlPanelOpen.has(swatchId);
                const approvedInGroup = group.jobs.filter((j) => j.status === 'approved').length;
                const mlPicCount = (mlPictures.get(swatchId) || []).length;
                const isDirty = mlDirty.get(swatchId) || false;

                return (
                  <div key={swatchId} className={`rounded-xl border bg-card shadow-sm overflow-hidden ${isDirty ? 'ring-2 ring-blue-500' : ''}`}>
                    {/* Section header */}
                    <div className="flex items-center gap-4 px-4 py-3">
                      {/* Clickable area for collapse */}
                      <button
                        onClick={() => toggleSwatchCollapse(swatchId)}
                        className="flex items-center gap-4 flex-1 min-w-0 hover:bg-muted/50 -mx-1 px-1 py-0.5 rounded transition-colors text-left"
                      >
                        {/* Swatch thumbnail */}
                        {group.swatch.storage_path ? (
                          <div className="h-14 w-14 flex-shrink-0 rounded-lg overflow-hidden border bg-gray-100">
                            <img
                              src={getStorageUrl(group.swatch.storage_path)}
                              alt={group.swatch.name}
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : (
                          <div className="h-14 w-14 flex-shrink-0 rounded-lg border bg-gray-100 flex items-center justify-center">
                            <ImageIcon className="h-6 w-6 text-gray-300" />
                          </div>
                        )}

                        {/* Swatch info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-sm leading-tight truncate">{group.swatch.name}</p>
                            {group.swatch.sku_suffix && (
                              <Badge variant="outline" className="text-[10px] font-mono h-5 px-1.5">
                                {group.swatch.sku_suffix}
                              </Badge>
                            )}
                          </div>
                          {group.swatch.color_description && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{group.swatch.color_description}</p>
                          )}
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <p className="text-xs text-muted-foreground">
                              {group.jobs.length} imagen{group.jobs.length !== 1 ? 'es' : ''}
                              {approvedInGroup > 0 && (
                                <span className="text-green-600"> &middot; {approvedInGroup} aprobada{approvedInGroup !== 1 ? 's' : ''}</span>
                              )}
                            </p>
                            {group.ml_listing && (
                              <>
                                <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                                  {group.ml_listing.item_id}
                                </Badge>
                                <Badge variant="secondary" className={`text-[10px] h-5 px-1.5 ${mlStatusColor(group.ml_listing.status)}`}>
                                  {group.ml_listing.status}
                                </Badge>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Status summary */}
                        <div className="flex-shrink-0 flex items-center gap-1.5">
                          {approvedInGroup === group.jobs.length && group.jobs.length > 0 ? (
                            <Badge variant="default" className="text-xs bg-green-100 text-green-700 border-green-200">
                              <CheckCircle className="h-3 w-3 mr-1" />
                              Completo
                            </Badge>
                          ) : approvedInGroup > 0 ? (
                            <Badge variant="secondary" className="text-xs">
                              {approvedInGroup}/{group.jobs.length}
                            </Badge>
                          ) : null}
                        </div>

                        {/* Collapse chevron */}
                        <div className="flex-shrink-0 text-muted-foreground">
                          {isCollapsed
                            ? <ChevronRight className="h-5 w-5" />
                            : <ChevronDown className="h-5 w-5" />}
                        </div>
                      </button>

                      {/* ML buttons (outside the collapse click area) */}
                      {group.ml_listing && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1.5 text-xs text-muted-foreground"
                            disabled={mlImporting.has(swatchId)}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleImportMlPictures(swatchId);
                            }}
                            title="Importar fotos actuales de la publicación en ML"
                          >
                            {mlImporting.has(swatchId) ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Download className="h-3.5 w-3.5" />
                            )}
                            <span className="hidden sm:inline">Traer de ML</span>
                          </Button>
                          {showPerSwatchCannon && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 gap-1.5 text-xs text-muted-foreground"
                              disabled={importingCannonSwatch.has(swatchId)}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleImportCannonForSwatch(swatchId);
                              }}
                              title="Importar fotos de Cannon para este SKU"
                            >
                              {importingCannonSwatch.has(swatchId) ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Download className="h-3.5 w-3.5" />
                              )}
                              <span className="hidden sm:inline">Cannon</span>
                            </Button>
                          )}
                          {group.ml_listing.permalink && (
                            <a
                              href={group.ml_listing.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="Ver publicación en MercadoLibre"
                            >
                              <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground">
                                <ExternalLink className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">Publicación</span>
                              </Button>
                            </a>
                          )}
                          <Button
                            variant={isPanelOpen ? 'default' : 'ghost'}
                            size="sm"
                            className={`h-8 gap-1.5 text-xs ${isPanelOpen ? '' : 'text-muted-foreground'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleMlPanel(swatchId);
                            }}
                            title={isPanelOpen ? 'Cerrar panel ML' : 'Abrir panel ML'}
                          >
                            <Globe className="h-3.5 w-3.5" />
                            {!isPanelOpen && mlPicCount > 0 && (
                              <span>{mlPicCount}</span>
                            )}
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Section body */}
                    {!isCollapsed && (
                      <div className="px-4 pb-4 border-t">
                        <div className="flex gap-4 pt-4">
                          {/* LEFT: Results grid */}
                          <div className="flex-1 min-w-0">
                            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                              {group.jobs.map((job) => (
                                <JobCard key={job.id} job={job} swatchId={swatchId} />
                              ))}
                            </div>
                          </div>

                          {/* RIGHT: ML Panel (collapsible sidebar) */}
                          {isPanelOpen && group.ml_listing && (
                            <div className="w-72 flex-shrink-0 border-l pl-4">
                              <MlPanel group={group} />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ML Photo Selector Dialog */}
      <Dialog open={mlSelectorOpen} onOpenChange={(open) => {
        setMlSelectorOpen(open);
        if (!open) {
          setMlSelectorSwatchId(null);
          setMlSelectorPictures([]);
          setMlSelectorSelected(new Set());
          setMlSelectorSwatchName('');
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Importar fotos de ML</DialogTitle>
            <DialogDescription>
              Selecciona las fotos a importar para <strong>{mlSelectorSwatchName}</strong>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {/* Select all / deselect all */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {mlSelectorSelected.size} de {mlSelectorPictures.length} fotos seleccionadas
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setMlSelectorSelected(new Set(mlSelectorPictures.map((p) => p.id)))}
                  disabled={mlSelectorSelected.size === mlSelectorPictures.length}
                >
                  Seleccionar todas
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setMlSelectorSelected(new Set())}
                  disabled={mlSelectorSelected.size === 0}
                >
                  Deseleccionar todas
                </Button>
              </div>
            </div>

            {/* Photo grid */}
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[400px] overflow-y-auto">
              {mlSelectorPictures.map((pic, i) => {
                const isSelected = mlSelectorSelected.has(pic.id);
                return (
                  <button
                    key={pic.id}
                    type="button"
                    className={`relative aspect-square rounded-lg border-2 overflow-hidden bg-gray-100 transition-all ${
                      isSelected ? 'border-primary ring-1 ring-primary/30' : 'border-transparent opacity-50'
                    }`}
                    onClick={() => {
                      setMlSelectorSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(pic.id)) {
                          next.delete(pic.id);
                        } else {
                          next.add(pic.id);
                        }
                        return next;
                      });
                    }}
                  >
                    <img
                      src={pic.url}
                      alt={`Foto ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute top-1.5 left-1.5">
                      <Checkbox
                        checked={isSelected}
                        tabIndex={-1}
                        className="pointer-events-none bg-white/80"
                      />
                    </div>
                    <span className="absolute bottom-1 right-1.5 text-[10px] bg-black/50 text-white px-1 rounded">
                      {i + 1}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMlSelectorOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleConfirmMlImport}
              disabled={mlSelectorSelected.size === 0}
            >
              <Download className="mr-2 h-4 w-4" />
              Importar {mlSelectorSelected.size} foto{mlSelectorSelected.size !== 1 ? 's' : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replicate Publication Dialog */}
      <Dialog open={replicateOpen} onOpenChange={(open) => {
        setReplicateOpen(open);
        if (!open) {
          setReplicateSku('');
          setReplicateSkuResult(null);
          setReplicateTargetSwatch('');
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Replicar Publicacion</DialogTitle>
            <DialogDescription>
              Busca un SKU en MercadoLibre, selecciona el swatch destino y genera las variantes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Step 1: Source SKU */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">1. SKU Origen</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Ej: TXSB144IRK15P"
                  value={replicateSku}
                  onChange={(e) => setReplicateSku(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSkuLookup();
                  }}
                  className="font-mono"
                  disabled={replicateSkuSearching}
                />
                <Button
                  variant="outline"
                  onClick={handleSkuLookup}
                  disabled={!replicateSku.trim() || replicateSkuSearching}
                >
                  {replicateSkuSearching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Buscar'
                  )}
                </Button>
              </div>

              {/* SKU Result */}
              {replicateSkuResult && (
                <div className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{replicateSkuResult.titulo}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {replicateSkuResult.item_id}
                        </Badge>
                        <Badge variant="secondary" className={`text-[10px] ${
                          replicateSkuResult.status === 'active' ? 'bg-green-100 text-green-800' : ''
                        }`}>
                          {replicateSkuResult.status}
                        </Badge>
                      </div>
                    </div>
                    {replicateSkuResult.permalink && (
                      <a href={replicateSkuResult.permalink} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                      </a>
                    )}
                  </div>

                  {/* Photo thumbnails */}
                  {replicateSkuResult.pictures.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">
                        {replicateSkuResult.pictures.length} foto{replicateSkuResult.pictures.length !== 1 ? 's' : ''}
                      </p>
                      <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {replicateSkuResult.pictures.map((pic, i) => (
                          <div key={pic.id} className="h-14 w-14 flex-shrink-0 rounded border overflow-hidden bg-gray-100">
                            <img src={pic.url} alt={`Foto ${i + 1}`} className="h-full w-full object-cover" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Step 2: Target swatch */}
            {replicateSkuResult && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">2. Swatch destino (diseño a aplicar)</Label>
                <Select
                  value={replicateTargetSwatch}
                  onValueChange={setReplicateTargetSwatch}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Seleccionar swatch..." />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.swatch.id} value={g.swatch.id}>
                        <span className="flex items-center gap-2">
                          {g.swatch.storage_path && (
                            <img
                              src={getStorageUrl(g.swatch.storage_path)}
                              alt=""
                              className="h-8 w-8 rounded object-cover inline-block"
                            />
                          )}
                          {g.swatch.name}
                          {g.swatch.sku_suffix && (
                            <span className="text-xs text-muted-foreground font-mono">({g.swatch.sku_suffix})</span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {replicateTargetSwatch && (() => {
                  const selected = groups.find((g) => g.swatch.id === replicateTargetSwatch);
                  if (!selected?.swatch.storage_path) return null;
                  return (
                    <div className="mt-2 p-3 bg-muted rounded-lg">
                      <p className="text-xs text-muted-foreground mb-2">Imagen del swatch que se usará como diseño:</p>
                      <img
                        src={getStorageUrl(selected.swatch.storage_path)}
                        alt={selected.swatch.name}
                        className="w-full max-w-[200px] rounded-lg border"
                      />
                      <p className="text-xs mt-1 font-medium">{selected.swatch.name}</p>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Step 3: Summary */}
            {replicateSkuResult && replicateTargetSwatch && (() => {
              const targetGroup = groups.find((g) => g.swatch.id === replicateTargetSwatch);
              const photoCount = replicateSkuResult.pictures.length;
              const cost = photoCount * 0.05;
              return (
                <div className="rounded-md bg-muted/50 p-3 text-sm">
                  <p>
                    <strong>{photoCount}</strong> fotos de <strong className="font-mono">{replicateSkuResult.sku}</strong>
                    {' → '}diseno <strong>{targetGroup?.swatch.name || '?'}</strong>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Costo estimado: ~${cost.toFixed(2)} USD
                  </p>
                </div>
              );
            })()}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReplicateOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleReplicate}
              disabled={!replicateSkuResult || !replicateTargetSwatch || replicating}
            >
              {replicating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Replicando...
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" />
                  Replicar
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Stateless — instruction state is lifted to ResultsPage so it survives
// JobCard remounts triggered by the 10s polling refetch.
function EditPanel({ jobId, instruction, onInstructionChange, onUseAsHero, onGenerate15P, onEditImage }: {
  jobId: string;
  instruction: string;
  onInstructionChange: (value: string) => void;
  onUseAsHero: () => void;
  onGenerate15P: () => void;
  onEditImage: (instruction: string) => void;
}) {
  void jobId;
  return (
    <div className="mt-2 pt-2 border-t space-y-2">
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" className="h-7 text-xs text-amber-600" onClick={onUseAsHero}>
          <Star className="h-3 w-3 mr-1" /> Hero
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs text-purple-600" onClick={onGenerate15P}>
          <BedSingle className="h-3 w-3 mr-1" /> 1.5P
        </Button>
      </div>
      <div className="flex gap-1.5">
        <Input
          placeholder="Instruccion (ej: cambia 1 plaza por 2 plazas)"
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onEditImage(instruction);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-7 text-xs"
          autoFocus
        />
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={!instruction.trim()}
          onClick={() => onEditImage(instruction)}
        >
          <Send className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
