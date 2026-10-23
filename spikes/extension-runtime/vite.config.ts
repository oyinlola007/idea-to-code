import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Fixed file names: the extension host links webview.js / webview.css by name
// through asWebviewUri, so nothing can be hashed.
export default defineConfig({
  root: 'webview',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../out/webview',
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      input: { webview: 'webview/index.html', harness: 'webview/harness.html' },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
