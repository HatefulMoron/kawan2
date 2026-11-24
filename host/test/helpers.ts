import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);

export async function createFixtureBareRepo(
  files: Record<string, string> = { "README.md": "# Fixture Repo\n" },
  opts: { verifyScript?: string; defaultBranch?: string } = {},
): Promise<{
  dir: string;
  barePath: string;
  defaultBranch: string;
  initialHead: string;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "kawan-repo-"));
  const workDir = join(dir, "work");
  const barePath = join(dir, "origin.git");
  const defaultBranch = opts.defaultBranch ?? "main";

  await execFileAsync("git", ["init", "-b", defaultBranch, workDir], { timeout: 10_000 });
  await execFileAsync("git", ["config", "user.name", "Fixture Author"], { cwd: workDir, timeout: 10_000 });
  await execFileAsync("git", ["config", "user.email", "fixture@kawan.local"], { cwd: workDir, timeout: 10_000 });

  for (const [rel, content] of Object.entries(files)) {
    const full = join(workDir, rel);
    const parent = join(full, "..");
    await import("node:fs/promises").then((fs) => fs.mkdir(parent, { recursive: true }));
    writeFileSync(full, content, "utf8");
  }
  if (opts.verifyScript) {
    const scriptPath = join(workDir, "verify.sh");
    writeFileSync(scriptPath, opts.verifyScript, { mode: 0o755 });
  }

  await execFileAsync("git", ["add", "-A"], { cwd: workDir, timeout: 10_000 });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: workDir, timeout: 10_000 });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workDir, timeout: 10_000 });
  const initialHead = stdout.trim();

  await execFileAsync("git", ["clone", "--bare", workDir, barePath], { timeout: 10_000 });

  return {
    dir,
    barePath,
    defaultBranch,
    initialHead,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export class TestKeyPair {
  readonly dir: string;
  readonly privatePath: string;
  readonly pubkey: string;
  readonly fingerprint: string;
  private signCounter = 0;

  private constructor(dir: string, privatePath: string, pubkey: string, fingerprint: string) {
    this.dir = dir;
    this.privatePath = privatePath;
    this.pubkey = pubkey;
    this.fingerprint = fingerprint;
  }

  static async generate(comment = "test@kawan"): Promise<TestKeyPair> {
    const dir = mkdtempSync(join(tmpdir(), "kawan-testkey-"));
    const privatePath = join(dir, "id_ed25519");
    await execFileAsync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", comment, "-f", privatePath, "-q"],
      { timeout: 10_000 },
    );
    const pubkey = readFileSync(`${privatePath}.pub`, "utf8").trim();
    const { stdout } = await execFileAsync("ssh-keygen", ["-lf", `${privatePath}.pub`], {
      timeout: 10_000,
    });
    const match = stdout.match(/(SHA256:[A-Za-z0-9+/=]+)/);
    if (!match) throw new Error(`Failed to extract fingerprint from ${stdout}`);
    return new TestKeyPair(dir, privatePath, pubkey, match[1]);
  }

  async signNonce(nonce: string, namespace: string): Promise<string> {
    const noncePath = join(this.dir, `nonce-${++this.signCounter}.txt`);
    writeFileSync(noncePath, nonce, "utf8");
    await execFileAsync(
      "ssh-keygen",
      ["-Y", "sign", "-f", this.privatePath, "-n", namespace, noncePath],
      { timeout: 10_000 },
    );
    return readFileSync(`${noncePath}.sig`, "utf8");
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Call a host tool exactly like the pi extension does: one JSON line over the
 * session unix socket. Lets tests exercise agent-facing tools without an LLM.
 */
export function callHostTool(
  socketPath: string,
  token: string,
  tool: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(err);
    };
    conn.on("error", fail);
    conn.on("connect", () => {
      conn.write(`${JSON.stringify({ id: "test-1", token, tool, params })}\n`);
    });
    conn.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      settled = true;
      conn.end();
      try {
        const msg = JSON.parse(buf.subarray(0, nl).toString("utf8")) as {
          ok: boolean;
          result?: unknown;
          error?: string;
        };
        if (!msg.ok) reject(new Error(msg.error ?? "host tool error"));
        else resolve(msg.result);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    conn.on("end", () => {
      if (!settled) fail(new Error("host closed socket before replying"));
    });
  });
}

export interface WsFrame {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  data?: any;
  error?: string;
  [key: string]: any;
}

