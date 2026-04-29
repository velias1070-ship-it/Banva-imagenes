import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAdminContext } from '@/lib/admin-auth';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAdminContext();
  if (!ctx) redirect('/login?next=/admin');

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="font-bold">BANVA Admin</Link>
            <nav className="flex gap-4 text-sm">
              <Link href="/admin/models" className="hover:underline">Models</Link>
              <Link href="/admin/benchmarks" className="hover:underline">Benchmarks</Link>
              <Link href="/admin/performance" className="hover:underline">Performance</Link>
              <Link href="/admin/costos" className="hover:underline">Costos</Link>
            </nav>
          </div>
          <span className="text-xs text-muted-foreground">{ctx.email}</span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-6">{children}</main>
    </div>
  );
}
