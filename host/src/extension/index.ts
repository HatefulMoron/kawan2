import { readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

let requestCounter = 0;

function callHost(tool: string, params: Record<string, unknown>): Promise<any> {
  const socketPath = process.env.KAWAN_SOCKET;
  const token = process.env.KAWAN_SESSION_TOKEN;
  if (!socketPath || !token) {
    return Promise.reject(new Error("Missing KAWAN_SOCKET or KAWAN_SESSION_TOKEN"));
  }
  const id = `ext-${++requestCounter}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const conn = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      rejectPromise(err);
    };

    conn.on("error", fail);
    conn.on("connect", () => {
      conn.write(`${JSON.stringify({ id, token, tool, params })}\n`);
    });
    conn.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      settled = true;
      conn.end();
      try {
        const msg = JSON.parse(line) as { id?: string; ok: boolean; result?: unknown; error?: string };
        if (!msg.ok) {
          rejectPromise(new Error(msg.error ?? "Host tool error"));
        } else {
          resolvePromise(msg.result);
        }
      } catch (err) {
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      }
    });
    conn.on("end", () => {
      if (!settled) {
        fail(new Error("Host closed socket before replying"));
      }
    });
  });
}

function textResult(data: unknown, isError = false) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    details: typeof data === "object" && data !== null ? data : { text },
    ...(isError ? { isError: true } : {}),
  };
}

export default function (pi: ExtensionAPI) {
  const role = process.env.KAWAN_SESSION_ROLE ?? "worker";

  pi.on("before_agent_start", async (event) => {
    const ctxData = (await callHost("get_context", {})) as {
      contextFiles?: Array<{ path: string; content: string }>;
    };
    if (Array.isArray(ctxData?.contextFiles) && event.systemPromptOptions) {
      const existing = (event.systemPromptOptions.contextFiles ?? []).filter(
        (f) => !f.path.startsWith("kawan://"),
      );
      event.systemPromptOptions.contextFiles = [...existing, ...ctxData.contextFiles];
    }
  });

  pi.registerTool({
    name: "report",
    label: "Report",
    description:
      "Post a message into the conversation thread and optionally attach a text or image artifact as evidence.",
    parameters: Type.Object({
      text: Type.String({ description: "Summary or progress message to post into the conversation" }),
      artifact: Type.Optional(
        Type.Object({
          filename: Type.Optional(Type.String({ description: "Filename for the artifact, e.g. summary.txt" })),
          mime_type: Type.Optional(Type.String({ description: "MIME type, e.g. text/plain or image/png" })),
          content: Type.Optional(Type.String({ description: "UTF-8 text content of the artifact" })),
          base64: Type.Optional(Type.String({ description: "Base64-encoded binary content of the artifact" })),
          path: Type.Optional(Type.String({ description: "Relative or absolute path to an artifact file to attach" })),
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        let artifactPayload: Record<string, unknown> | undefined;
        if (params.artifact && typeof params.artifact === "object") {
          const a = params.artifact as {
            filename?: string;
            mime_type?: string;
            content?: string;
            base64?: string;
            path?: string;
          };
          if (a.path) {
            const abs = resolve(process.cwd(), a.path);
            const st = statSync(abs);
            if (st.size > 10 * 1024 * 1024) {
              return textResult(`Artifact exceeds 10 MB limit (${st.size} bytes)`, true);
            }
            const bytes = readFileSync(abs);
            const ext = abs.toLowerCase();
            const inferredMime = ext.endsWith(".png")
              ? "image/png"
              : ext.endsWith(".jpg") || ext.endsWith(".jpeg")
                ? "image/jpeg"
                : ext.endsWith(".webp")
                  ? "image/webp"
                  : "text/plain";
            artifactPayload = {
              filename: a.filename ?? basename(abs),
              mime_type: a.mime_type ?? inferredMime,
              base64: bytes.toString("base64"),
            };
          } else if (typeof a.base64 === "string") {
            artifactPayload = {
              filename: a.filename ?? "artifact.bin",
              mime_type: a.mime_type ?? "application/octet-stream",
              base64: a.base64,
            };
          } else if (typeof a.content === "string") {
            artifactPayload = {
              filename: a.filename ?? "report.txt",
              mime_type: a.mime_type ?? "text/plain",
              base64: Buffer.from(a.content, "utf8").toString("base64"),
            };
          }
        }
        const res = await callHost("report", {
          text: params.text,
          ...(artifactPayload ? { artifact: artifactPayload } : {}),
        });
        return textResult(res);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  if (role === "orchestrator") {
    pi.registerTool({
      name: "spawn_session",
      label: "Spawn Worker Session",
      description:
        "Spawn an isolated worker agent session with its own git clone and branch to perform repository work.",
      parameters: Type.Object({
        task: Type.String({ description: "Clear, self-contained task description for the worker session" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("spawn_session", { task: params.task });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "session_status",
      label: "Session Status",
      description: "Inspect the current status and last report of this bot's worker sessions.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const res = await callHost("session_status", {});
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "soul_replace",
      label: "Soul Replace",
      description:
        "Edit the bot's soul markdown document by exact unique anchor replacement. Empty text deletes the anchor.",
      parameters: Type.Object({
        anchor: Type.String({ description: "Exact unique substring in the current soul document" }),
        text: Type.String({ description: "Replacement text (or empty string to delete)" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("soul_replace", { anchor: params.anchor, text: params.text });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "soul_write",
      label: "Soul Write",
      description:
        "Rewrite the entire soul markdown document for consolidation. Must preserve all four headings and stay under 4 KB.",
      parameters: Type.Object({
        document: Type.String({ description: "Complete updated soul markdown document" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("soul_write", { document: params.document });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });
  } else {
    pi.registerTool({
      name: "land_request",
      label: "Request Land",
      description:
        "Submit this worker session's committed branch for human approval, verification, and landing onto the default branch.",
      parameters: Type.Object({
        summary: Type.Optional(Type.String({ description: "Short summary of the committed changes ready to land" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("land_request", { summary: params.summary ?? "" });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });
  }
}
