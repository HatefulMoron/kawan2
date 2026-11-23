import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { startHost } from "./server.js";

const execFileAsync = promisify(execFile);

interface CliOptions {
  dir: string;
  fresh: boolean;
  repo?: string;
  verify: string;
  port: number;
  bot: string;
  user: string;
  creds: string;
  readyFile?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dir: "/tmp/kawan-dev",
    fresh: false,
    verify: "true",
    port: 0,
    bot: "kawan",
    user: process.env.USER ?? "thomas",
    creds: resolve("../dev.md"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fresh") {
      opts.fresh = true;
    } else if (arg === "--dir" && argv[i + 1]) {
      opts.dir = resolve(argv[++i]);
    } else if (arg === "--repo" && argv[i + 1]) {
      opts.repo = resolve(argv[++i]);
    } else if (arg === "--verify" && argv[i + 1]) {
      opts.verify = argv[++i];
    } else if (arg === "--port" && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (arg === "--bot" && argv[i + 1]) {
      opts.bot = argv[++i];
    } else if (arg === "--user" && argv[i + 1]) {
      opts.user = argv[++i];
    } else if (arg === "--creds" && argv[i + 1]) {
      opts.creds = resolve(argv[++i]);
    } else if (arg === "--ready-file" && argv[i + 1]) {
      opts.readyFile = resolve(argv[++i]);
    }
  }
  return opts;
}

function parseCredsFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const key = raw.slice(0, idx).trim().toLowerCase();
    const val = raw.slice(idx + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

async function ensureRepo(dir: string, userName: string, explicitRepo?: string): Promise<string> {
  if (explicitRepo) {
    if (!existsSync(explicitRepo)) {
      throw new Error(`Repository path does not exist: ${explicitRepo}`);
    }
    return explicitRepo;
  }

  const repoDir = join(dir, "repo");
  if (existsSync(join(repoDir, ".git"))) {
    return repoDir;
  }

  mkdirSync(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir], { timeout: 10_000 });
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", userName], { timeout: 10_000 });
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", `${userName}@kawan.local`], {
    timeout: 10_000,
  });
  writeFileSync(join(repoDir, "README.md"), "# Workspace\n", "utf8");
  await execFileAsync("git", ["-C", repoDir, "add", "README.md"], { timeout: 10_000 });
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "Initial commit"], { timeout: 10_000 });
  return repoDir;
}

async function ensureSshKey(keyPath: string, userName: string): Promise<string> {
  mkdirSync(dirname(keyPath), { recursive: true });
  if (!existsSync(keyPath)) {
    await execFileAsync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", `${userName}@kawan`, "-f", keyPath, "-q"],
      { timeout: 10_000 },
    );
  }
  const pubPath = `${keyPath}.pub`;
  if (existsSync(pubPath)) {
    return readFileSync(pubPath, "utf8").trim();
  }
  const { stdout } = await execFileAsync("ssh-keygen", ["-y", "-f", keyPath], { timeout: 10_000 });
  return stdout.trim();
}

