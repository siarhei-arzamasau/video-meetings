#!/usr/bin/env node

/**
 * `pnpm start:dev` — everything a clean checkout needs before `pnpm dev` can work, then
 * `pnpm dev` itself.
 *
 * `pnpm dev` starts both apps and is the command to use day to day. What it deliberately does
 * not do is set up the machine: the database has to be running, the Prisma client is
 * gitignored and must be generated, and the API's tables do not exist until the migrations
 * have been applied. Miss any of the three and the failure arrives later and further away —
 * a web app that loads and a sign-up that answers "We could not reach the server", because
 * the API exited during boot behind two pages of Turborepo output.
 *
 * So this script checks those three, fixes what it can, and only then hands over. Every step
 * is idempotent: on a machine that is already set up it costs a few seconds and changes
 * nothing. `--skip-db` leaves Docker alone, for a Postgres that is not this compose file's.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skipDatabase = process.argv.includes('--skip-db');

/** How long to wait for Postgres to accept connections after `docker compose up`. */
const DATABASE_TIMEOUT_MS = 60_000;

function run(command, args, { optional = false } = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });

  if (result.status !== 0 && !optional) {
    fail(`\`${command} ${args.join(' ')}\` failed.`);
  }

  return result.status === 0;
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function step(message) {
  // stderr throughout: stdout belongs to the dev servers this script ends by starting.
  console.warn(`→ ${message}`);
}

/**
 * The port `DATABASE_URL` points at, which is the only part of it this script needs. Read from
 * the API's env file, since that is the value the API will actually connect with — a root
 * `.env` that disagrees is the API's problem to report, not this script's to second-guess.
 */
function databasePort() {
  for (const file of ['apps/api/.env.local', 'apps/api/.env', '.env']) {
    const path = join(repoRoot, file);

    if (!existsSync(path)) {
      continue;
    }

    const match = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+?)\s*$/m.exec(
      readFileSync(path, 'utf8'),
    );

    if (match?.[1] === undefined) {
      continue;
    }

    try {
      const { port } = new URL(match[1].replace(/^(['"])(.*)\1$/, '$2'));

      return port === '' ? 5432 : Number(port);
    } catch {
      // A malformed URL is the API's error to report at boot, with its own message.
      return undefined;
    }
  }

  return undefined;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (answer) => {
      socket.destroy();
      resolve(answer);
    };

    socket.setTimeout(1_000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** Polled, not looped: the same shape the API worker's `drainFrom` uses, and the lint rule
 * that forbids `await` in a loop is right — nothing here can be run in parallel. */
async function waitForDatabase(port, deadline = Date.now() + DATABASE_TIMEOUT_MS) {
  if (await canConnect(port)) {
    return true;
  }

  if (Date.now() >= deadline) {
    return false;
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  return waitForDatabase(port, deadline);
}

async function ensureDatabase() {
  const port = databasePort();

  if (port === undefined) {
    step('No DATABASE_URL found yet — copy apps/api/.env.example to apps/api/.env first.');
    fail('The API cannot start without DATABASE_URL.');
  }

  if (await canConnect(port)) {
    step(`Postgres is already accepting connections on ${String(port)}.`);

    return;
  }

  if (skipDatabase) {
    fail(`Nothing is listening on ${String(port)}, and --skip-db says not to start it.`);
  }

  step(`Nothing on ${String(port)} yet — starting the compose service.`);

  if (!run('docker', ['compose', 'up', '-d', 'postgres'], { optional: true })) {
    fail(
      'Could not start Postgres with Docker. Start it yourself and re-run with --skip-db, or ' +
        'check that Docker is running.',
    );
  }

  if (!(await waitForDatabase(port))) {
    fail(`Postgres did not accept a connection on ${String(port)} within a minute.`);
  }

  step('Postgres is up.');
}

function ensurePrismaClient() {
  // Gitignored, so a fresh clone has no client at all and the API fails to import its models.
  if (existsSync(join(repoRoot, 'apps/api/src/generated/prisma/client.ts'))) {
    return;
  }

  step('Generating the Prisma client, which is gitignored and not built by `dev`.');
  run('pnpm', ['--filter=@repo/api', 'prisma:generate']);
}

/**
 * `migrate deploy`, not `migrate dev`: it applies what is committed and never prompts, never
 * generates a migration, and never offers to reset the database. A schema change belongs to
 * whoever is making it, through `prisma:migrate` — not to a script someone runs to see the app.
 */
function applyMigrations() {
  step('Applying database migrations.');
  run('pnpm', ['--filter=@repo/api', 'exec', 'prisma', 'migrate', 'deploy']);
}

await ensureDatabase();
ensurePrismaClient();
applyMigrations();

step('Starting both apps.\n');

const dev = spawn('node', [join(repoRoot, 'scripts/dev.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    dev.kill(signal);
  });
}

dev.on('error', (error) => {
  fail(`Could not start the dev servers: ${error.message}`);
});

dev.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 0) : 1);
});
