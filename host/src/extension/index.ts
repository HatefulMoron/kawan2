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

  const artifactParamSchema = Type.Optional(
    Type.Object({
      filename: Type.Optional(
        Type.String({ description: "Filename for the artifact, e.g. report.md" }),
      ),
      mime_type: Type.Optional(
        Type.String({ description: "MIME type, e.g. text/markdown, text/plain, or image/png" }),
      ),
      content: Type.Optional(Type.String({ description: "UTF-8 text content of the artifact" })),
      base64: Type.Optional(
        Type.String({ description: "Base64-encoded binary content of the artifact" }),
      ),
      path: Type.Optional(
        Type.String({ description: "Relative or absolute path to an artifact file to attach" }),
      ),
    }),
  );

  const reportParameters =
    role === "orchestrator"
      ? Type.Object({
          text: Type.String({ description: "Message to post into the conversation" }),
          artifact: artifactParamSchema,
          in_thread: Type.Optional(
            Type.Boolean({
              description:
                "Post inside a thread under the triggering message (true) or top-level in the channel (false). Omit to follow current context.",
            }),
          ),
        })
      : Type.Object({
          text: Type.String({
            description:
              role === "reviewer"
                ? "Review findings or concise approval to post directly in the issue conversation"
                : "Report, question, or result (sent to your orchestrator, or directly to the issue room if working on an issue). A finished result becomes the review card humans approve from, so write it as a user-facing changelog entry focused on outcomes and attach screenshots for visual changes; leave file names, markup, and logs out of it.",
          }),
          artifact: artifactParamSchema,
        });

  pi.registerTool({
    name: "report",
    label: "Report",
    description:
      role === "orchestrator"
        ? "Post a message into the active conversation and optionally attach a text, markdown, or image artifact."
        : role === "reviewer"
          ? "Post read-only code review findings or approval directly into the issue conversation and optionally attach a markdown artifact."
          : "Send a summary, progress note, blocking question, or artifact (to your orchestrator, or directly into the issue room when bound to an issue). Final summaries are shown in the Status view and approval cards, so describe the user-visible outcome in changelog style and attach screenshots for visual changes.",
    parameters: reportParameters,
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
                  : ext.endsWith(".md") || ext.endsWith(".markdown")
                    ? "text/markdown"
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
            const fname = a.filename ?? "report.txt";
            const lowerName = fname.toLowerCase();
            const inferredMime =
              lowerName.endsWith(".md") || lowerName.endsWith(".markdown")
                ? "text/markdown"
                : "text/plain";
            artifactPayload = {
              filename: fname,
              mime_type: a.mime_type ?? inferredMime,
              base64: Buffer.from(a.content, "utf8").toString("base64"),
            };
          }
        }
        const inThread = (params as { in_thread?: unknown }).in_thread;
        const res = await callHost("report", {
          text: params.text,
          ...(artifactPayload ? { artifact: artifactPayload } : {}),
          ...(role === "orchestrator" && typeof inThread === "boolean"
            ? { in_thread: inThread }
            : {}),
        });
        return textResult(res);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  if (role === "orchestrator" || role === "worker") {
    pi.registerTool({
      name: "review_issue",
      label: "Review Issue",
      description:
        "Launch a fresh read-only reviewer session against the issue's active branch clone; findings are posted directly to the issue conversation.",
      parameters: Type.Object({
        issue_ref: Type.Optional(
          Type.String({ description: "Issue ID or #number (defaults to current issue room)" }),
        ),
        focus: Type.Optional(
          Type.String({ description: "Optional review focus (e.g. 'Security', 'Edge cases')" }),
        ),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("review_issue", {
            ...(params.issue_ref ? { issue_ref: params.issue_ref } : {}),
            ...(params.focus ? { focus: params.focus } : {}),
          });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });
  }

  if (role === "orchestrator") {
    pi.registerTool({
      name: "spawn_session",
      label: "Spawn Worker Session",
      description:
        "Spawn an isolated worker agent session with its own git clone and branch to perform repository work.",
      parameters: Type.Object({
        title: Type.Optional(
          Type.String({ description: "Short 3-6 word human-readable title shown in the Tasks UI" }),
        ),
        task: Type.String({ description: "Clear, self-contained task description for the worker session" }),
        in_thread: Type.Optional(
          Type.Boolean({
            description:
              "Whether updates and wrap-up for this task belong in a thread under the triggering message (defaults to true in channels, false in DMs).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("spawn_session", {
            task: params.task,
            ...(params.title ? { title: params.title } : {}),
            ...(typeof params.in_thread === "boolean" ? { in_thread: params.in_thread } : {}),
          });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "message_session",
      label: "Message Worker Session",
      description:
        "Send an answer or follow-up instruction directly to an existing worker session by session_id.",
      parameters: Type.Object({
        session_id: Type.String({ description: "Target worker session ID" }),
        message: Type.String({ description: "Answer or instruction for the worker" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("message_session", {
            session_id: params.session_id,
            message: params.message,
          });
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

    pi.registerTool({
      name: "create_issue",
      label: "Create Issue",
      description: "Create a new durable markdown Issue (#N) with its own conversation room.",
      parameters: Type.Object({
        title: Type.String({ description: "Short issue title" }),
        body_md: Type.Optional(Type.String({ description: "Markdown specification and acceptance notes" })),
        implementer_bot_id: Type.Optional(Type.String({ description: "Optional implementer bot ID" })),
        parent_issue_id: Type.Optional(Type.String({ description: "Optional parent epic issue ID or #N" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("create_issue", {
            title: params.title,
            ...(params.body_md !== undefined ? { body_md: params.body_md } : {}),
            ...(params.implementer_bot_id ? { implementer_bot_id: params.implementer_bot_id } : {}),
            ...(params.parent_issue_id ? { parent_issue_id: params.parent_issue_id } : {}),
          });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "update_issue",
      label: "Update Issue",
      description: "Update an existing issue's title, markdown spec, or settings.",
      parameters: Type.Object({
        issue_ref: Type.String({ description: "Issue ID or #number (e.g. '#1')" }),
        title: Type.Optional(Type.String({ description: "Updated title" })),
        body_md: Type.Optional(Type.String({ description: "Updated markdown specification" })),
        implementer_bot_id: Type.Optional(Type.String({ description: "Implementer bot ID" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("update_issue", {
            issue_ref: params.issue_ref,
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.body_md !== undefined ? { body_md: params.body_md } : {}),
            ...(params.implementer_bot_id !== undefined
              ? { implementer_bot_id: params.implementer_bot_id }
              : {}),
          });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "list_issues",
      label: "List Issues",
      description: "List repository issues and their current workflow statuses.",
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: "Optional status filter" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("list_issues", {
            ...(params.status ? { status: params.status } : {}),
          });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });
  } else if (role === "queue") {
    pi.registerTool({
      name: "resume_and_land",
      label: "Resume and Land",
      description:
        "Re-run repository verification checks in the landing clone and fast-forward onto the default branch after reconciliation.",
      parameters: Type.Object({
        summary: Type.Optional(
          Type.String({
            description:
              "Short user-facing changelog note of how the conflict or failure was reconciled; no file names, logs, or git plumbing",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("resume_and_land", { summary: params.summary ?? "" });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "eject_to_implementer",
      label: "Eject to Implementer",
      description:
        "Return the paused branch to the implementer with an explanation and unpause the merge queue.",
      parameters: Type.Object({
        reason: Type.String({ description: "Clear explanation of what needs to be fixed on the branch" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("eject_to_implementer", { reason: params.reason });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });
  } else if (role !== "reviewer") {
    pi.registerTool({
      name: "land_request",
      label: "Request Land",
      description:
        "Mark this worker session's committed changes as ready for human approval in the Tasks UI and notify your orchestrator (for ad-hoc chat tasks only; not used inside issues).",
      parameters: Type.Object({
        summary: Type.Optional(
          Type.String({
            description:
              "User-facing changelog summary of what changed for the user and how it was verified (shown in the Status view review card); no file names, markup, logs, or git plumbing",
          }),
        ),
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

    pi.registerTool({
      name: "ask_owner",
      label: "Ask Issue Owner",
      description:
        "Flag a blocking question for the issue owner and ping @owner directly (keeps the issue open).",
      parameters: Type.Object({
        question: Type.String({ description: "Clear question for the issue owner" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("ask_owner", { question: params.question });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "sync_with_main",
      label: "Sync With Main",
      description:
        "Fetch the latest default branch from origin bare repo and rebase committed changes onto it cleanly.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const res = await callHost("sync_with_main", {});
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });

    pi.registerTool({
      name: "update_issue",
      label: "Update Issue Spec",
      description: "Update the markdown specification or title for the active issue (#N).",
      parameters: Type.Object({
        issue_ref: Type.Optional(Type.String({ description: "Issue ID or #number (defaults to current issue)" })),
        title: Type.Optional(Type.String({ description: "Updated title" })),
        body_md: Type.Optional(Type.String({ description: "Updated markdown specification" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const res = await callHost("update_issue", {
            ...(params.issue_ref ? { issue_ref: params.issue_ref } : {}),
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.body_md !== undefined ? { body_md: params.body_md } : {}),
          });
          return textResult(res);
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    });
  }
}
