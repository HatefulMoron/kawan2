import { resolve } from "node:path";
import { startHost } from "./server.js";

function parseArgs(argv: string[]): { dataDir: string; host: string; port: number } {
  let dataDir = process.env.KAWAN_DATA_DIR ?? "./data";
  let host = process.env.KAWAN_HOST ?? "127.0.0.1";
  let port = Number(process.env.KAWAN_PORT ?? "8787");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir" && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (arg === "--host" && argv[i + 1]) {
      host = argv[++i];
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
    }
  }
  return { dataDir: resolve(dataDir), host, port };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const running = await startHost(args);

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
