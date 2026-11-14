import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The page lives in web/ and is built into dist/, which the Express server serves.
//   npm run build      builds dist/ (this is what the deploy runs)
//   npm run dev:web    Vite dev server on :5173 with hot reload; API calls go to :3000
const api = 'http://localhost:3000';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/auth': api, '/me': api, '/hackathons': api, '/teams': api },
  },
});
