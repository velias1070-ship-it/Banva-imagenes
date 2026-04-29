'use client';

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setErrorMsg(null);
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const next = new URLSearchParams(window.location.search).get('next') || '/admin';
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (error) {
      setStatus('error');
      setErrorMsg(error.message);
      return;
    }
    setStatus('sent');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          {status === 'sent' ? (
            <p className="text-sm text-green-700">
              Magic link sent to <code>{email}</code>. Check your inbox.
            </p>
          ) : (
            <form onSubmit={send} className="space-y-4">
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded border px-3 py-2"
              />
              <Button type="submit" disabled={status === 'sending'} className="w-full">
                {status === 'sending' ? 'Sending…' : 'Send magic link'}
              </Button>
              {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
