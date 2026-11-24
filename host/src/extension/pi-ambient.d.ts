declare module "typebox" {
  export interface TSchema {
    [key: string]: unknown;
  }
  export const Type: {
    Object(props: Record<string, TSchema>, opts?: Record<string, unknown>): TSchema;
    String(opts?: Record<string, unknown>): TSchema;
    Number(opts?: Record<string, unknown>): TSchema;
    Boolean(opts?: Record<string, unknown>): TSchema;
    Optional(schema: TSchema): TSchema;
    Array(items: TSchema, opts?: Record<string, unknown>): TSchema;
  };
}

declare module "@earendil-works/pi-coding-agent" {
  export interface BeforeAgentStartEvent {
    type: "before_agent_start";
    messageType: "user" | "custom";
    prompt?: string;
    systemPrompt: string;
    systemPromptOptions: {
      customPrompt?: string;
      forceSystemPrompt?: string;
      selectedTools: string[];
      contextFiles: Array<{ path: string; content: string }>;
      [key: string]: unknown;
    };
  }

  export interface ExtensionToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: unknown;
      isError?: boolean;
    }>;
  }

  export interface ExtensionAPI {
    on(
      event: "before_agent_start",
      handler: (
        event: BeforeAgentStartEvent,
        ctx: unknown,
      ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
    ): void;
    registerTool(tool: ExtensionToolDefinition): void;
  }
}
