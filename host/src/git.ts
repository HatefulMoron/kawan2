import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const res = await execFileAsync("git", args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...opts.env,
      },
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: res.stdout, stderr: res.stderr };
  } catch (err: any) {
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
    const stdout = typeof err?.stdout === "string" ? err.stdout.trim() : "";
    const detail = stderr || stdout || (err instanceof Error ? err.message : String(err));
    throw new Error(detail);
  }
}

export async function ensureHostSshKey(dataDir: string): Promise<{ privatePath: string; pubkey: string }> {
  const keysDir = join(dataDir, "keys");
  mkdirSync(keysDir, { recursive: true });
  const privatePath = join(keysDir, "host_id_ed25519");
  const pubPath = `${privatePath}.pub`;
  if (!existsSync(privatePath) || !existsSync(pubPath)) {
    rmSync(privatePath, { force: true });
    rmSync(pubPath, { force: true });
    await execFileAsync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", "kawan-host", "-f", privatePath, "-q"],
      { timeout: 10_000 },
    );
  }
  chmodSync(privatePath, 0o600);
  const pubkey = readFileSync(pubPath, "utf8").trim();
  return { privatePath, pubkey };
}

export async function generateBotKeypair(
  dataDir: string,
  botId: string,
  email: string,
): Promise<{ signingKeyPath: string; signingPubkey: string }> {
  const keysDir = join(dataDir, "keys");
  mkdirSync(keysDir, { recursive: true });
  const signingKeyPath = join(keysDir, `bot-${botId}`);
  const pubPath = `${signingKeyPath}.pub`;
  rmSync(signingKeyPath, { force: true });
  rmSync(pubPath, { force: true });
  await execFileAsync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", email, "-f", signingKeyPath, "-q"],
    { timeout: 10_000 },
  );
  chmodSync(signingKeyPath, 0o600);
  const signingPubkey = readFileSync(pubPath, "utf8").trim();
  return { signingKeyPath, signingPubkey };
}

export async function attachRepository(
  dataDir: string,
  params: { url: string; defaultBranch: string; httpsToken?: string },
): Promise<{ url: string; default_branch: string; bare_path: string }> {
  const url = params.url.trim();
  const defaultBranch = params.defaultBranch.trim();
  if (!url) throw new Error("repo.url is required");
  if (!defaultBranch) throw new Error("repo.default_branch is required");

  const hostKey = await ensureHostSshKey(dataDir);
  const barePath = join(dataDir, "repo.git");
  const stagingPath = join(dataDir, `repo.git.staging-${Date.now()}`);
  rmSync(stagingPath, { recursive: true, force: true });

  const gitEnv: Record<string, string> = {
    GIT_SSH_COMMAND: `ssh -i ${hostKey.privatePath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };

  let askpassDir: string | null = null;
  const cloneArgs = ["clone", "--bare"];
  try {
    if (params.httpsToken && url.startsWith("https://")) {
      askpassDir = mkdtempSync(join(tmpdir(), "kawan-askpass-"));
      const askpassPath = join(askpassDir, "askpass.sh");
      writeFileSync(
        askpassPath,
        `#!/bin/sh\ncase "$1" in\n*Username*) printf 'x-access-token\\n' ;;\n*) printf '%s\\n' "$KAWAN_HTTPS_TOKEN" ;;\nesac\n`,
        { mode: 0o700 },
      );
      gitEnv.GIT_ASKPASS = askpassPath;
      gitEnv.KAWAN_HTTPS_TOKEN = params.httpsToken;
    }

    cloneArgs.push(url, stagingPath);
    await runGit(cloneArgs, { env: gitEnv });

    await runGit(
      ["--git-dir", stagingPath, "rev-parse", "--verify", `refs/heads/${defaultBranch}`],
      { env: gitEnv },
    );

    rmSync(barePath, { recursive: true, force: true });
    renameSync(stagingPath, barePath);
    return { url, default_branch: defaultBranch, bare_path: barePath };
  } catch (err) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw err;
  } finally {
    if (askpassDir) {
      rmSync(askpassDir, { recursive: true, force: true });
    }
  }
}
