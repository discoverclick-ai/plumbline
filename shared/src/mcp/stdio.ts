import type { McpTool } from './tools.js'

/**
 * The MCP wire protocol, over stdin and stdout.
 *
 * The tool surface has existed since the kernel got one and no MCP client
 * could reach it: the tools were routed over HTTP behind a bearer token, and
 * an MCP client speaks JSON-RPC over a pipe. So the "distribution channel
 * from day one" was, until this file, a distribution channel somebody would
 * have had to write a bridge for.
 *
 * Deliberately no SDK. The stdio transport is newline-delimited JSON-RPC 2.0
 * and three methods, and a dependency here would be a dependency in the
 * thing a customer runs on their own machine against their own data. The
 * protocol is small enough to read.
 *
 * Framing note worth keeping: messages are ONE PER LINE and must not contain
 * a raw newline. JSON.stringify guarantees that for strings, but a hand-built
 * response would not, and a single stray newline desynchronises the stream
 * for the rest of the session with no error anywhere.
 */

export const PROTOCOL_VERSION = '2025-06-18'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** JSON-RPC's own codes, plus the one we use for a tool that refused. */
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INTERNAL_ERROR = -32603

export interface ServerInfo {
  name: string
  version: string
}

export interface ToolCaller {
  (name: string, args: Record<string, unknown>): Promise<unknown>
}

/**
 * Handles one message and returns one response, or null for a notification.
 *
 * Pure of transport so it can be tested without pipes, which is most of what
 * is worth testing: the framing is four lines and the dispatch is where a
 * protocol bug would live.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  deps: { tools: McpTool[]; call: ToolCaller; info: ServerInfo },
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null

  // A notification has no id and takes no response, ever. Replying to one is
  // a protocol violation that some clients treat as a fatal desync.
  const isNotification = message.id === undefined || message.id === null

  if (message.jsonrpc !== '2.0') {
    return isNotification
      ? null
      : { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Expected jsonrpc 2.0' } }
  }

  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          // Tools only. This server has no resources and no prompts, and
          // advertising capabilities it does not have makes a client ask for
          // them and get an error instead of a clean absence.
          capabilities: { tools: { listChanged: false } },
          serverInfo: deps.info,
        },
      }

    case 'notifications/initialized':
    case 'initialized':
      return null

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: deps.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            // Read-only hints are the only thing standing between a client's
            // auto-approve setting and an agent moving somebody's RFI without
            // being asked.
            annotations: { readOnlyHint: !tool.mutating, destructiveHint: false },
          })),
        },
      }

    case 'tools/call': {
      const name = String(message.params?.['name'] ?? '')
      const args = (message.params?.['arguments'] ?? {}) as Record<string, unknown>
      if (!name) {
        return { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'A tool name is required' } }
      }
      try {
        const output = await deps.call(name, args)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
            isError: false,
          },
        }
      } catch (err) {
        // A refusal comes back as a RESULT with isError, not as a JSON-RPC
        // error. The distinction matters: a permission denial is something
        // the agent should read and work around, and a transport error is
        // something it should give up on. Returning the first as the second
        // makes every "you may not do that" look like a broken server.
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          },
        }
      }
    }

    default:
      return isNotification
        ? null
        : { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `No method ${message.method}` } }
  }
}

/** One message per line, and never a raw newline inside one. */
export function encode(response: JsonRpcResponse): string {
  return `${JSON.stringify(response)}\n`
}

export function decode(line: string): JsonRpcRequest | { parseError: true } {
  try {
    const parsed = JSON.parse(line) as JsonRpcRequest
    if (typeof parsed !== 'object' || parsed === null) return { parseError: true }
    return parsed
  } catch {
    return { parseError: true }
  }
}

export function parseErrorResponse(): JsonRpcResponse {
  return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Invalid JSON' } }
}

/**
 * Reads newline-delimited messages off a stream.
 *
 * Buffered rather than line-split per chunk, because a pipe splits wherever
 * it likes: a twelve kilobyte tool result arrives in three chunks and the
 * boundary lands mid-string more often than not.
 */
export function createLineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string): void => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) onLine(line)
      newline = buffer.indexOf('\n')
    }
  }
}
