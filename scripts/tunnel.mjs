// Builds the app, serves it and opens a Cloudflare quick tunnel, then prints the URL as a QR.
// It serves the production build because that is what can be installed and work offline.
//
//   pnpm tunnel                         runs until Ctrl+C
//   pnpm tunnel --hours 3               closes itself after 3 hours
//   pnpm tunnel --hours 3 --background  same, detached, with its output in tunnel.log
import { spawn, spawnSync } from 'node:child_process';
import { openSync } from 'node:fs';
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';

const { values } = parseArgs({ options: { hours: { type: 'string' }, background: { type: 'boolean' } } });
const hours = Number(values.hours ?? 0);

if (values.background) {
  // A detached tunnel has no terminal to press Ctrl+C in, so it must have an end.
  if (!hours) {
    console.error('--background necesita --hours.');
    process.exit(1);
  }
  const log = openSync('tunnel.log', 'w');
  const child = spawn(process.execPath, [process.argv[1], '--hours', values.hours], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  console.log(`Túnel en segundo plano (PID ${child.pid}). La URL y el QR quedan en tunnel.log.`);
  process.exit();
}

const options = { shell: true, windowsHide: true };

const build = spawnSync('pnpm exec vite build --mode tunnel', { ...options, stdio: 'inherit' });
if (build.status) process.exit(build.status);

const server = spawn('pnpm exec vite preview --mode tunnel', { ...options, stdio: 'inherit' });
const tunnel = spawn('cloudflared tunnel --no-autoupdate --url http://localhost:5173', options);

const closesAt = hours ? new Date(Date.now() + hours * 3600000) : null;

let shown = false;
const onOutput = (chunk) => {
  const url = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || shown) return;
  shown = true;
  console.log(`\n  Abre en el celular: ${url}\n  Cualquiera con este enlace puede ver la web.`);
  console.log(closesAt ? `  Se cierra solo a las ${closesAt.toLocaleTimeString('es')}.\n` : '  Ctrl+C la cierra.\n');
  qrcode.generate(url, { small: true });
};
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);

// Each child is a shell that started the real process, so the whole tree has to go.
const kill = (child) => spawnSync(`taskkill /pid ${child.pid} /T /F`, { ...options, stdio: 'ignore' });
const stop = () => {
  kill(server);
  kill(tunnel);
  process.exit();
};
process.on('SIGINT', stop);
server.on('exit', stop);
tunnel.on('exit', (code) => {
  console.error(`cloudflared terminó (código ${code}).`);
  stop();
});
if (closesAt) setTimeout(stop, closesAt - Date.now());
