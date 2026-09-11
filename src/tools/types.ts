/**
 * Tool execution types for 9Router ToolRuntime
 *
 * Defines the contract for tools that the RouterProvider can invoke
 * during a tool-calling loop with the 9Router LLM gateway.
 */

// A function tool definition in OpenAI-compatible format
export interface ToolFunctionSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// A tool call returned by the model
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string, as returned by OpenAI-compatible API
  };
}

// Result of executing a tool
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  content: string; // Text content returned to the model as tool result
  error: string | null;
}

// Execution limits
export interface ToolExecutionContext {
  workspaceRoot: string;          // Absolute path to the git workspace
  maxRounds: number;               // Max tool-rounds in the loop
  maxToolCalls: number;            // Max total tool calls
  commandTimeoutMs: number;        // Per-command timeout
  maxFileBytes: number;            // Max bytes for read_file
  maxWriteBytes: number;           // Max bytes for write_file
  redactSecrets: boolean;          // Redact secrets in output
}

// Tool runtime result
export interface ToolRuntimeResult {
  results: ToolResult[];
  changedFiles: string[];
  commitSha: string | null;
  error: string | null;
}
