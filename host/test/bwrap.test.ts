import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { composeSpawnSpec, materializeSessionAgentDir } from "../src/spawn.js";

const execFileAsync = promisify(execFile);

test("bwrap spawn wrapper isolates host ~/.pi and launches pi inside sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kawan-bwrap-"));
  const agentDir = join(dir, "agent");
  const sessionDir = join(dir, "pi-sessions");
  const cwd = join(dir, "work");
  const sockDir = join(dir, "sock");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sockDir, { recursive: true });

  const settings = {
    providers: {
      stub: {
        baseUrl: "http://127.0.0.1:9999/v1",
        api: "openai-completions" as const,
        apiKey: "test-key",
        models: [
          {
            id: "stub-model",
            name: "stub-model",
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
          },
        ],
      },
    },
    roles: {
      default: { provider: "stub", model: "stub-model", thinking_level: "medium" },
    },
  };

  materializeSessionAgentDir(agentDir, settings);

  const spec = composeSpawnSpec({
    role: "worker",
    bot: {
      id: "bot-1",
      kind: "bot",
      role: "member",
      name: "kawan",
      email: "kawan@kawan.local",
      persona: null,
      model: "stub/stub-model",
      thinking_level: "medium",
      sandbox_enabled: 1,
      sandbox_network: 0,
      signing_key_path: null,
      signing_pubkey: null,
      created_at: 0,
    },
    settings,
    agentDir,
    sessionDir,
    cwd,
    socketPath: join(sockDir, "host.sock"),
    extensionPath: resolve("src/extension/index.ts"),
    sessionToken: "tok",
    systemPrompt: "test",
    disableSandbox: false,
  });

  try {
    assert.equal(spec.command, "bwrap");
    assert.ok(spec.args.includes("--unshare-net"));

    // Replace the trailing pi command args after `--` with `--version` to verify bwrap runs pi
    const sepIdx = spec.args.indexOf("--");
    assert.ok(sepIdx >= 0);
    const piBin = spec.args[sepIdx + 1];
    const verArgs = [...spec.args.slice(0, sepIdx + 1), piBin, "--version"];
    const { stdout } = await execFileAsync("bwrap", verArgs, {
      env: spec.env,
      timeout: 15_000,
    });
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);

    // Verify host ~/.pi/agent/auth.json is NOT visible inside sandbox
    const checkHostHome = [
      ...spec.args.slice(0, sepIdx + 1),
      "/bin/sh",
      "-c",
      `test ! -e "${process.env.HOME}/.pi/agent/auth.json" && echo isolated`,
    ];
    const iso = await execFileAsync("bwrap", checkHostHome, { env: spec.env, timeout: 10_000 });
    assert.equal(iso.stdout.trim(), "isolated");

    // Verify cwd is writable inside sandbox
    const writeArgs = [
      ...spec.args.slice(0, sepIdx + 1),
      "/bin/sh",
      "-c",
      "echo ok > sandbox_write_test.txt && cat sandbox_write_test.txt",
    ];
    const wr = await execFileAsync("bwrap", writeArgs, { env: spec.env, timeout: 10_000 });
    assert.equal(wr.stdout.trim(), "ok");
    writeFileSync(join(cwd, "host-check.txt"), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bwrap with sandbox_network enabled exposes /etc/resolv.conf and omits --unshare-net", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kawan-bwrap-net-"));
  const agentDir = join(dir, "agent");
  const sessionDir = join(dir, "pi-sessions");
  const cwd = join(dir, "work");
  const sockDir = join(dir, "sock");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sockDir, { recursive: true });

  const settings = {
    providers: {
      stub: {
        baseUrl: "http://127.0.0.1:9999/v1",
        api: "openai-completions" as const,
        apiKey: "test-key",
        models: [
          {
            id: "stub-model",
            name: "stub-model",
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
          },
        ],
      },
    },
    roles: {
      default: { provider: "stub", model: "stub-model", thinking_level: "medium" },
    },
  };

  materializeSessionAgentDir(agentDir, settings);

  const spec = composeSpawnSpec({
    role: "worker",
    bot: {
      id: "bot-net",
      kind: "bot",
      role: "member",
      name: "kawan",
      email: "kawan@kawan.local",
      persona: null,
      model: "stub/stub-model",
      thinking_level: "medium",
      sandbox_enabled: 1,
      sandbox_network: 1,
      signing_key_path: null,
      signing_pubkey: null,
      created_at: 0,
    },
    settings,
    agentDir,
    sessionDir,
    cwd,
    socketPath: join(sockDir, "host.sock"),
    extensionPath: resolve("src/extension/index.ts"),
    sessionToken: "tok",
    systemPrompt: "test",
    disableSandbox: false,
  });

  try {
    assert.equal(spec.command, "bwrap");
    assert.ok(!spec.args.includes("--unshare-net"));

    const sepIdx = spec.args.indexOf("--");
    assert.ok(sepIdx >= 0);
    const resolvArgs = [
      ...spec.args.slice(0, sepIdx + 1),
      "/bin/sh",
      "-c",
      "test -r /etc/resolv.conf && grep -q nameserver /etc/resolv.conf && echo ok",
    ];
    const res = await execFileAsync("bwrap", resolvArgs, { env: spec.env, timeout: 10_000 });
    assert.equal(res.stdout.trim(), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
