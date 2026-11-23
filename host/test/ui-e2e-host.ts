import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startHost } from "../src/server.js";
import { createFixtureBareRepo, TestKeyPair } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

const execFileAsync = promisify(execFile);

async function main() {
  const stub = await startStubProvider();
  stub.setHandler((reqBody) => {
    const msgs = reqBody.messages ?? [];
    const sysText = JSON.stringify(msgs[0] ?? "");
    const lastMsg = msgs[msgs.length - 1];
    const hasToolResult = lastMsg?.role === "tool";
    const lastUserText = JSON.stringify(
      [...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "",
    );

    // Handle `models.test` short completion probe cleanly
    if (msgs[0]?.role !== "system" && lastUserText.includes("Reply with ok")) {
      return { text: "ok" };
    }

    if (sysText.includes("AI engineering orchestrator")) {
      if (lastUserText.includes("[worker-report")) {
        return { text: "NO_REPLY" };
      }
      if (!hasToolResult) {
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                task: "Create land_ok.txt containing 'ready', commit it, and call report then land_request.",
              },
            },
          ],
        };
      }
      return { text: "Spawned worker to prepare the change." };
    }

    const toolCallsMade = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCallsMade === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: {
              command:
                "printf 'ready\\n' > land_ok.txt && git add land_ok.txt && git commit -m 'Add land_ok.txt'",
            },
          },
        ],
      };
    }
    if (toolCallsMade === 1) {
      return {
        toolCalls: [
          {
            name: "report",
            arguments: { text: "Committed land_ok.txt and verified locally." },
          },
        ],
      };
    }
    if (toolCallsMade === 2) {
      return {
        toolCalls: [
          {
            name: "land_request",
            arguments: { summary: "Ready for approval" },
          },
        ],
      };
    }
    return { text: "Land requested." };
  });

  const repo = await createFixtureBareRepo({ "README.md": "# Kawan UI E2E\n" });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-ui-e2e-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  const host = await startHost({
    dataDir,
    quiet: true,
    disableSandbox: true,
    decisionMode: "live",
  });

  const { stdout: headOut } = await execFileAsync(
    "git",
    ["-C", repo.barePath, "rev-parse", `refs/heads/${repo.defaultBranch}`],
    { timeout: 10_000 },
  );
  const initialHead = headOut.trim();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await host.close().catch(() => {});
    await stub.close().catch(() => {});
    repo.cleanup();
    rmSync(adminKey.dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  process.stdout.write(
    `${JSON.stringify({
      url: host.url,
      bootstrap_token: host.bootstrapToken,
      repo_bare_path: repo.barePath,
      stub_llm_url: stub.baseUrl,
      stub_decision_url: stub.systemOneBaseUrl,
      admin_key_path: adminKey.privatePath,
      initial_head: initialHead,
      data_dir: dataDir,
    })}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
