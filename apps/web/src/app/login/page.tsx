import { Suspense } from 'react';
import { LoginForm } from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in · ActualizeCRM' };

export default function LoginPage() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-ink-950 p-6">
      {/* useSearchParams needs a Suspense boundary in the App Router. */}
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
