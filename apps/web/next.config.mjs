import withPWAInit from 'next-pwa';

const withPWA = withPWAInit({
  dest: 'public',
  register: true,
  skipWaiting: true,
  // A service worker caching HTML in dev makes every edit look like it did
  // nothing, so it is only active in production builds.
  disable: process.env.NODE_ENV === 'development',
  // Never serve a cached shell for API routes or the WebRTC/webhook paths —
  // stale telephony state is worse than no state.
  buildExcludes: [/middleware-manifest\.json$/],
  runtimeCaching: [
    {
      urlPattern: /^\/api\//,
      handler: 'NetworkOnly',
    },
    {
      urlPattern: /\.(?:png|jpg|jpeg|svg|webp|ico|woff2)$/,
      handler: 'CacheFirst',
      options: {
        cacheName: 'static-assets',
        expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
      },
    },
    {
      urlPattern: /^\/(dialer|conversations|automations|settings)/,
      handler: 'NetworkFirst',
      options: { cacheName: 'pages' },
    },
  ],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // packages/db ships TypeScript source rather than a build step, so Next has
  // to compile it like first-party code.
  transpilePackages: ['@actualizecrm/db'],
  eslint: {
    // Lint is run explicitly via `npm run lint`; a lint error should not block
    // a local build the operator is trying to use.
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Prisma's query engine is a native binary that must not be bundled.
    serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
  },
};

export default withPWA(nextConfig);
