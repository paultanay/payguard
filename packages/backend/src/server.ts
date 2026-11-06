import dotenv from 'dotenv';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/connection.js';
import { registerRoutes } from './api/routes.js';
import { PayPalAdapter } from './provider/paypal.js';
import { PaymentSimulator } from './provider/simulator.js';
import type { PaymentProvider } from './provider/interface.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startDir: string): string {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'packages', 'backend', 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate PayGuard project root');
  }
}

const projectRoot = findProjectRoot(__dirname);
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

async function buildServer() {
  const app = Fastify({
    logger: {
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  await app.register(cors, {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true,
  });

  // Serve frontend static files in production
  const frontendDist = path.join(projectRoot, 'packages', 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    await app.register(staticFiles, {
      root: frontendDist,
      prefix: '/',
    });
  }

  // Select provider
  const useSimulator =
    !process.env.PAYPAL_CLIENT_ID ||
    !process.env.PAYPAL_CLIENT_SECRET ||
    process.env.USE_SIMULATOR === 'true';

  let provider: PaymentProvider;
  if (useSimulator) {
    provider = new PaymentSimulator();
    app.log.info('[PayGuard] Using SIMULATED payment provider. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for PayPal Sandbox.');
  } else {
    provider = new PayPalAdapter(
      process.env.PAYPAL_CLIENT_ID!,
      process.env.PAYPAL_CLIENT_SECRET!,
      process.env.PAYPAL_BASE_URL ?? 'https://api-m.sandbox.paypal.com',
    );
    app.log.info('[PayGuard] Using PayPal Sandbox provider.');
  }

  // Initialize database
  const dataDir = path.join(projectRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.DB_PATH
    ? path.resolve(projectRoot, process.env.DB_PATH)
    : path.join(dataDir, 'payguard.db');
  const db = getDb(dbPath);

  // Register all routes
  registerRoutes(app, db, provider);

  return app;
}

async function start() {
  const app = await buildServer();
  const port = parseInt(process.env.PORT ?? '3001');
  const host = process.env.HOST ?? '127.0.0.1';

  try {
    await app.listen({ port, host });
    console.log(`\n🛡️  PayGuard API running on http://localhost:${port}`);
    console.log(`   Provider mode: ${(await app.inject('/health').then(r => r.json())).provider_mode}`);
    console.log(`   Health: http://localhost:${port}/health\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

export { buildServer };
start();
