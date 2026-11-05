/// <reference types="node" />
// The config runs in Node, while tsconfig's types are the browser's for the app code.
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import { defineConfig, type Plugin } from 'vite';

// Prints a QR with the LAN URL so the phone can open the dev server directly.
function phoneQr(): Plugin {
  return {
    name: 'phone-qr',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        setTimeout(() => {
          const url = server.resolvedUrls?.network.find((u) => /\/\/(192\.168|10\.)/.test(u)) ?? server.resolvedUrls?.network[0];
          if (!url) return;
          console.log(`\n  Escanea con el celular (${url}):\n`);
          qrcode.generate(url, { small: true });
        }, 100);
      });
    },
  };
}

// Writes the service worker with the exact list of built files, which is what lets the
// installed app open without the PC or the tunnel.
function offline(): Plugin {
  return {
    name: 'offline',
    apply: 'build',
    closeBundle() {
      const dist = join(process.cwd(), 'dist');
      const files = (readdirSync(dist, { recursive: true }) as string[])
        .filter((file) => statSync(join(dist, file)).isFile())
        .map((file) => `/${file.replaceAll('\\', '/')}`)
        .filter((file) => file !== '/sw.js' && file !== '/index.html');
      const heavy = (file: string) => file.includes('tracker.worker');
      const required = ['/', ...files.filter((file) => !heavy(file))];
      const template = readFileSync('scripts/sw.template.js', 'utf8');
      const hash = createHash('sha256').update(files.join() + template).digest('hex').slice(0, 12);
      const worker = template
        .replace('__VERSION__', hash)
        .replace('__REQUIRED__', JSON.stringify(required))
        .replace('__OPTIONAL__', JSON.stringify(files.filter(heavy)));
      writeFileSync(join(dist, 'sw.js'), worker);
    },
  };
}

export default defineConfig(({ mode }) => {
  // Behind Cloudflare the public URL is already HTTPS, so Vite stays on plain local HTTP.
  const tunnel = mode === 'tunnel';
  const allowedHosts = tunnel ? ['.trycloudflare.com'] : undefined;
  return {
    plugins: [...(tunnel ? [] : [basicSsl(), phoneQr()]), offline()],
    server: {
      host: tunnel ? 'localhost' : true,
      port: 5173,
      strictPort: true,
      allowedHosts,
      hmr: tunnel ? { clientPort: 443 } : undefined,
    },
    preview: { host: tunnel ? 'localhost' : true, port: 5173, strictPort: true, allowedHosts },
    worker: { format: 'es' },
    build: { target: 'es2022' },
  };
});
