import { mkdirSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { ensureBootstrapToken } from "./auth.js";
import { KawanDb } from "./db.js";
import { KawanWsServer } from "./ws.js";

export interface StartHostOptions {
  dataDir: string;
  host?: string;
  port?: number;
  hostNamespace?: string;
  recordProtocolPath?: string;
  quiet?: boolean;
}

export interface KawanHost {
  dataDir: string;
  host: string;
  port: number;
  url: string;
  bootstrapToken: string | null;
  db: KawanDb;
  wsServer: KawanWsServer;
  httpServer: HttpServer;
  close(): Promise<void>;
}

export async function startHost(opts: StartHostOptions): Promise<KawanHost> {
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;

  mkdirSync(opts.dataDir, { recursive: true });
  mkdirSync(join(opts.dataDir, "workspaces"), { recursive: true });
  mkdirSync(join(opts.dataDir, "artifacts"), { recursive: true });
  mkdirSync(join(opts.dataDir, "keys"), { recursive: true });
  mkdirSync(join(opts.dataDir, "sessions"), { recursive: true });

  const db = new KawanDb(join(opts.dataDir, "kawan.db"));
  const bootstrapToken = ensureBootstrapToken(db);

  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("WebSocket required\n");
  });
  const wss = new WebSocketServer({ server: httpServer });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, host, () => resolve());
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Unexpected server address");
  }
  const actualPort = addr.port;
  const hostAddress = `${host}:${actualPort}`;
  const url = `ws://${hostAddress}`;

  const wsServer = new KawanWsServer(wss, {
    db,
    hostNamespace: opts.hostNamespace ?? hostAddress,
    hostAddress,
    recordProtocolPath: opts.recordProtocolPath,
  });

  if (!opts.quiet) {
    if (bootstrapToken) {
      console.log(`kawan ready — connect to ${url} — bootstrap token ${bootstrapToken}`);
    } else {
      console.log(`kawan ready — connect to ${url}`);
    }
  }

  return {
    dataDir: opts.dataDir,
    host,
    port: actualPort,
    url,
    bootstrapToken,
    db,
    wsServer,
    httpServer,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
      db.close();
    },
  };
}
