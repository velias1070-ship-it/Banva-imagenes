'use client';

import { useCallback, useState } from 'react';
import { Upload, X, ImageIcon, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface UploadedFile {
  id: string;
  filename: string;
  previewUrl: string;
  file: File;
  compressed?: boolean;
  originalSizeMB?: number;
}

interface DropzoneProps {
  onUpload: (files: File[]) => Promise<void>;
  accept?: string;
  maxFiles?: number;
  maxSizeMB?: number;
  label?: string;
  description?: string;
  uploading?: boolean;
}

const UPLOAD_LIMIT_MB = 4;
const MAX_DIMENSION = 4096;
const COMPRESS_QUALITY = 0.85;

/**
 * Compress an image file using Canvas API.
 * Resizes if needed and converts to JPEG to reduce file size.
 */
async function compressImage(file: File, targetMaxMB: number): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;

      // Scale down if exceeds max dimension
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas not supported'));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      // Try JPEG first at high quality, reduce if still too large
      let quality = COMPRESS_QUALITY;
      const tryCompress = () => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Compression failed'));
              return;
            }

            if (blob.size > targetMaxMB * 1024 * 1024 && quality > 0.5) {
              quality -= 0.1;
              tryCompress();
              return;
            }

            // Keep original extension if already JPEG, otherwise use .jpg
            const origName = file.name.replace(/\.[^.]+$/, '');
            const newName = `${origName}.jpg`;
            const compressed = new File([blob], newName, {
              type: 'image/jpeg',
              lastModified: Date.now(),
            });
            resolve(compressed);
          },
          'image/jpeg',
          quality
        );
      };

      tryCompress();
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

export function Dropzone({
  onUpload,
  accept = 'image/*',
  maxFiles = 20,
  maxSizeMB = UPLOAD_LIMIT_MB,
  label = 'Arrastra imagenes aqui',
  description = 'o haz click para seleccionar',
  uploading = false,
}: DropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [previews, setPreviews] = useState<UploadedFile[]>([]);
  const [compressing, setCompressing] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files).slice(0, maxFiles);
      const maxBytes = maxSizeMB * 1024 * 1024;

      setCompressing(true);
      const processed: UploadedFile[] = [];
      const errors: string[] = [];

      for (const file of fileArray) {
        if (file.size <= maxBytes) {
          // File is small enough — use as-is
          processed.push({
            id: crypto.randomUUID(),
            filename: file.name,
            previewUrl: URL.createObjectURL(file),
            file,
          });
        } else {
          // File too large — try to compress
          try {
            const originalMB = file.size / 1024 / 1024;
            const compressed = await compressImage(file, maxSizeMB);
            const compressedMB = compressed.size / 1024 / 1024;

            if (compressed.size > maxBytes) {
              errors.push(`${file.name} (${originalMB.toFixed(1)}MB → ${compressedMB.toFixed(1)}MB, aun muy grande)`);
            } else {
              processed.push({
                id: crypto.randomUUID(),
                filename: compressed.name,
                previewUrl: URL.createObjectURL(compressed),
                file: compressed,
                compressed: true,
                originalSizeMB: originalMB,
              });
              toast.success(
                `${file.name} comprimido: ${originalMB.toFixed(1)}MB → ${compressedMB.toFixed(1)}MB`
              );
            }
          } catch {
            errors.push(`${file.name} — error al comprimir`);
          }
        }
      }

      setCompressing(false);

      if (errors.length > 0) {
        toast.error(`No se pudieron procesar: ${errors.join(', ')}`);
      }

      if (processed.length > 0) {
        setPreviews((prev) => [...prev, ...processed].slice(0, maxFiles));
      }
    },
    [maxFiles, maxSizeMB]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        processFiles(e.target.files);
        // Reset input so the same file can be selected again
        e.target.value = '';
      }
    },
    [processFiles]
  );

  const removePreview = useCallback((id: string) => {
    setPreviews((prev) => {
      const removed = prev.find((p) => p.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const handleUploadAll = useCallback(async () => {
    if (previews.length === 0) return;
    const files = previews.map((p) => p.file);
    await onUpload(files);
    // Clean up preview URLs
    previews.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPreviews([]);
  }, [previews, onUpload]);

  return (
    <div className="space-y-4">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors',
          isDragging
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 bg-gray-50 hover:border-gray-400'
        )}
      >
        {compressing ? (
          <>
            <Loader2 className="mb-3 h-10 w-10 animate-spin text-blue-500" />
            <p className="text-sm font-medium text-blue-600">Comprimiendo imagenes...</p>
          </>
        ) : (
          <>
            <Upload className="mb-3 h-10 w-10 text-gray-400" />
            <p className="text-sm font-medium text-gray-700">{label}</p>
            <p className="mt-1 text-xs text-gray-500">{description}</p>
            <p className="mt-1 text-xs text-gray-400">
              PNG, JPG, WEBP (max {maxFiles} archivos, auto-comprime si es grande)
            </p>
          </>
        )}
        <input
          type="file"
          accept={accept}
          multiple
          onChange={handleFileSelect}
          className="absolute inset-0 cursor-pointer opacity-0"
          disabled={compressing}
        />
      </div>

      {previews.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {previews.map((preview) => (
              <div key={preview.id} className="group relative aspect-square overflow-hidden rounded-lg border bg-white">
                <img
                  src={preview.previewUrl}
                  alt={preview.filename}
                  className="h-full w-full object-cover"
                />
                <button
                  onClick={() => removePreview(preview.id)}
                  className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
                <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1">
                  <p className="truncate text-[10px] text-white">
                    {preview.filename}
                    {preview.compressed && (
                      <span className="ml-1 text-green-300">
                        ({preview.originalSizeMB?.toFixed(1)}MB→{(preview.file.size / 1024 / 1024).toFixed(1)}MB)
                      </span>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {previews.length} {previews.length === 1 ? 'archivo' : 'archivos'} seleccionados
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  previews.forEach((p) => URL.revokeObjectURL(p.previewUrl));
                  setPreviews([]);
                }}
                disabled={uploading}
              >
                Limpiar
              </Button>
              <Button size="sm" onClick={handleUploadAll} disabled={uploading}>
                {uploading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Subiendo...
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Subir {previews.length}
                  </>
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