async function signNonce(keyPath: string, nonce: string, namespace: string): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "kawan-dev-sign-"));
  const noncePath = join(tmpDir, "nonce.txt");
  try {
    writeFileSync(noncePath, nonce, "utf8");
    await execFileAsync(
      "ssh-keygen",
      ["-Y", "sign", "-f", keyPath, "-n", namespace, noncePath],
      { timeout: 10_000 },
    );
    return readFileSync(`${noncePath}.sig`, "utf8");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function bootstrapWorkspace(params: {
  url: string;
  bootstrapToken: string;
  userName: string;
  keyPath: string;
  pubkey: string;
  repoPath: string;
  verifyCommand: string;
  botName: string;
  lithosBaseUrl: string;
  lithosModel: string;
  lithosThinking: string;
  lithosApiKey: string;
  subqBaseUrl: string;
  subqModel: string;
  subqApiKey: string;
}): Promise<void> {
  const ws = new WebSocket(params.url);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    ws.once("open", () => resolvePromise());
    ws.once("error", rejectPromise);
  });

  let reqSeq = 0;
  const frames: Array<any> = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void; reject: (e: Error) => void }> = [];

  ws.on("message", (raw) => {
    for (const line of raw.toString("utf8").split(/\r?\n/).filter((l) => l.trim().length > 0)) {
      const f = JSON.parse(line);
      frames.push(f);
      for (let i = 0; i < waiters.length; i += 1) {
        if (waiters[i].pred(f)) {
          const [w] = waiters.splice(i, 1);
          w.resolve(f);
          break;
        }
      }
    }
  });

  ws.on("close", (code, reason) => {
    for (const w of waiters.splice(0)) {
      w.reject(new Error(`Setup WS closed unexpectedly (${code}: ${reason.toString("utf8")})`));
    }
  });

  const waitNext = (pred: (f: any) => boolean, timeoutMs = 20_000) =>
    new Promise<any>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx >= 0) waiters.splice(idx, 1);
        rejectPromise(new Error(`Timed out waiting for WS frame after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrappedResolve = (f: any) => {
        clearTimeout(timer);
        resolvePromise(f);
      };
      waiters.push({ pred, resolve: wrappedResolve, reject: rejectPromise });
    });

  const send = (obj: Record<string, unknown>) => ws.send(`${JSON.stringify(obj)}\n`);

  const request = async <T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const id = `dev-setup-${++reqSeq}`;
    const p = waitNext((f) => f.type === "response" && f.id === id);
    send({ id, type, ...payload });
    const resp = await p;
    if (!resp.success) {
      throw new Error(`${type} failed: ${resp.error}`);
    }
    return resp.data as T;
  };

  try {
    const challengeWait = waitNext((f) => f.type === "challenge" || f.type === "error");
    send({
      type: "bootstrap",
      token: params.bootstrapToken,
      pubkey: params.pubkey,
      name: params.userName,
      version: 1,
    });
    const challenge = await challengeWait;
    if (challenge.type === "error") throw new Error(challenge.message);

    const sig = await signNonce(params.keyPath, challenge.nonce, challenge.namespace);
    const welcomeWait = waitNext((f) => f.type === "welcome" || f.type === "error");
    send({ type: "proof", signature: sig });
    const welcome = await welcomeWait;
    if (welcome.type === "error") throw new Error(welcome.message);

    const isDeepSeek = params.lithosModel.toLowerCase().includes("deepseek");
    const modelDef = isDeepSeek
      ? {
          id: params.lithosModel,
          name: params.lithosModel,
          reasoning: true,
          contextWindow: 1048576,
          maxTokens: 393216,
          thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", xhigh: null, max: "max" },
          compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true, maxTokensField: "max_tokens" },
        }
      : {
          id: params.lithosModel,
          name: params.lithosModel,
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 16384,
        };

    await request("settings.update", {
      repo: { url: params.repoPath, default_branch: "main" },
      verify_command: params.verifyCommand,
      providers: {
        lithosai: {
          baseUrl: params.lithosBaseUrl,
          api: "openai-completions",
          apiKey: params.lithosApiKey,
          models: [modelDef],
        },
      },
      roles: {
        default: {
          provider: "lithosai",
          model: params.lithosModel,
          thinking_level: params.lithosThinking,
        },
        decision: {
          provider: "subq",
          baseUrl: params.subqBaseUrl,
          model: params.subqModel,
          apiKey: params.subqApiKey,
        },
      },
    });

    const createdBot = await request<{ bot: { id: string } }>("bot.create", {
      name: params.botName,
      persona: "Concise, practical software engineer.",
      sandbox_enabled: true,
      sandbox_network: true,
    });

    const convs = await request<{ conversations: Array<{ id: string; name: string | null }> }>(
      "conversation.list",
    );
    const general = convs.conversations.find((c) => c.name === "general");
    if (general) {
      await request("conversation.add_member", {
        conversation_id: general.id,
        user_id: createdBot.bot.id,
      });
    }
  } finally {
    ws.close();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.fresh) {
    rmSync(opts.dir, { recursive: true, force: true });
  }
  mkdirSync(opts.dir, { recursive: true });

  const fileCreds = parseCredsFile(opts.creds);
  const subqApiKey = process.env.SUBQ_API_KEY ?? fileCreds["decision model key"] ?? "";
  const lithosApiKey = process.env.LITHOSAI_API_KEY ?? fileCreds["llm api key"] ?? "";
  if (!subqApiKey || !lithosApiKey) {
    throw new Error(
      `Missing API credentials. Provide SUBQ_API_KEY + LITHOSAI_API_KEY env vars or populate ${opts.creds}.`,
    );
  }

  const subqBaseUrl = process.env.SUBQ_BASE_URL ?? "https://api.subq.ai/v1";
  const subqModel = process.env.SUBQ_MODEL ?? "subq-snap-1.2";
  const lithosBaseUrl = process.env.LITHOSAI_BASE_URL ?? "https://api.lithosai.cloud/v1";
  const lithosModel =
    process.env.LITHOSAI_MODEL ?? fileCreds["llm model name"] ?? "deepseek-ai/DeepSeek-V4.1-Flash";
  const lithosThinking =
    process.env.LITHOSAI_THINKING ?? fileCreds["llm thinking level"] ?? "medium";

  const repoPath = await ensureRepo(opts.dir, opts.user, opts.repo);
  const keyPath = join(opts.dir, "id_ed25519");
  const pubkey = await ensureSshKey(keyPath, opts.user);
  const dataDir = join(opts.dir, "data");

  const running = await startHost({
    dataDir,
    host: "127.0.0.1",
    port: opts.port,
    quiet: true,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await running.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (running.bootstrapToken) {
    await bootstrapWorkspace({
      url: running.url,
      bootstrapToken: running.bootstrapToken,
      userName: opts.user,
      keyPath,
      pubkey,
      repoPath,
      verifyCommand: opts.verify,
      botName: opts.bot,
      lithosBaseUrl,
      lithosModel,
      lithosThinking,
      lithosApiKey,
      subqBaseUrl,
      subqModel,
      subqApiKey,
    });
  }

  if (opts.readyFile) {
    mkdirSync(dirname(opts.readyFile), { recursive: true });
    const tmpReady = `${opts.readyFile}.tmp-${process.pid}`;
    writeFileSync(
      tmpReady,
      `${JSON.stringify({
        url: running.url,
        key_path: keyPath,
        data_dir: dataDir,
        repo_dir: repoPath,
        bot_name: opts.bot,
        user_name: opts.user,
      })}\n`,
      "utf8",
    );
    renameSync(tmpReady, opts.readyFile);
  }

  console.log(`kawan dev-host ready on ${running.url}`);
  console.log(`  workspace : ${opts.dir}`);
  console.log(`  repo      : ${repoPath}`);
  console.log(`  data dir  : ${dataDir}`);
  console.log(`  ssh key   : ${keyPath}`);
  console.log(`  bot       : @${opts.bot} (in #general)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
