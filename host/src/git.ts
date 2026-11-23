import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { composeCheckCommand } from "./spawn.js";
import type { CheckRunItem, RepoCheckResult, SessionDiffFile, SessionDiffSummary } from "./types.js";

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

async function runCheckSpec(
  spec: { command: string; args: string[]; cwd: string; env: Record<string, string> },
  timeoutMs = 120_000,
): Promise<{ ok: boolean; output: string; code: number | null; durationMs: number }> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
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
        durationMs: Date.now() - started,
        output: `${Buffer.concat(chunks).toString("utf8")}\nTimed out after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        durationMs: Date.now() - started,
        output: err.message,
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        durationMs: Date.now() - started,
        output: Buffer.concat(chunks).toString("utf8").trim(),
      });
    });
  });
}

export async function branchTouchesKawanDir(workdir: string, baseRef: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(["-C", workdir, "diff", "--name-only", baseRef, "HEAD"]);
    return stdout
      .split(/\r?\n/)
      .some((line) => line.trim() === ".kawan" || line.trim().startsWith(".kawan/"));
  } catch {
    return false;
  }
}

export async function runRepoChecks(params: {
  workdir: string;
  verifyCommand?: string | null;
  sandboxEnabled?: boolean;
  sandboxNetwork?: boolean;
  disableSandbox?: boolean;
  timeoutMs?: number;
}): Promise<RepoCheckResult> {
  const checksDir = join(params.workdir, ".kawan", "checks");
  const ciScript = join(params.workdir, ".kawan", "ci");
  const sandboxEnabled = params.sandboxEnabled ?? true;
  const sandboxNetwork = params.sandboxNetwork ?? true;
  const disableSandbox = Boolean(params.disableSandbox);
  const timeoutMs = params.timeoutMs ?? 120_000;

  let executableChecks: Array<{ name: string; command: string; args: string[] }> = [];
  let source: RepoCheckResult["source"] = "verify_command";

  if (existsSync(checksDir)) {
    try {
      const names = readdirSync(checksDir)
        .filter((name) => !name.startsWith("."))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const name of names) {
        const full = join(checksDir, name);
        try {
          const st = statSync(full);
          if (st.isFile() && (st.mode & 0o111) !== 0) {
            executableChecks.push({ name, command: full, args: [] });
          }
        } catch {
          // ignore unreadable entry
        }
      }
      if (executableChecks.length > 0) {
        source = "kawan_checks";
      }
    } catch {
      // fall through
    }
  }

  if (executableChecks.length === 0 && existsSync(ciScript)) {
    try {
      const st = statSync(ciScript);
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        source = "kawan_ci";
        executableChecks = [{ name: "ci", command: ciScript, args: [] }];
      }
    } catch {
      // ignore
    }
  }

  if (executableChecks.length === 0) {
    const cmd = params.verifyCommand?.trim() ?? "";
    if (!cmd) {
      return {
        ok: false,
        source: "verify_command",
        checks: [
          {
            name: "verify",
            ok: false,
            exit_code: null,
            duration_ms: 0,
            output: "No .kawan/checks/* script or verify_command configured",
          },
        ],
        summary: "verify failed (0/1)",
        combined_output: "No .kawan/checks/* script or verify_command configured",
      };
    }
    source = "verify_command";
    executableChecks = [{ name: "verify", command: "sh", args: ["-c", cmd] }];
  }

  const results: CheckRunItem[] = [];
  for (const chk of executableChecks) {
    const spec = composeCheckCommand({
      cwd: params.workdir,
      command: chk.command,
      args: chk.args,
      sandboxEnabled,
      sandboxNetwork,
      disableSandbox,
    });
    const res = await runCheckSpec(spec, timeoutMs);
    results.push({
      name: chk.name,
      ok: res.ok,
      exit_code: res.code,
      duration_ms: res.durationMs,
      output: res.output,
    });
  }

  const passed = results.filter((c) => c.ok).length;
  const allOk = passed === results.length;
  const combined = results
    .map((c) => {
      const hdr = `[${c.ok ? "PASS" : "FAIL"} exit=${c.exit_code ?? "timeout"}] ${c.name} (${c.duration_ms}ms)`;
      return c.output ? `${hdr}\n${c.output}` : hdr;
    })
    .join("\n\n");

  return {
    ok: allOk,
    source,
    checks: results,
    summary: allOk
      ? `${source === "verify_command" ? "verify" : "checks"} passed (${passed}/${results.length})`
      : `${results.find((c) => !c.ok)?.name ?? "check"} failed (${passed}/${results.length} passed)`,
    combined_output: combined,
  };
}

export interface PrepareLandingParams {
  barePath: string;
  clonePath: string;
  branchName: string;
  defaultBranch: string;
  botName: string;
  botEmail: string;
  signingKeyPath: string;
  landingDir: string;
}

export interface PrepareLandingResult {
  ok: boolean;
  baseSha: string;
  touchesKawan: boolean;
  error?: string;
}

export async function prepareLandingClone(params: PrepareLandingParams): Promise<PrepareLandingResult> {
  rmSync(params.landingDir, { recursive: true, force: true });
  mkdirSync(join(params.landingDir, ".."), { recursive: true });

  await runGit([
    "clone",
    "--local",
    "--branch",
    params.defaultBranch,
    params.barePath,
    params.landingDir,
  ]);
  const baseSha = await getBranchHead(params.landingDir, "HEAD");

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
      touchesKawan: false,
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
  const touchesKawan = await branchTouchesKawanDir(params.landingDir, params.defaultBranch);

  if (!isAncestor) {
    try {
      await runGit(["-C", params.landingDir, "rebase", params.defaultBranch]);
    } catch (err) {
      return {
        ok: false,
        baseSha,
        touchesKawan,
        error: `Rebase onto ${params.defaultBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { ok: true, baseSha, touchesKawan };
}

