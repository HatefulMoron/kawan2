import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ScriptedToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScriptedTurn {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  status?: number;
  errorBody?: unknown;
}

export type ScriptedHandler = (reqBody: any, callIndex: number) => ScriptedTurn | Promise<ScriptedTurn>;

export interface StubProviderServer {
  baseUrl: string;
  systemOneBaseUrl: string;
  requests: any[];
  systemOneRequests: any[];
  setHandler(handler: ScriptedHandler): void;
  setSystemOneHandler(
    handler: (reqBody: any) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>,
  ): void;
  close(): Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeSseChunk(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function startStubProvider(): Promise<StubProviderServer> {
  const requests: any[] = [];
  const systemOneRequests: any[] = [];
  let chatHandler: ScriptedHandler = () => ({ text: "ok" });
  let sysOneHandler: (reqBody: any) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }> =
    () => ({
      status: 200,
      body: {
        model: "stub-snap",
        answers: {
          destination: { type: "choice", choice: "orchestrator", confidence: 0.99, probabilities: { orchestrator: 0.99, none: 0.01 } },
          readiness: { type: "choice", choice: "dispatch", confidence: 0.99, probabilities: { dispatch: 0.99, hold: 0.01 } },
          explicit_work_start: { type: "choice", choice: "yes", confidence: 0.99, probabilities: { yes: 0.99, no: 0.01 } },
          work_request: { type: "choice", choice: "yes", confidence: 0.99, probabilities: { yes: 0.99, no: 0.01 } },
        },
      },
    });

  const server: Server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "";
      if (req.method === "GET" && url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
        return;
      }

      if (req.method === "POST" && url.endsWith("/systemone")) {
        const body = await readJsonBody(req);
        systemOneRequests.push(body);
        const result = await sysOneHandler(body);
        res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }

      if (req.method === "POST" && url.endsWith("/chat/completions")) {
        const body = await readJsonBody(req);
        const idx = requests.length;
        requests.push(body);
        const turn = await chatHandler(body, idx);

        if (turn.status && turn.status >= 400) {
          res.writeHead(turn.status, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              turn.errorBody ?? { error: { message: `Simulated error ${turn.status}`, type: "server_error" } },
            ),
          );
          return;
        }

        const model = String(body.model ?? "stub-model");
        const id = `chatcmpl-${idx + 1}`;
        const created = Math.floor(Date.now() / 1000);

        if (!body.stream) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id,
              object: "chat.completion",
              created,
              model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: turn.text ?? null,
                    ...(turn.toolCalls
                      ? {
                          tool_calls: turn.toolCalls.map((tc, i) => ({
                            id: tc.id ?? `call_${idx}_${i}`,
                            type: "function",
                            function: {
                              name: tc.name,
                              arguments: JSON.stringify(tc.arguments),
                            },
                          })),
                        }
                      : {}),
                  },
                  finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
          );
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        writeSseChunk(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });

        if (turn.text) {
          writeSseChunk(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }],
          });
        }

        if (turn.toolCalls && turn.toolCalls.length > 0) {
          for (let i = 0; i < turn.toolCalls.length; i += 1) {
            const tc = turn.toolCalls[i];
            const callId = tc.id ?? `call_${idx}_${i}`;
            writeSseChunk(res, {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: i,
                        id: callId,
                        type: "function",
                        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
          }
        }

        writeSseChunk(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found" } }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Unexpected stub address");

  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    systemOneBaseUrl: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    systemOneRequests,
    setHandler(h) {
      chatHandler = h;
    },
    setSystemOneHandler(h) {
      sysOneHandler = h;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
