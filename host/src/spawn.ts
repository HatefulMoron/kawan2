import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildPiModelsJson } from "./server.js";
import type { HostSettings, SessionKind, UserRow } from "./types.js";

export interface ComposeSpawnParams {
  role: SessionKind;
  bot: UserRow;
  settings: HostSettings;
  agentDir: string;
  sessionDir: string;
  cwd: string;
  socketPath: string;
  extensionPath: string;
  sessionToken: string;
  systemPrompt: string;
  piSessionFile?: string | null;
  disableSandbox?: boolean;
}

export interface ComposedSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function resolvePiBinary(): string {
  if (process.env.KAWAN_PI_BIN) return process.env.KAWAN_PI_BIN;
  try {
    return execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not locate `pi` binary on PATH");
  }
}

export function parseProviderModel(botModel: string | null, settings: HostSettings): {
  provider: string;
  modelId: string;
} {
  if (botModel && botModel.includes("/")) {
    const idx = botModel.indexOf("/");
    const provider = botModel.slice(0, idx);
    const modelId = botModel.slice(idx + 1);
    if (settings.providers[provider]) {
      return { provider, modelId };
    }
  }
  const def = settings.roles.default;
  if (!def) {
    throw new Error("No default model role configured");
  }
  return { provider: def.provider, modelId: def.model };
}

export function materializeSessionAgentDir(agentDir: string, settings: HostSettings): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    `${JSON.stringify(buildPiModelsJson(settings), null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ quietStartup: true }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function composeSpawnSpec(params: ComposeSpawnParams): ComposedSpawnSpec {
  const piBin = resolvePiBinary();
  const { provider, modelId } = parseProviderModel(params.bot.model, params.settings);
  const thinking = params.bot.thinking_level || params.settings.roles.default?.thinking_level || "medium";

  mkdirSync(params.sessionDir, { recursive: true });

  const piArgs = [
    "--mode",
    "rpc",
    "--provider",
    provider,
    "--model",
    modelId,
    "--thinking",
    thinking,
    "--session-dir",
    params.sessionDir,
    ...(params.piSessionFile && existsSync(params.piSessionFile)
      ? ["--session", params.piSessionFile]
      : []),
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--no-context-files",
    "-e",
    params.extensionPath,
    "--system-prompt",
    params.systemPrompt,
  ];

  if (params.role === "orchestrator") {
    piArgs.push("--no-builtin-tools");
  }

  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TERM: "dumb",
    PI_CODING_AGENT_DIR: params.agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    KAWAN_SOCKET: params.socketPath,
    KAWAN_SESSION_TOKEN: params.sessionToken,
    KAWAN_SESSION_ROLE: params.role,
  };

  const useSandbox = Boolean(params.bot.sandbox_enabled) && !params.disableSandbox;
  if (!useSandbox) {
    childEnv.HOME = params.sessionDir;
    return {
      command: piBin,
      args: piArgs,
      cwd: params.cwd,
      env: childEnv,
    };
  }

  const sandboxHome = "/home/kawan";
  childEnv.HOME = sandboxHome;

  const bwrapArgs: string[] = ["--die-with-parent"];
  for (const sysDir of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
    if (existsSync(sysDir)) {
      bwrapArgs.push("--ro-bind", sysDir, sysDir);
    }
  }
  bwrapArgs.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", sandboxHome);

  // Mount pi's own installation directories read-only without exposing host ~/.pi/agent/auth.json
  const resolvedPi = realpathSync(piBin);
  const piBinDir = dirname(resolvedPi);
  if (existsSync(piBinDir)) {
    bwrapArgs.push("--ro-bind", piBinDir, piBinDir);
  }
  const piRoot = dirname(piBinDir);
  const piInstallDir = join(piRoot, "install");
  if (existsSync(piInstallDir)) {
    bwrapArgs.push("--ro-bind", piInstallDir, piInstallDir);
  }
  if (dirname(piBin) !== piBinDir && existsSync(dirname(piBin))) {
    bwrapArgs.push("--ro-bind", dirname(piBin), dirname(piBin));
  }

  const extDir = dirname(params.extensionPath);
  bwrapArgs.push("--ro-bind", extDir, extDir);
  bwrapArgs.push("--ro-bind", params.agentDir, params.agentDir);
  bwrapArgs.push("--bind", params.sessionDir, params.sessionDir);
  bwrapArgs.push("--bind", params.cwd, params.cwd);

  const socketDir = dirname(params.socketPath);
  bwrapArgs.push("--bind", socketDir, socketDir);

  if (params.bot.signing_key_path && existsSync(params.bot.signing_key_path)) {
    bwrapArgs.push("--ro-bind", params.bot.signing_key_path, params.bot.signing_key_path);
    const pub = `${params.bot.signing_key_path}.pub`;
    if (existsSync(pub)) {
      bwrapArgs.push("--ro-bind", pub, pub);
    }
  }

  if (params.bot.sandbox_network) {
    try {
      const resolvedResolv = realpathSync("/etc/resolv.conf");
      if (!resolvedResolv.startsWith("/etc/") && existsSync(resolvedResolv)) {
        const resolvDir = dirname(resolvedResolv);
        if (resolvDir.startsWith("/run/")) {
          bwrapArgs.push("--ro-bind", resolvDir, resolvDir);
        } else {
          bwrapArgs.push("--ro-bind", resolvedResolv, resolvedResolv);
        }
      }
    } catch {
      // /etc/resolv.conf absent or unreadable
    }
  } else {
    bwrapArgs.push("--unshare-net");
  }

  bwrapArgs.push("--chdir", params.cwd);
  bwrapArgs.push("--", piBin, ...piArgs);

  return {
    command: "bwrap",
    args: bwrapArgs,
    cwd: params.cwd,
    env: childEnv,
  };
}
