      toolCalls: totalToolCalls,
      toolRounds: toolRounds,
    };
  }

  /**
   * Convert internal message format to API-compatible format.
   * Tool-call assistant turns must use an empty string, not null, because
   * Kilo-compatible OpenAI endpoints can reject content:null on tool calls.
   */
  private messagesToApi(messages: OpenAIChatMessage[]): Record<string, unknown>[] {
    return messages.map(msg => {
      const result: Record<string, unknown> = { role: msg.role };
      if (msg.content !== undefined) {
        result.content = msg.content;
      } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
        result.content = '';
      } else {
        result.content = null;
      }
      if (msg.tool_calls) {
        result.tool_calls = msg.tool_calls;
      }
      if (msg.tool_call_id) {
        result.tool_call_id = msg.tool_call_id;
      }
      return result;
    });
  }

  private parseError(text: string): { message: string; type?: string; code?: string } {
    try {
      const parsed = JSON.parse(text);