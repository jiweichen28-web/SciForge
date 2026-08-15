import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPUTER_USE_BIND_TARGET_TOOL_NAME,
  COMPUTER_USE_MCP_TOOL_NAME,
  COMPUTER_USE_RELEASE_SESSION_TOOL_NAME
} from './mcp-config'
import { createComputerUseMcpServer } from './mcp-server'

const openServers: Array<{ close: () => Promise<void> }> = []
afterEach(async () => Promise.all(openServers.splice(0).map((server) => server.close())))

const trustedMeta = {
  'io.sciforge/computer-use-invocation': {
    requestId: 'request-1',
    runtimeId: 'codex',
    threadId: 'thread-1',
    actionId: 'managed-mcp.computer_use.test',
    invocationId: 'invocation-1',
    approval: 'confirmation'
  }
}

describe('domain-owned Computer Use MCP server', () => {
  it('does not expose tools until the sidecar is configured', async () => {
    const server = createComputerUseMcpServer(null)
    const client = new Client({ name: 'test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      await expect(client.listTools()).rejects.toMatchObject({ code: -32601 })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('discloses the legacy backend and isolation boundary in the managed tool catalog', async () => {
    const server = createComputerUseMcpServer({
      serviceUrl: 'http://127.0.0.1:3900',
      serviceToken: 'sidecar-token',
      timeoutMs: 5_000
    })
    const client = new Client({ name: 'test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const catalog = await client.listTools()
      const tool = catalog.tools.find(({ name }) => name === COMPUTER_USE_MCP_TOOL_NAME)
      expect(tool?.description).toContain('Backend: Legacy/PyAutoGUI.')
      expect(tool?.description).toContain('Isolation: host-approved.')
      expect(tool?.description).toContain('Lease: process-global.')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('requires trusted confirmation before forwarding an instruction-equivalent v1 call', async () => {
    const requests: Record<string, unknown>[] = []
    const sidecar = await startFakeSidecar(async (request, response) => {
      requests.push(await readJsonBody(request))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, summary: 'done', data: { status: 'done' } }))
    })
    const server = createComputerUseMcpServer({
      serviceUrl: sidecar.url,
      serviceToken: 'sidecar-token',
      timeoutMs: 5_000
    })
    const client = new Client({ name: 'test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const denied = await client.callTool({
        name: COMPUTER_USE_MCP_TOOL_NAME,
        arguments: { instruction: 'open Settings' }
      })
      expect(denied.isError).toBe(true)
      expect(requests).toHaveLength(0)

      const result = await client.callTool({
        name: COMPUTER_USE_MCP_TOOL_NAME,
        arguments: { instruction: 'open Settings' },
        _meta: trustedMeta
      })
      expect(result.isError).toBeUndefined()
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        instruction: 'open Settings',
        execute: true,
        approve: true,
        invocation: trustedMeta['io.sciforge/computer-use-invocation']
      })
      expect(requests[0]?.requestId).toBe('request-1')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('exposes five tools and protects bind/release with the same trusted identity', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = []
    const sidecar = await startFakeSidecar(async (request, response) => {
      seen.push({ url: request.url ?? '', body: await readJsonBody(request) })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, data: { status: 'ok' } }))
    })
    const server = createComputerUseMcpServer({
      serviceUrl: sidecar.url, serviceToken: 'sidecar-token', timeoutMs: 5_000
    })
    const client = new Client({ name: 'test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const tools = (await client.listTools()).tools
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'computer_use', 'computer_use_bind_target', 'computer_use_get_capabilities',
        'computer_use_list_targets', 'computer_use_release_session'
      ])
      expect(tools.find((tool) => tool.name === COMPUTER_USE_RELEASE_SESSION_TOOL_NAME)?.annotations)
        .toMatchObject({ readOnlyHint: false, idempotentHint: true, openWorldHint: true })
      const denied = await client.callTool({
        name: COMPUTER_USE_BIND_TARGET_TOOL_NAME,
        arguments: { targetId: 'cdp:page-1' }
      })
      expect(denied.isError).toBe(true)
      expect(seen).toHaveLength(0)
      await client.callTool({
        name: COMPUTER_USE_BIND_TARGET_TOOL_NAME,
        arguments: { targetId: 'cdp:page-1' }, _meta: trustedMeta
      })
      await client.callTool({
        name: COMPUTER_USE_RELEASE_SESSION_TOOL_NAME,
        arguments: { computerUseSessionId: 'session-1' }, _meta: trustedMeta
      })
      expect(seen.map((entry) => entry.url)).toEqual([
        '/computer-use/sessions/bind', '/computer-use/sessions/release'
      ])
      expect(seen[0]?.body).toMatchObject({
        targetId: 'cdp:page-1', requestId: 'request-1',
        invocation: trustedMeta['io.sciforge/computer-use-invocation']
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('validates and forwards one approved bounded parallel batch under the parent identity', async () => {
    const requests: Record<string, unknown>[] = []
    const sidecar = await startFakeSidecar(async (request, response) => {
      requests.push(await readJsonBody(request))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        data: { requestedCount: 2, successCount: 2, failureCount: 0, results: [] }
      }))
    })
    const server = createComputerUseMcpServer({
      serviceUrl: sidecar.url, serviceToken: 'sidecar-token', timeoutMs: 5_000
    })
    const client = new Client({ name: 'test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const result = await client.callTool({
        name: COMPUTER_USE_MCP_TOOL_NAME,
        arguments: {
          parallel: [
            { instruction: 'alpha', computerUseSessionId: 'session-a', deadlineMs: 5_000 },
            { instruction: 'beta', computerUseSessionId: 'session-b' }
          ]
        },
        _meta: trustedMeta
      })
      expect(result.isError).toBeUndefined()
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        parallel: [
          { instruction: 'alpha', computerUseSessionId: 'session-a', deadlineMs: 5_000 },
          { instruction: 'beta', computerUseSessionId: 'session-b' }
        ],
        execute: true,
        approve: true,
        requestId: 'request-1',
        invocation: trustedMeta['io.sciforge/computer-use-invocation']
      })
      expect(requests[0]).not.toHaveProperty('instruction')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('cancels the exact trusted request identity when the sidecar call times out', async () => {
    let releaseRun!: () => void
    const runReleased = new Promise<void>((resolve) => { releaseRun = resolve })
    let observeCancel!: (value: Record<string, unknown>) => void
    const cancelSeen = new Promise<Record<string, unknown>>((resolve) => { observeCancel = resolve })
    const sidecar = await startFakeSidecar(async (request, response) => {
      const body = await readJsonBody(request)
      if (request.url === '/computer-use/cancel') {
        observeCancel(body)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
        releaseRun()
        return
      }
      await runReleased
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'CANCEL_PENDING' } }))
    })
    const server = createComputerUseMcpServer({
      serviceUrl: sidecar.url,
      serviceToken: 'sidecar-token',
      timeoutMs: 25
    })
    const client = new Client({ name: 'test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const result = await client.callTool({
        name: COMPUTER_USE_MCP_TOOL_NAME,
        arguments: { instruction: 'wait for the desktop' },
        _meta: trustedMeta
      })
      expect(result.isError).toBe(true)
      await expect(cancelSeen).resolves.toEqual({ requestId: 'request-1' })
    } finally {
      releaseRun()
      await client.close()
      await server.close()
    }
  })

  it('keeps cleanup failures explicit in both MCP text and structured diagnostics', async () => {
    const sidecar = await startFakeSidecar(async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        ok: false,
        error: {
          code: 'CLEANUP_INCOMPLETE',
          message: 'Legacy input release failed.',
          details: { requestId: 'request-1', errors: ['synthetic close failure'] }
        }
      }))
    })
    const server = createComputerUseMcpServer({
      serviceUrl: sidecar.url,
      serviceToken: 'sidecar-token',
      timeoutMs: 5_000
    })
    const client = new Client({ name: 'test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const result = await client.callTool({
        name: COMPUTER_USE_MCP_TOOL_NAME,
        arguments: { instruction: 'open Settings' },
        _meta: trustedMeta
      })
      expect(result.isError).toBe(true)
      expect(result.content).toContainEqual(expect.objectContaining({
        type: 'text',
        text: 'CLEANUP_INCOMPLETE: Legacy input release failed.'
      }))
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'CLEANUP_INCOMPLETE', details: { requestId: 'request-1' } }
      })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

async function startFakeSidecar(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: String(error) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const wrapped = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
  openServers.push(wrapped)
  return wrapped
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}
