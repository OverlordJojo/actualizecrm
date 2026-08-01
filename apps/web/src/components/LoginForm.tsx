'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';

export function LoginForm() {
  const params = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not sign in.');

      // A full page load rather than a client-side push: the app shell mounts
      // the softphone on first render, and it should do that once, cleanly,
      // with the session cookie already in place.
      const next = params.get('next');
      window.location.href = next && next.startsWith('/') ? next : '/dialer';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="panel w-full max-w-[340px] space-y-4 p-6"
    >
      <div className="flex flex-col items-center gap-2 pb-1">
        <Image src="/icon-192.png" alt="" width={40} height={40} priority />
        <h1 className="text-sm font-semibold text-ink-100">ActualizeCRM</h1>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div>
        <label className="label" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          className="input"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          className="input"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <button
        type="submit"
        className="btn-primary w-full"
        disabled={busy || !username || !password}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
