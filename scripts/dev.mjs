#!/usr/bin/env node

/**
 * `pnpm dev`, with the ports resolved before Turborepo starts.
 *
 * The two apps cannot negotiate ports between themselves. The browser reaches the API through
 * `NEXT_PUBLIC_API_URL`, which Next inlines into the client bundle as it boots, so an API that
 * retried `EADDRINUSE` on its own would come up on a port the web app has already been told is
 * something else — a working backend the frontend cannot see. That failure is silent, which is
 * strictly worse than the crash it replaces.
 *
 * So the decision is made once, here, before either task exists: probe for free ports, then
 * hand both apps values that already agree. `PORT` is the API's (read by `main.ts`), `WEB_PORT`
 * is the web app's, and `NEXT_PUBLIC_API_URL` is derived from the API's.
 *
 * Development only. `pnpm build` bakes in whatever `NEXT_PUBLIC_API_URL` is set at build time,
 * and that is correct — a deployed port is configuration, not something to guess.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_API_PORT = 3001;
const DEFAULT_WEB_PORT = 3000;

/** How far above a preferred port to look before giving up rather than drifting silently. */
const SEARCH_RANGE = 20;

/**
 * Where each setting is read from, in precedence order — the same order the app that consumes
 * it uses, plus the shared root `.env` as the last stop. Nest's `ConfigModule` reads
 * `.env.local` then `.env`; Next loads `.env.local` then `.env`. Neither overrides a variable
 * already present in the environment, which is what lets the values chosen here win.
 */
const API_ENV_FILES = ['apps/api/.env.local', 'apps/api/.env', '.env'];
const WEB_ENV_FILES = ['apps/web/.env.local', 'apps/web/.env', '.env'];

const envFileCache = new Map();

/** A deliberately small `KEY=VALUE` reader — enough to find a port, and no new dependency. */
function readEnvFile(relativePath) {
  const cached = envFileCache.get(relativePath);

  if (cached !== undefined) {
    return cached;
  }

  const parsed = {};

  try {
    for (const line of readFileSync(join(repoRoot, relativePath), 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);

      if (match?.[1] !== undefined && match[2] !== undefined) {
        parsed[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  } catch {
    // A missing env file is the normal case, not an error: every one of them is gitignored.
  }

  envFileCache.set(relativePath, parsed);

  return parsed;
}

function configuredValue(key, files) {
  const fromEnvironment = process.env[key];

  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return fromEnvironment;
  }

  for (const file of files) {
    const value = readEnvFile(file)[key];

    if (value !== undefined && value !== '') {
      return value;
    }
  }

  return undefined;
}

/** The port the developer asked for. Where the search starts, not where it must end. */
function preferredPort(key, files, fallback) {
  const raw = configuredValue(key, files);

  if (raw === undefined) {
    return fallback;
  }

  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${key}=${raw} is not a usable port; expected an integer from 1 to 65535.`);
  }

  return port;
}

/**
 * Bound without a host, so the check covers IPv4 and IPv6 alike. A port another process holds
 * on only one of the two is reported as taken — conservative in the harmless direction, since
 * the cost is skipping a port and the alternative is handing out one that fails to bind.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.listen(port, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

async function findFreePort(label, preferred, claimed) {
  const limit = Math.min(preferred + SEARCH_RANGE, 65_536);
  const candidates = [];

  for (let port = preferred; port < limit; port += 1) {
    if (!claimed.has(port)) {
      candidates.push(port);
    }
  }

  // Probed together rather than one at a time: the whole range is checked in a single tick, and
  // the lowest survivor is still the answer, so the preference is honoured either way.
  const free = await Promise.all(candidates.map(isPortFree));
  const index = free.indexOf(true);

  if (index !== -1) {
    return candidates[index];
  }

  throw new Error(
    `No free ${label} port between ${preferred} and ${limit - 1}. ` +
      'Something is holding the whole range — find it with ' +
      `\`lsof -nP -iTCP:${preferred}-${limit - 1} -sTCP:LISTEN\`.`,
  );
}

/**
 * The API URL the web app should use.
 *
 * Rewritten only when the configured value is a local URL that agreed with the preferred API
 * port before the search moved it. Anything else is left exactly as configured: a
 * `NEXT_PUBLIC_API_URL` pointing at another host, or at a local port that never matched
 * `PORT`, is someone deliberately aiming the web app somewhere — a proxy, a staging API — and
 * repointing it at a port this script just picked would break that on purpose.
 */
function resolveApiUrl(apiPort, preferredApiPort) {
  const configured = configuredValue('NEXT_PUBLIC_API_URL', WEB_ENV_FILES);

  if (configured === undefined) {
    return `http://localhost:${apiPort}/api`;
  }

  let url;

  try {
    url = new URL(configured);
  } catch {
    // Not this script's error to report — the web app owns what a malformed base URL means.
    return configured;
  }

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

  if (!isLocal || port !== preferredApiPort) {
    // Warned about whenever the two disagree, not only when the search moved the port: a local
    // URL aimed at a port nothing is serving is the silent break this script exists to avoid,
    // and it is just as reachable by overriding PORT as by losing a port to another process.
    if (isLocal && port !== apiPort) {
      console.warn(
        `! NEXT_PUBLIC_API_URL is ${configured}, but the API is on ${String(apiPort)}. Left as ` +
          'configured — a local URL on its own port is read as deliberate, a proxy or a second ' +
          `API. Point it at ${String(preferredApiPort)} (PORT) or unset it to have it managed.`,
      );
    } else if (!isLocal && apiPort !== preferredApiPort) {
      console.warn(
        `! NEXT_PUBLIC_API_URL is ${configured}, so the web app will not reach the API this ` +
          `script just started on ${String(apiPort)}.`,
      );
    }

    return configured;
  }

  url.port = String(apiPort);

  return url.toString().replace(/\/+$/, '');
}

// "in use" rather than "taken by something else": the preferred port may well have gone to the
// other app in this very run, which happens whenever both prefer the same number.
function report(label, port, preferred) {
  const moved = port === preferred ? '' : ` (${String(preferred)} already in use)`;

  console.warn(`  ${label.padEnd(4)} ${String(port)}${moved}`);
}

const preferredApiPort = preferredPort('PORT', API_ENV_FILES, DEFAULT_API_PORT);
const preferredWebPort = preferredPort('WEB_PORT', WEB_ENV_FILES, DEFAULT_WEB_PORT);

const claimed = new Set();

const apiPort = await findFreePort('API', preferredApiPort, claimed);
claimed.add(apiPort);
const webPort = await findFreePort('web', preferredWebPort, claimed);

const apiUrl = resolveApiUrl(apiPort, preferredApiPort);

// stderr, via console.warn: stdout belongs to the dev servers about to inherit it.
console.warn('Resolved dev ports:');
report('web', webPort, preferredWebPort);
report('api', apiPort, preferredApiPort);
console.warn(`  NEXT_PUBLIC_API_URL ${apiUrl}\n`);

const turbo = spawn('pnpm', ['exec', 'turbo', 'run', 'dev'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(apiPort),
    WEB_PORT: String(webPort),
    NEXT_PUBLIC_API_URL: apiUrl,
  },
});

// Ctrl-C reaches Turborepo directly through the process group; this covers a signal sent to
// this process alone, so the dev servers are not orphaned.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    turbo.kill(signal);
  });
}

turbo.on('error', (error) => {
  console.error(`Could not start Turborepo: ${error.message}`);
  process.exit(1);
});

turbo.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 0) : 1);
});
