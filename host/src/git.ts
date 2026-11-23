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

export async function createSessionClone(params: {
  barePath: string;
  clonePath: string;
  defaultBranch: string;
  branchName: string;
  botName: string;
  botEmail: string;
  signingKeyPath: string;
}): Promise<void> {
  rmSync(params.clonePath, { recursive: true, force: true });
  mkdirSync(join(params.clonePath, ".."), { recursive: true });
  await runGit(["clone", "--local", params.barePath, params.clonePath]);
  await runGit(
    ["-C", params.clonePath, "checkout", "-B", params.branchName, `origin/${params.defaultBranch}`],
  );
  await runGit(["-C", params.clonePath, "config", "user.name", params.botName]);
  await runGit(["-C", params.clonePath, "config", "user.email", params.botEmail]);
  await runGit(["-C", params.clonePath, "config", "gpg.format", "ssh"]);
  await runGit(["-C", params.clonePath, "config", "commit.gpgsign", "true"]);
  await runGit(["-C", params.clonePath, "config", "user.signingkey", params.signingKeyPath]);
}

export function ensureAllowedSigners(
  dataDir: string,
  bots: Array<{ email: string | null; name: string; signing_pubkey: string | null }>,
): string {
  const path = join(dataDir, "allowed_signers");
  const lines: string[] = [];
  for (const bot of bots) {
    if (!bot.signing_pubkey) continue;
    const principal = bot.email || `${bot.name.toLowerCase()}@kawan.local`;
    lines.push(`${principal} ${bot.signing_pubkey.trim()}`);
  }
  writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o644 });
  return path;
}

export async function getBranchHead(repoDir: string, ref = "HEAD"): Promise<string> {
  const { stdout } = await runGit(["-C", repoDir, "rev-parse", ref]);
  return stdout.trim();
}

export async function isWorkingTreeClean(clonePath: string): Promise<boolean> {
  const { stdout } = await runGit(["-C", clonePath, "status", "--porcelain"]);
  return stdout.trim().length === 0;
}

export async function commitsAhead(clonePath: string, defaultBranch: string): Promise<number> {
  const { stdout } = await runGit([
    "-C",
    clonePath,
    "rev-list",
    "--count",
    `origin/${defaultBranch}..HEAD`,
  ]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

export async function verifyCommitSignature(
  repoDir: string,
  commitRef: string,
  allowedSignersPath: string,
): Promise<boolean> {
  try {
    await runGit([
      "-c",
      `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
      "-C",
      repoDir,
      "verify-commit",
      commitRef,
    ]);
    return true;
  } catch {
    return false;
  }
}

export interface LandBranchParams {
  barePath: string;
  clonePath: string;
  branchName: string;
  defaultBranch: string;
  verifyCommand: string;
  botName: string;
  botEmail: string;
  signingKeyPath: string;
  landingDir: string;
}

export interface LandBranchResult {
  ok: boolean;
  baseSha: string;
  landedSha?: string;
  verifyOutput: string;
  error?: string;
}

async function runShellCommand(
  command: string,
  cwd: string,
): Promise<{ ok: boolean; output: string; code: number | null }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        code: null,
        output: `${Buffer.concat(chunks).toString("utf8")}\nTimed out after 120s`,
      });
    }, 120_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        output: Buffer.concat(chunks).toString("utf8").trim(),
      });
    });
  });
}

export async function landBranch(params: LandBranchParams): Promise<LandBranchResult> {
  rmSync(params.landingDir, { recursive: true, force: true });
  mkdirSync(join(params.landingDir, ".."), { recursive: true });

  let baseSha = "";
  try {
    await runGit([
      "clone",
      "--local",
      "--branch",
      params.defaultBranch,
      params.barePath,
      params.landingDir,
    ]);
    baseSha = await getBranchHead(params.landingDir, "HEAD");

    await runGit(["-C", params.landingDir, "config", "user.name", params.botName]);
    await runGit(["-C", params.landingDir, "config", "user.email", params.botEmail]);
    await runGit(["-C", params.landingDir, "config", "gpg.format", "ssh"]);
    await runGit(["-C", params.landingDir, "config", "commit.gpgsign", "true"]);
    await runGit(["-C", params.landingDir, "config", "user.signingkey", params.signingKeyPath]);

    await runGit(["-C", params.landingDir, "fetch", params.clonePath, params.branchName]);

    const { stdout: aheadOut } = await runGit([
      "-C",
      params.landingDir,
      "rev-list",
      "--count",
      "HEAD..FETCH_HEAD",
    ]);
    const aheadCount = Number.parseInt(aheadOut.trim(), 10) || 0;
    if (aheadCount === 0) {
      return {
        ok: false,
        baseSha,
        verifyOutput: "",
        error: "Branch has no commits ahead of default branch",
      };
    }

    let isAncestor = false;
    try {
      await runGit(["-C", params.landingDir, "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]);
      isAncestor = true;
    } catch {
      isAncestor = false;
    }

    await runGit(["-C", params.landingDir, "checkout", "-B", params.branchName, "FETCH_HEAD"]);
    if (!isAncestor) {
      try {
        await runGit(["-C", params.landingDir, "rebase", params.defaultBranch]);
      } catch (err) {
        try {
          await runGit(["-C", params.landingDir, "rebase", "--abort"]);
        } catch {
          // ignore abort failure
        }
        return {
          ok: false,
          baseSha,
          verifyOutput: "",
          error: `Rebase onto ${params.defaultBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const verify = await runShellCommand(params.verifyCommand, params.landingDir);
    if (!verify.ok) {
      return {
        ok: false,
        baseSha,
        verifyOutput: verify.output,
        error: `Verify command failed (exit ${verify.code}):\n${verify.output}`,
      };
    }

    await runGit([
      "-C",
      params.landingDir,
      "push",
      params.barePath,
      `HEAD:refs/heads/${params.defaultBranch}`,
    ]);
    const landedSha = await getBranchHead(params.landingDir, "HEAD");
    return {
      ok: true,
      baseSha,
      landedSha,
      verifyOutput: verify.output,
    };
  } finally {
    rmSync(params.landingDir, { recursive: true, force: true });
  }
}

export function removeClone(clonePath: string | null | undefined): void {
  if (!clonePath) return;
  rmSync(clonePath, { recursive: true, force: true });
}