export async function finalizeLandingPush(params: {
  landingDir: string;
  barePath: string;
  defaultBranch: string;
}): Promise<string> {
  await runGit([
    "-C",
    params.landingDir,
    "push",
    params.barePath,
    `HEAD:refs/heads/${params.defaultBranch}`,
  ]);
  return await getBranchHead(params.landingDir, "HEAD");
}

export async function landBranch(params: LandBranchParams): Promise<LandBranchResult> {
  try {
    const prep = await prepareLandingClone(params);
    if (!prep.ok) {
      try {
        await runGit(["-C", params.landingDir, "rebase", "--abort"]);
      } catch {
        // ignore if no rebase active
      }
      return {
        ok: false,
        baseSha: prep.baseSha,
        verifyOutput: "",
        error: prep.error,
      };
    }

    const checks = await runRepoChecks({
      workdir: params.landingDir,
      verifyCommand: params.verifyCommand,
      sandboxEnabled: false,
      disableSandbox: true,
    });
    if (!checks.ok) {
      const firstFail = checks.checks.find((c) => !c.ok);
      return {
        ok: false,
        baseSha: prep.baseSha,
        verifyOutput: checks.combined_output,
        error: `Verify command failed (exit ${firstFail?.exit_code ?? "null"}):\n${checks.combined_output}`,
      };
    }

    const landedSha = await finalizeLandingPush({
      landingDir: params.landingDir,
      barePath: params.barePath,
      defaultBranch: params.defaultBranch,
    });
    return {
      ok: true,
      baseSha: prep.baseSha,
      landedSha,
      verifyOutput: checks.combined_output,
    };
  } finally {
    rmSync(params.landingDir, { recursive: true, force: true });
  }
}

export function removeClone(clonePath: string | null | undefined): void {
  if (!clonePath) return;
  rmSync(clonePath, { recursive: true, force: true });
}

const MAX_DIFF_FILES = 40;
const MAX_DIFF_BYTES = 64 * 1024;

