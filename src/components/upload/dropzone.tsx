'use client';

import { useCallback, useState } from 'react';
import { Upload, X, ImageIcon, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface UploadedFile {
  id: string;
  filename: string;
  previewUrl: string;
  file: File;
}

interface DropzoneProps {
  onUpload: (files: File[]) => Promise<void>;
  accept?: string;
  maxFiles?: number;
  label?: string;
  description?: string;
  uploading?: boolean;
}

export function Dropzone({
  onUpload,
  accept = 'image/*',
  maxFiles = 20,
  label = 'Arrastra imagenes aqui',
  description = 'o haz click para seleccionar',
  uploading = false,
}: DropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [previews, setPreviews] = useState<UploadedFile[]>([]);

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
    (files: FileList | File[]) => {
      const fileArray = Array.from(files).slice(0, maxFiles);
      const newPreviews: UploadedFile[] = fileArray.map((file) => ({
        id: crypto.randomUUID(),
        filename: file.name,
        previewUrl: URL.createObjectURL(file),
        file,
      }));
      setPreviews((prev) => [...prev, ...newPreviews].slice(0, maxFiles));
    },
    [maxFiles]
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
        <Upload className="mb-3 h-10 w-10 text-gray-400" />
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <p className="mt-1 text-xs text-gray-500">{description}</p>
        <p className="mt-1 text-xs text-gray-400">PNG, JPG, WEBP (max {maxFiles} archivos)</p>
        <input
          type="file"
          accept={accept}
          multiple
          onChange={handleFileSelect}
          className="absolute inset-0 cursor-pointer opacity-0"
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
                  <p className="truncate text-[10px] text-white">{preview.filename}</p>
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
