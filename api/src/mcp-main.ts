import {
  createLineReader,
  decode,
  encode,
  handleMessage,
  parseErrorResponse,
  TOOLS,
  type JsonRpcRequest,
} from '@plumbline/shared'

/**
 * The MCP server a customer actually runs.
 *
 * It holds no database connection and no credentials of its own. It talks to
 * the same HTTP API the web client talks to, with the same bearer token, so
 * an agent given somebody's session gets exactly that person's access and
 * nothing else. There is no service account anywhere in this path, and that
 * is the whole security argument: an agent is a client, not a role.
 *
 *   PLUMBLINE_URL=https://plumbline.example.com \
 *   PLUMBLINE_TOKEN=... \
 *   node dist/mcp-main.js
 *
 * NOTHING may be written to stdout except protocol messages. A stray
 * console.log desynchronises the stream and the client's only symptom is a
 * server that stopped responding, so every diagnostic here goes to stderr.
 */

const baseUrl = (process.env['PLUMBLINE_URL'] ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const token = process.env['PLUMBLINE_TOKEN'] ?? ''

if (!token) {
  process.stderr.write('PLUMBLINE_TOKEN is required: this server acts as a person, never as itself.\n')
  process.exit(1)
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${baseUrl}/mcp/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, arguments: args }),
  })

  const text = await response.text()
  let parsed: { result?: unknown; error?: string; message?: string }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new Error(`The server returned something that is not JSON (${response.status})`)
  }

  if (!response.ok) {
    // The server's own words. It knows whether this was a permission, a
    // validation or a missing record, and paraphrasing would give the agent
    // less to work with than the person would have had.
    throw new Error(parsed.message ?? parsed.error ?? `Request failed with ${response.status}`)
  }
  return parsed.result
}

// node:readline is deliberately NOT used here. Its line splitting is fine,
// but reading the stream by hand keeps the framing in one place with the
// decoder that has to agree with it.
const write = (line: string): void => void process.stdout.write(line)

const reader = createLineReader((line) => {
  const message = decode(line)
  if ('parseError' in message) {
    write(encode(parseErrorResponse()))
    return
  }
  void handleMessage(message as JsonRpcRequest, {
    tools: TOOLS,
    call,
    info: { name: 'plumbline', version: '0.1.0' },
  })
    .then((response) => {
      if (response) write(encode(response))
    })
    .catch((err: unknown) => {
      process.stderr.write(`[mcp] ${err instanceof Error ? err.message : String(err)}\n`)
    })
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => reader(chunk))
process.stdin.on('end', () => process.exit(0))