export async function getSessionDiff(params: {
  barePath?: string;
  defaultBranch?: string;
  clonePath?: string | null;
  baseSha?: string | null;
  landedSha?: string | null;
}): Promise<SessionDiffSummary> {
  let gitPrefix: string[] | null = null;
  let diffArgs: string[] = [];
  let baseRef: string | null = null;
  let headRef: string | null = null;

  if (params.baseSha && params.landedSha && params.barePath && existsSync(params.barePath)) {
    gitPrefix = ["--git-dir", params.barePath, "-c", "core.quotePath=false"];
    diffArgs = [params.baseSha, params.landedSha];
    baseRef = params.baseSha.slice(0, 12);
    headRef = params.landedSha.slice(0, 12);
  } else if (params.clonePath && existsSync(params.clonePath)) {
    gitPrefix = ["-C", params.clonePath, "-c", "core.quotePath=false"];
    const defaultBranch = params.defaultBranch ?? "main";
    let resolvedBase = `origin/${defaultBranch}`;
    try {
      const { stdout } = await runGit([
        "-C",
        params.clonePath,
        "merge-base",
        `origin/${defaultBranch}`,
        "HEAD",
      ]);
      if (stdout.trim()) {
        resolvedBase = stdout.trim();
      }
    } catch {
      // Fall back to origin/<defaultBranch>
    }
    try {
      const head = await getBranchHead(params.clonePath, "HEAD");
      headRef = head.slice(0, 12);
    } catch {
      headRef = null;
    }
    baseRef = resolvedBase.startsWith("origin/") ? resolvedBase : resolvedBase.slice(0, 12);
    diffArgs = [resolvedBase];
  }

  if (!gitPrefix) {
    return {
      available: false,
      base_ref: null,
      head_ref: null,
      files_changed: 0,
      insertions: 0,
      deletions: 0,
      truncated: false,
      files: [],
      note: "No git diff available for this session.",
    };
  }

  const [{ stdout: numstatOut }, { stdout: nameStatusOut }] = await Promise.all([
    runGit([...gitPrefix, "diff", "--numstat", "--no-renames", ...diffArgs, "--"]),
    runGit([...gitPrefix, "diff", "--name-status", "--no-renames", ...diffArgs, "--"]),
  ]);

  const statusByPath = new Map<string, string>();
  for (const line of nameStatusOut.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx <= 0) continue;
    const status = line.slice(0, tabIdx).trim();
    const filePath = line.slice(tabIdx + 1).trim();
    if (filePath) {
      statusByPath.set(filePath, status);
    }
  }

  const entries: Array<{ path: string; status: string; insertions: number; deletions: number }> = [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const line of numstatOut.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
    const del = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
    const filePath = parts.slice(2).join("\t").trim();
    if (!filePath) continue;
    totalInsertions += ins;
    totalDeletions += del;
    entries.push({
      path: filePath,
      status: statusByPath.get(filePath) ?? "M",
      insertions: ins,
      deletions: del,
    });
  }

  let truncated = entries.length > MAX_DIFF_FILES;
  const selected = entries.slice(0, MAX_DIFF_FILES);
  const files: SessionDiffFile[] = [];
  let totalPatchBytes = 0;

  for (const entry of selected) {
    let patch = "";
    if (totalPatchBytes < MAX_DIFF_BYTES) {
      try {
        const { stdout } = await runGit([
          ...gitPrefix,
          "diff",
          "-U3",
          "--no-renames",
          ...diffArgs,
          "--",
          entry.path,
        ]);
        const remaining = MAX_DIFF_BYTES - totalPatchBytes;
        const buf = Buffer.from(stdout, "utf8");
        if (buf.byteLength > remaining) {
          patch = `${buf.subarray(0, remaining).toString("utf8")}\n... (diff truncated)`;
          totalPatchBytes = MAX_DIFF_BYTES;
          truncated = true;
        } else {
          patch = stdout.trimEnd();
          totalPatchBytes += buf.byteLength;
        }
      } catch (err) {
        patch = `Failed to load patch: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      truncated = true;
    }

    files.push({
      path: entry.path,
      status: entry.status,
      insertions: entry.insertions,
      deletions: entry.deletions,
      patch,
    });
  }

  return {
    available: true,
    base_ref: baseRef,
    head_ref: headRef,
    files_changed: entries.length,
    insertions: totalInsertions,
    deletions: totalDeletions,
    truncated,
    files,
  };
}

export async function commitsBehindMain(
  barePath: string,
  clonePath: string,
  defaultBranch: string,
): Promise<number> {
  if (!existsSync(clonePath)) return 0;
  try {
    await runGit(["-C", clonePath, "fetch", barePath, defaultBranch]);
    const { stdout } = await runGit(["-C", clonePath, "rev-list", "--count", "HEAD..FETCH_HEAD"]);
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function syncBranchWithMain(params: {
  barePath: string;
  clonePath: string;
  defaultBranch: string;
}): Promise<{
  ok: boolean;
  behindBefore: number;
  behindAfter: number;
  headSha?: string;
  conflicted?: boolean;
  error?: string;
}> {
  if (!existsSync(params.clonePath)) {
    return {
      ok: false,
      behindBefore: 0,
      behindAfter: 0,
      error: "Worker clone directory is missing",
    };
  }
  const clean = await isWorkingTreeClean(params.clonePath);
  if (!clean) {
    return {
      ok: false,
      behindBefore: 0,
      behindAfter: 0,
      error: "Working tree has uncommitted changes; commit or discard before syncing with main.",
    };
  }
  await runGit(["-C", params.clonePath, "fetch", params.barePath, params.defaultBranch]);
  const { stdout: countOut } = await runGit([
    "-C",
    params.clonePath,
    "rev-list",
    "--count",
    "HEAD..FETCH_HEAD",
  ]);
  const behindBefore = Number.parseInt(countOut.trim(), 10) || 0;
  if (behindBefore === 0) {
    const headSha = await getBranchHead(params.clonePath, "HEAD");
    return { ok: true, behindBefore: 0, behindAfter: 0, headSha };
  }
  try {
    await runGit(["-C", params.clonePath, "rebase", "FETCH_HEAD"]);
    const headSha = await getBranchHead(params.clonePath, "HEAD");
    return { ok: true, behindBefore, behindAfter: 0, headSha };
  } catch (err) {
    try {
      await runGit(["-C", params.clonePath, "rebase", "--abort"]);
    } catch {
      // ignore if rebase already aborted
    }
    return {
      ok: false,
      behindBefore,
      behindAfter: behindBefore,
      conflicted: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

