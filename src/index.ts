#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// config must be imported before anything that reads settings (it loads .env files).
import { config } from './config.js';
import { logger } from './logger.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  await server.connect(transport);
  logger.info(
    `${config.serverName} ${config.version} running on stdio. Storage: ${config.storageDir}. ` +
      `.env loaded from: ${config.envFilesLoaded.length ? config.envFilesLoaded.join(', ') : '(none)'}`,
  );
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
