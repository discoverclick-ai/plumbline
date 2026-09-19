import { describe, expect, it } from 'vitest'
import {
  createLineReader,
  decode,
  encode,
  handleMessage,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  type JsonRpcRequest,
} from '../src/mcp/stdio.js'
import { TOOLS } from '../src/mcp/tools.js'

/**
 * The wire, argued with directly.
 *
 * The tool surface existed for weeks and no MCP client could reach it,
 * because the tools were routed over HTTP behind a bearer token and an MCP
 * client speaks JSON-RPC over a pipe. This is that pipe, and the parts worth
 * testing are the ones where a protocol bug hides: framing across chunk
 * boundaries, notifications, and the difference between a refusal and a
 * transport failure.
 */

const info = { name: 'plumbline', version: '0.1.0' }
const ok = async (): Promise<unknown> => ({ fine: true })
const refuse = async (): Promise<unknown> => {
  throw new Error('You cannot close RFIs on this project')
}

const request = (method: string, params?: Record<string, unknown>, id: string | number | null = 1): JsonRpcRequest =>
  ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) as JsonRpcRequest

describe('the handshake', () => {
  it('answers initialize with a protocol version and tools only', async () => {
    const response = await handleMessage(request('initialize'), { tools: TOOLS, call: ok, info })
    const result = response!.result as Record<string, unknown>

    expect(result['protocolVersion']).toBe(PROTOCOL_VERSION)
    // Advertising capabilities it does not have makes a client ask for them
    // and get an error instead of a clean absence.
    expect(result['capabilities']).toEqual({ tools: { listChanged: false } })
    expect(result['serverInfo']).toEqual(info)
  })

  it('says nothing at all to a notification', async () => {
    // Replying to a notification is a protocol violation some clients treat
    // as a fatal desync.
    expect(await handleMessage(request('notifications/initialized', undefined, null), { tools: TOOLS, call: ok, info })).toBeNull()
    expect(
      await handleMessage({ jsonrpc: '2.0', method: 'something/unknown' } as JsonRpcRequest, {
        tools: TOOLS,
        call: ok,
        info,
      }),
    ).toBeNull()
  })

  it('names a method it does not have', async () => {
    const response = await handleMessage(request('resources/list'), { tools: TOOLS, call: ok, info })
    expect(response!.error!.code).toBe(METHOD_NOT_FOUND)
  })
})

describe('listing the tools', () => {
  it('marks the read-only ones as read-only', async () => {
    const response = await handleMessage(request('tools/list'), { tools: TOOLS, call: ok, info })
    const listed = (response!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools

    const byName = new Map(listed.map((t) => [t.name, t.annotations.readOnlyHint]))
    // This hint is the only thing standing between a client's auto-approve
    // setting and an agent moving somebody's RFI without being asked.
    expect(byName.get('search_records')).toBe(true)
    expect(byName.get('ball_in_court')).toBe(true)
    expect(byName.get('transition_record')).toBe(false)
    expect(byName.get('create_record')).toBe(false)
  })

  it('passes the schemas through untouched', async () => {
    const response = await handleMessage(request('tools/list'), { tools: TOOLS, call: ok, info })
    const listed = (response!.result as { tools: { name: string; inputSchema: unknown }[] }).tools
    const search = listed.find((t) => t.name === 'search_records')!
    expect(search.inputSchema).toEqual(TOOLS.find((t) => t.name === 'search_records')!.inputSchema)
  })
})

describe('calling a tool', () => {
  it('returns the output as text and as structured content', async () => {
    const response = await handleMessage(request('tools/call', { name: 'ball_in_court', arguments: {} }), {
      tools: TOOLS,
      call: ok,
      info,
    })
    const result = response!.result as { content: { text: string }[]; structuredContent: unknown; isError: boolean }

    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual({ fine: true })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ fine: true })
  })

  it('returns a refusal as a RESULT, not as a transport error', async () => {
    const response = await handleMessage(request('tools/call', { name: 'transition_record', arguments: {} }), {
      tools: TOOLS,
      call: refuse,
      info,
    })

    // The distinction matters: a permission denial is something the agent
    // should read and work around, and a transport error is something it
    // should give up on. Returning the first as the second makes every "you
    // may not do that" look like a broken server.
    expect(response!.error).toBeUndefined()
    const result = response!.result as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/cannot close RFIs/)
  })

  it('refuses a call with no tool named', async () => {
    const response = await handleMessage(request('tools/call', { arguments: {} }), { tools: TOOLS, call: ok, info })
    expect(response!.error).toBeDefined()
  })
})

describe('the framing', () => {
  it('never writes a raw newline inside a message', () => {
    const line = encode({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'two\nlines\nhere' }] },
    })
    // A single stray newline desynchronises the stream for the rest of the
    // session, with no error anywhere.
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(line.endsWith('\n')).toBe(true)
  })

  it('reassembles a message split across chunk boundaries', () => {
    const seen: string[] = []
    const read = createLineReader((line) => seen.push(line))

    const message = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
    // A pipe splits wherever it likes, and on a twelve kilobyte tool result
    // the boundary lands mid-string more often than not.
    read(message.slice(0, 11))
    read(message.slice(11, 24))
    read(`${message.slice(24)}\n`)

    expect(seen).toEqual([message])
    expect(decode(seen[0]!)).toMatchObject({ method: 'tools/list', id: 7 })
  })

  it('handles several messages arriving in one chunk', () => {
    const seen: string[] = []
    const read = createLineReader((line) => seen.push(line))
    read('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
    expect(seen).toHaveLength(2)
  })

  it('says so on unparseable input rather than falling over', () => {
    expect(decode('not json at all')).toEqual({ parseError: true })
    expect(decode('"a bare string"')).toEqual({ parseError: true })
  })
})
