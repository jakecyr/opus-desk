import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const apiOrigin = `http://127.0.0.1:${process.env.PORT || 4317}`;
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            // Preserve the API's origin guard while allowing this local dev UI.
            if (incoming.headers.origin === `http://${incoming.headers.host}`) {
              outgoing.setHeader('origin', apiOrigin);
            }
          });
        },
      },
    },
  },
});
