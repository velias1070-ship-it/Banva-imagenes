'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  FolderOpen,
  Search,
  Settings,
  ImageIcon,
  TrendingUp,
  Palette,
  Copy,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Proyectos', icon: FolderOpen },
  { href: '/brands', label: 'Brand Books', icon: Palette },
  { href: '/search', label: 'Buscar Imagenes', icon: Search },
  { href: '/replicate', label: 'Replicar Fotos', icon: Copy },
  { href: '/performance', label: 'Performance ML', icon: TrendingUp },
];

const STORAGE_KEY = 'banva-sidebar-collapsed';

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === '1') setCollapsed(true);
    } catch {}
    setHydrated(true);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  return (
    <aside
      className={cn(
        'relative flex h-screen flex-col border-r bg-white transition-[width] duration-200 ease-out',
        hydrated && collapsed ? 'w-16' : 'w-64'
      )}
    >
      <button
        onClick={toggle}
        aria-label={collapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
        className="absolute -right-3 top-20 z-10 flex h-6 w-6 items-center justify-center rounded-full border bg-white text-gray-500 shadow-sm hover:bg-gray-50 hover:text-gray-700"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>

      <div
        className={cn(
          'flex h-16 items-center gap-2 border-b',
          collapsed ? 'justify-center px-2' : 'px-6'
        )}
      >
        <ImageIcon className="h-6 w-6 shrink-0 text-blue-600" />
        {!collapsed && (
          <>
            <span className="text-lg font-bold">BANVA</span>
            <span className="text-xs text-muted-foreground">Pipeline</span>
          </>
        )}
      </div>

      <nav className={cn('flex-1 space-y-1', collapsed ? 'p-2' : 'p-4')}>
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg text-sm transition-colors',
                collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2',
                isActive
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className={cn('border-t', collapsed ? 'p-2' : 'p-4')}>
        <Link
          href="/settings"
          title={collapsed ? 'Configuracion' : undefined}
          className={cn(
            'flex items-center gap-3 rounded-lg text-sm text-gray-600 hover:bg-gray-100',
            collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2'
          )}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Configuracion</span>}
        </Link>
      </div>
    </aside>
  );
}
