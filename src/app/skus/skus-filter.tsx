'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Search } from 'lucide-react';

export function SkusFilter({
  initialQuery,
  initialStatus,
}: {
  initialQuery: string;
  initialStatus: 'active' | 'archived' | 'all';
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => {
      router.replace(`/skus?${next.toString()}`);
    });
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[240px] max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          defaultValue={initialQuery}
          onChange={(e) => updateParam('q', e.target.value)}
          placeholder="Buscar por nombre, código o familia..."
          className="pl-9"
        />
      </div>
      <Tabs
        value={initialStatus}
        onValueChange={(v) => updateParam('status', v === 'active' ? '' : v)}
      >
        <TabsList>
          <TabsTrigger value="active">Activos</TabsTrigger>
          <TabsTrigger value="archived">Archivados</TabsTrigger>
          <TabsTrigger value="all">Todos</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
