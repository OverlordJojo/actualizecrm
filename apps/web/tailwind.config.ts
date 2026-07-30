import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Neutral shell. `ink-850` fills the gap Tailwind leaves between
        // 800 and 900, which is where most raised surfaces sit here.
        ink: {
          100: '#e8eaed',
          200: '#c8ccd4',
          300: '#a3a9b5',
          400: '#7d8494',
          500: '#5c6373',
          600: '#434a59',
          700: '#323847',
          800: '#242938',
          850: '#1c2130',
          900: '#161a26',
          950: '#0e111a',
        },
        // Gold, sampled from the ActualizeCRM monogram.
        brand: {
          300: '#eeddb0',
          400: '#e4cd8f',
          500: '#d9bc71',
          600: '#c5a558',
          700: '#a68843',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Active Lead Card scale — readable mid-call without leaning in.
        'lead-name': ['2.75rem', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        'lead-sub': ['1.375rem', { lineHeight: '1.25' }],
        'lead-phone': ['2rem', { lineHeight: '1.1', letterSpacing: '-0.01em' }],
      },
    },
  },
  plugins: [],
};

export default config;
