import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Fixed file names: the extension links webview.js / style.css by name through
// asWebviewUri, so nothing is hashed; relative base for vscode-resource URLs.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: { webview: 'index.html' },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