export class WsTestClient {
  readonly ws: WebSocket;
  readonly frames: WsFrame[] = [];
  private reqCounter = 0;
  private waiters: Array<{ predicate: (f: WsFrame) => boolean; resolve: (f: WsFrame) => void; reject: (e: Error) => void }> = [];
  private closed = false;
  private closePromise: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closePromise = new Promise((resolve) => {
      ws.on("close", (code, reason) => {
        this.closed = true;
        const err = new Error(`WebSocket closed (${code}: ${reason.toString("utf8")})`);
        for (const w of this.waiters.splice(0)) {
          w.reject(err);
        }
        resolve({ code, reason: reason.toString("utf8") });
      });
    });

    ws.on("message", (raw) => {
      const lines = raw.toString("utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const frame = JSON.parse(line) as WsFrame;
        this.frames.push(frame);
        for (let i = 0; i < this.waiters.length; i += 1) {
          const w = this.waiters[i];
          if (w.predicate(frame)) {
            this.waiters.splice(i, 1);
            w.resolve(frame);
            break;
          }
        }
      }
    });
  }

  static async connect(url: string): Promise<WsTestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new WsTestClient(ws);
  }

  sendRaw(obj: Record<string, unknown>): void {
    this.ws.send(`${JSON.stringify(obj)}\n`);
  }

  waitForFrame(predicate: (f: WsFrame) => boolean, timeoutMs = 15_000): Promise<WsFrame> {
    const existing = this.frames.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    if (this.closed) {
      return Promise.reject(new Error("WebSocket already closed"));
    }
    return new Promise<WsFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for WS frame after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrappedResolve = (f: WsFrame) => {
        clearTimeout(timer);
        resolve(f);
      };
      const wrappedReject = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      this.waiters.push({ predicate, resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  waitForNextFrame(predicate: (f: WsFrame) => boolean, timeoutMs = 15_000): Promise<WsFrame> {
    if (this.closed) {
      return Promise.reject(new Error("WebSocket already closed"));
    }
    return new Promise<WsFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for next WS frame after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrappedResolve = (f: WsFrame) => {
        clearTimeout(timer);
        resolve(f);
      };
      const wrappedReject = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      this.waiters.push({ predicate, resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  waitForClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    return Promise.race([
      this.closePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for close")), timeoutMs),
      ),
    ]);
  }

  async bootstrap(token: string, name: string, key: TestKeyPair): Promise<WsFrame> {
    this.sendRaw({ type: "bootstrap", token, pubkey: key.pubkey, name, version: 1 });
    const challenge = await this.waitForNextFrame((f) => f.type === "challenge" || f.type === "error");
    if (challenge.type === "error") throw new Error(challenge.message);
    const sig = await key.signNonce(challenge.nonce, challenge.namespace);
    this.sendRaw({ type: "proof", signature: sig });
    const welcome = await this.waitForNextFrame((f) => f.type === "welcome" || f.type === "error");
    if (welcome.type === "error") throw new Error(welcome.message);
    return welcome;
  }

  async register(token: string, name: string, key: TestKeyPair): Promise<WsFrame> {
    this.sendRaw({ type: "register", token, pubkey: key.pubkey, name, version: 1 });
    const challenge = await this.waitForNextFrame((f) => f.type === "challenge" || f.type === "error");
    if (challenge.type === "error") throw new Error(challenge.message);
    const sig = await key.signNonce(challenge.nonce, challenge.namespace);
    this.sendRaw({ type: "proof", signature: sig });
    const welcome = await this.waitForNextFrame((f) => f.type === "welcome" || f.type === "error");
    if (welcome.type === "error") throw new Error(welcome.message);
    return welcome;
  }

  async hello(key: TestKeyPair): Promise<WsFrame> {
    this.sendRaw({ type: "hello", key: key.fingerprint, version: 1 });
    const challenge = await this.waitForNextFrame((f) => f.type === "challenge" || f.type === "error");
    if (challenge.type === "error") throw new Error(challenge.message);
    const sig = await key.signNonce(challenge.nonce, challenge.namespace);
    this.sendRaw({ type: "proof", signature: sig });
    const welcome = await this.waitForNextFrame((f) => f.type === "welcome" || f.type === "error");
    if (welcome.type === "error") throw new Error(welcome.message);
    return welcome;
  }

  async request<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const id = `req-${++this.reqCounter}`;
    const waitPromise = this.waitForNextFrame(
      (f) => f.type === "response" && f.id === id,
      timeoutMs,
    );
    this.sendRaw({ id, type, ...payload });
    const resp = await waitPromise;
    if (!resp.success) {
      throw new Error(`${type} failed: ${resp.error}`);
    }
    return resp.data as T;
  }

  close(): void {
    this.ws.close();
  }
}
