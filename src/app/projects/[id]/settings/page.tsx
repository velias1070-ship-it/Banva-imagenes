'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Settings, Save, RotateCcw, Loader2,
  Sliders, ShieldCheck, BarChart3, AlertTriangle, Palette,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import type { ProjectSettings } from '@/lib/project-settings';

interface SwatchData {
  id: string;
  name: string;
  color_description: string | null;
  dominant_color_hex: string | null;
  storage_path: string;
}

export default function SettingsPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [defaults, setDefaults] = useState<ProjectSettings | null>(null);
  const [isCustomized, setIsCustomized] = useState(false);
  const [swatches, setSwatches] = useState<SwatchData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null); // which section is saving
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [projectName, setProjectName] = useState('');

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchSettings = useCallback(async () => {
    try {
      const [settingsRes, swatchesRes, projectRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/settings`),
        fetch(`/api/projects/${projectId}/swatches`),
        fetch(`/api/projects/${projectId}`),
      ]);

      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setSettings(data.settings);
        setDefaults(data.defaults);
        setIsCustomized(data.is_customized);
      }

      if (swatchesRes.ok) {
        const data = await swatchesRes.json();
        setSwatches(Array.isArray(data) ? data : (data.swatches || []));
      }

      if (projectRes.ok) {
        const data = await projectRes.json();
        setProjectName(data.name || '');
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async (section?: string) => {
    if (!settings) return;
    setSaving(section || 'all');
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings);
        setIsCustomized(true);
        showToast('Configuracion guardada');
      } else {
        showToast('Error al guardar', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    } finally {
      setSaving(null);
    }
  };

  const resetToDefaults = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings);
        setIsCustomized(false);
        showToast('Restaurado a valores por defecto');
      }
    } catch {
      showToast('Error al restaurar', 'error');
    }
  };

  const saveSwatch = async (swatchId: string, name: string, colorDescription: string) => {
    setSaving(`swatch-${swatchId}`);
    try {
      const res = await fetch(`/api/projects/${projectId}/swatches/${swatchId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color_description: colorDescription || null }),
      });
      if (res.ok) {
        showToast('Swatch actualizado');
      } else {
        showToast('Error al actualizar swatch', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    } finally {
      setSaving(null);
    }
  };

  const updateGeneration = (field: string, value: unknown) => {
    if (!settings) return;
    setSettings({
      ...settings,
      generation: { ...settings.generation, [field]: value },
    });
  };

  const updateQA = (field: string, value: unknown) => {
    if (!settings) return;
    setSettings({
      ...settings,
      qa: { ...settings.qa, [field]: value },
    });
  };

  const updateWeight = (field: string, value: number) => {
    if (!settings) return;
    setSettings({
      ...settings,
      scoring_weights: { ...settings.scoring_weights, [field]: value },
    });
  };

  const updateBatch = (field: string, value: unknown) => {
    if (!settings) return;
    setSettings({
      ...settings,
      batch: { ...settings.batch, [field]: value },
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!settings || !defaults) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">No se pudieron cargar los settings.</p>
      </div>
    );
  }

  const weightsSum = Object.values(settings.scoring_weights).reduce((a, b) => a + b, 0);
  const weightsSumPct = Math.round(weightsSum * 100);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';

  return (
    <div className="p-8">
      {/* Toast notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${
          toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <Link href={`/projects/${projectId}`} className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Proyecto
      </Link>

      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Settings className="h-6 w-6 text-gray-500" />
          <div>
            <h1 className="text-2xl font-bold">Configuracion</h1>
            <p className="text-sm text-muted-foreground">{projectName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isCustomized && (
            <Badge variant="secondary">Personalizado</Badge>
          )}
          <Button variant="outline" size="sm" onClick={resetToDefaults}>
            <RotateCcw className="mr-1 h-4 w-4" />
            Restaurar defaults
          </Button>
        </div>
      </div>

      <div className="space-y-6 max-w-4xl">
        {/* ── Card 1: Generacion ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sliders className="h-5 w-5 text-blue-500" />
              <div>
                <CardTitle className="text-base">Generacion de Imagenes</CardTitle>
                <CardDescription>Resolucion, temperatura y modo de generacion</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Resolucion (px)</Label>
                <Select
                  value={settings.generation.resolution}
                  onValueChange={(v) => updateGeneration('resolution', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1024x1024">1024 x 1024</SelectItem>
                    <SelectItem value="768x768">768 x 768</SelectItem>
                    <SelectItem value="512x512">512 x 512</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Tamano de las imagenes generadas</p>
              </div>

              <div className="space-y-2">
                <Label>Temperatura</Label>
                <Input
                  type="number"
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  value={settings.generation.temperature}
                  onChange={(e) => updateGeneration('temperature', parseFloat(e.target.value) || 0.2)}
                />
                <p className="text-xs text-muted-foreground">Creatividad (0.1 = preciso, 1.0 = creativo)</p>
              </div>

              <div className="space-y-2">
                <Label>Modo de generacion</Label>
                <Select
                  value={settings.generation.mode}
                  onValueChange={(v) => updateGeneration('mode', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Automatico (por categoria)</SelectItem>
                    <SelectItem value="edit">Edicion (hero + swatch)</SelectItem>
                    <SelectItem value="reference">Referencia (composicion + swatch)</SelectItem>
                    <SelectItem value="from_scratch">Desde cero (solo swatch)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Como se genera cada imagen</p>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={() => saveSettings('generation')} disabled={saving === 'generation'}>
                {saving === 'generation' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                Guardar
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Card 2: Control de Calidad ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-green-500" />
              <div>
                <CardTitle className="text-base">Control de Calidad (QA)</CardTitle>
                <CardDescription>Umbrales de aprobacion, reintentos y bloqueos</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Umbral aprobacion automatica (%)</Label>
                <Input
                  type="number"
                  min={50}
                  max={100}
                  step={5}
                  value={Math.round(settings.qa.auto_approve_threshold * 100)}
                  onChange={(e) => updateQA('auto_approve_threshold', (parseInt(e.target.value) || 80) / 100)}
                />
                <p className="text-xs text-muted-foreground">Score QA mayor o igual = aprobado (default: 80%)</p>
              </div>

              <div className="space-y-2">
                <Label>Umbral de reintento (%)</Label>
                <Input
                  type="number"
                  min={30}
                  max={90}
                  step={5}
                  value={Math.round(settings.qa.retry_threshold * 100)}
                  onChange={(e) => updateQA('retry_threshold', (parseInt(e.target.value) || 60) / 100)}
                />
                <p className="text-xs text-muted-foreground">Score entre este valor y aprobacion = reintento (default: 60%)</p>
              </div>

              <div className="space-y-2">
                <Label>Maximo reintentos</Label>
                <Select
                  value={String(settings.qa.max_retries)}
                  onValueChange={(v) => updateQA('max_retries', parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n} {n === 1 ? 'reintento' : 'reintentos'}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Intentos antes de marcar como flagged (default: 2)</p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="fidelity-blocker"
                    checked={settings.qa.product_fidelity_blocker}
                    onCheckedChange={(checked) => updateQA('product_fidelity_blocker', !!checked)}
                  />
                  <Label htmlFor="fidelity-blocker">Bloqueador de fidelidad</Label>
                </div>
                {settings.qa.product_fidelity_blocker && (
                  <div className="space-y-2 pl-6">
                    <Label>Umbral bloqueador (%)</Label>
                    <Input
                      type="number"
                      min={20}
                      max={80}
                      step={5}
                      value={Math.round(settings.qa.product_fidelity_blocker_threshold * 100)}
                      onChange={(e) => updateQA('product_fidelity_blocker_threshold', (parseInt(e.target.value) || 40) / 100)}
                    />
                    <p className="text-xs text-muted-foreground">Fidelidad menor = flagged inmediato (default: 40%)</p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={() => saveSettings('qa')} disabled={saving === 'qa'}>
                {saving === 'qa' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                Guardar
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Card 3: Pesos de Evaluacion ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-purple-500" />
              <div>
                <CardTitle className="text-base">Pesos de Evaluacion QA</CardTitle>
                <CardDescription>
                  Importancia de cada dimension en el score final.
                  Deben sumar 100%.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { key: 'product_fidelity', label: 'Fidelidad del producto', defaultPct: 30 },
                { key: 'color_accuracy', label: 'Precision de color', defaultPct: 20 },
                { key: 'composition_match', label: 'Composicion', defaultPct: 20 },
                { key: 'visual_quality', label: 'Calidad visual', defaultPct: 15 },
                { key: 'resolution', label: 'Resolucion', defaultPct: 5 },
                { key: 'aspect_ratio', label: 'Ratio de aspecto', defaultPct: 5 },
                { key: 'ml_compliance', label: 'Cumplimiento ML', defaultPct: 5 },
              ].map(({ key, label, defaultPct }) => (
                <div key={key} className="flex items-center gap-2">
                  <Label className="w-40 text-sm">{label}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    className="w-20"
                    value={Math.round((settings.scoring_weights[key as keyof typeof settings.scoring_weights]) * 100)}
                    onChange={(e) => updateWeight(key, (parseInt(e.target.value) || 0) / 100)}
                  />
                  <span className="text-xs text-muted-foreground">% (def: {defaultPct}%)</span>
                </div>
              ))}
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Total:</span>
                <Badge variant={weightsSumPct === 100 ? 'default' : 'destructive'}>
                  {weightsSumPct}%
                </Badge>
                {weightsSumPct !== 100 && (
                  <span className="text-xs text-red-500">
                    (debe sumar 100% — se normalizara automaticamente al guardar)
                  </span>
                )}
              </div>
              <Button size="sm" onClick={() => saveSettings('weights')} disabled={saving === 'weights'}>
                {saving === 'weights' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                Guardar
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Card 4: Control de Batch ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <div>
                <CardTitle className="text-base">Control de Batch</CardTitle>
                <CardDescription>Cuando detener automaticamente un batch con problemas</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>% flagged para detener batch</Label>
                <Input
                  type="number"
                  min={10}
                  max={50}
                  step={5}
                  value={Math.round(settings.batch.halt_flagged_percent * 100)}
                  onChange={(e) => updateBatch('halt_flagged_percent', (parseInt(e.target.value) || 20) / 100)}
                />
                <p className="text-xs text-muted-foreground">Si mas de este % son flagged, el batch se detiene (default: 20%)</p>
              </div>

              <div className="space-y-2">
                <Label>Minimo procesados antes de evaluar</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={settings.batch.halt_min_processed}
                  onChange={(e) => updateBatch('halt_min_processed', parseInt(e.target.value) || 5)}
                />
                <p className="text-xs text-muted-foreground">No evaluar halt hasta procesar al menos N imagenes (default: 5)</p>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={() => saveSettings('batch')} disabled={saving === 'batch'}>
                {saving === 'batch' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                Guardar
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Card 5: Swatches ── */}
        {swatches.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Palette className="h-5 w-5 text-pink-500" />
                <div>
                  <CardTitle className="text-base">Swatches</CardTitle>
                  <CardDescription>Editar nombres y descripciones de color de cada variante</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {swatches.map((swatch) => (
                  <SwatchRow
                    key={swatch.id}
                    swatch={swatch}
                    supabaseUrl={supabaseUrl}
                    saving={saving === `swatch-${swatch.id}`}
                    onSave={(name, color) => saveSwatch(swatch.id, name, color)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Swatch row component
// ─────────────────────────────────────────────────────────────────────────────

function SwatchRow({
  swatch,
  supabaseUrl,
  saving,
  onSave,
}: {
  swatch: SwatchData;
  supabaseUrl: string;
  saving: boolean;
  onSave: (name: string, colorDescription: string) => void;
}) {
  const [name, setName] = useState(swatch.name);
  const [color, setColor] = useState(swatch.color_description || '');

  const thumbUrl = swatch.storage_path
    ? `${supabaseUrl}/storage/v1/object/public/images/${swatch.storage_path}`
    : null;

  const isDirty = name !== swatch.name || color !== (swatch.color_description || '');

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      {/* Thumbnail */}
      {thumbUrl && (
        <img
          src={thumbUrl}
          alt={swatch.name}
          className="h-12 w-12 rounded object-cover border"
        />
      )}

      {/* Color hex indicator */}
      {swatch.dominant_color_hex && (
        <div
          className="h-6 w-6 rounded-full border"
          style={{ backgroundColor: swatch.dominant_color_hex }}
          title={swatch.dominant_color_hex}
        />
      )}

      {/* Name input */}
      <div className="flex-1 space-y-1">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nombre del swatch"
          className="h-8 text-sm"
        />
      </div>

      {/* Color description input */}
      <div className="w-48 space-y-1">
        <Input
          value={color}
          onChange={(e) => setColor(e.target.value)}
          placeholder="Color (ej: sage green)"
          className="h-8 text-sm"
        />
      </div>

      {/* Save button */}
      <Button
        size="sm"
        variant={isDirty ? 'default' : 'outline'}
        disabled={saving || !isDirty}
        onClick={() => onSave(name, color)}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      </Button>
    </div>
  );
}
