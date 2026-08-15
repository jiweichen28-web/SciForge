import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDomainMainEntry } from './main'

describe('Computer Use main contribution', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('projects one generic runtime MCP binding and trusted metadata rule', () => {
    const entry = createDomainMainEntry({
      getUserDataDir: () => '/tmp/user-data',
      getAppRoot: () => '/app',
      getExecutablePath: () => '/app/sciforge',
      isPackaged: () => true,
      defineCapability: () => ({})
    })
    const runtime = entry.contributions.find((item) => item.kind === 'main.runtime-mcp-server')
    const capabilities = entry.contributions.find((item) => item.kind === 'main.capability-factory')
    const trusted = entry.contributions.find(
      (item) => item.kind === 'main.mcp-trusted-invocation-metadata'
    )
    expect(runtime?.value).toMatchObject({ serverId: 'gui_owl_computer_use' })
    expect(capabilities?.value).toMatchObject({
      moduleId: 'sciforge.computer-use',
      policy: { id: 'computer-use', directTransportPrefixes: [], allowedDirectTransports: [] }
    })
    expect(trusted?.value).toEqual({
      serverId: 'gui_owl_computer_use',
      tools: ['computer_use_bind_target', 'computer_use', 'computer_use_release_session'],
      metadataKey: 'io.sciforge/computer-use-invocation',
      source: 'trusted-invocation'
    })
  })

  it('reads the domain-owned Legacy lifecycle status through a trusted loopback call', async () => {
    const definitions: Array<Record<string, any>> = []
    const entry = createDomainMainEntry({
      getUserDataDir: () => '/tmp/user-data',
      defineCapability: (options) => options
    })
    const factory = entry.contributions.find((item) => item.kind === 'main.capability-factory')
      ?.value as { createDefinitions(): Array<Record<string, any>> }
    definitions.push(...factory.createDefinitions())
    const oldUrl = process.env.SCIFORGE_CUA_SERVICE_URL
    process.env.SCIFORGE_CUA_SERVICE_URL = 'http://127.0.0.1:3900'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: {
        backend: 'legacy-pyautogui',
        effectiveIsolation: 'host-approved',
        leaseScope: 'process-global',
        activeChannels: 1,
        cleanupPending: 0,
        sessions: 1,
        requests: 1,
        activeLeases: 1
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    try {
      const status = definitions.find((item) => item.id === 'computer-use.status')
      const result = await status?.handler({
        settings: {
          enabled: true,
          runtimeEnabled: { sciforge: true, codex: true, claude: true }
        }
      })
      expect(result.output.runtime).toEqual({
        configured: true,
        available: true,
        backend: 'legacy-pyautogui',
        effectiveIsolation: 'host-approved',
        leaseScope: 'process-global',
        activeChannels: 1,
        cleanupPending: 0,
        sessions: 1,
        requests: 1,
        activeLeases: 1,
        reason: null
      })
    } finally {
      if (oldUrl === undefined) delete process.env.SCIFORGE_CUA_SERVICE_URL
      else process.env.SCIFORGE_CUA_SERVICE_URL = oldUrl
    }
  })

  it('routes planner requests through active-runtime runEphemeral and closes the bridge', async () => {
    const nativeFetch = fetch
    const configured: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1:3900/')) {
        configured.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        })
      }
      return nativeFetch(input, init)
    }))
    const runEphemeral = vi.fn(async (_request: unknown) => ({
      text: JSON.stringify({ name: 'computer_use', arguments: { action: 'key', keys: ['ENTER'] } })
    }))
    const entry = createDomainMainEntry({
      getUserDataDir: () => '/tmp/user-data',
      getAppRoot: () => '/app',
      defineCapability: () => ({})
    })
    const lifecycle = entry.contributions.find((item) => item.kind === 'main.runtime-lifecycle')
      ?.value as { activate(context: Record<string, unknown>): Promise<(() => Promise<void>) | undefined> }
    const dispose = await lifecycle.activate({
      environment: {
        SCIFORGE_CUA_SERVICE_URL: 'http://127.0.0.1:3900',
        SCIFORGE_CUA_SERVICE_TOKEN: 'test-token',
        SCIFORGE_CUA_CDP_ENDPOINTS: 'http://127.0.0.1:9222'
      },
      appRoot: '/workspace',
      agentExecution: {
        run: vi.fn(async () => { throw new Error('persistent path must not run') }),
        runEphemeral
      },
      signal: new AbortController().signal,
      log: vi.fn()
    })
    const bridgeUrl = String(configured[0]?.baseUrl)
    const response = await nativeFetch(`${bridgeUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${String(configured[0]?.apiKey)}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        metadata: {
          sciforge_observation_mode: 'semantic',
          sciforge_semantic_observation: {
            targetId: 'cdp:page-1', revision: 'cdp:1',
            semanticTree: [{ tag: 'input', name: 'Editor' }]
          }
        },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Press Enter' }] }],
        tools: [{
          type: 'function', name: 'computer_use',
          parameters: {
            type: 'object', properties: {
              action: { const: 'key' }, keys: { type: 'array', items: { type: 'string' } }
            }, required: ['action', 'keys'], additionalProperties: false
          }
        }],
        tool_choice: { type: 'function', name: 'computer_use' }
      })
    })
    expect(response.status).toBe(200)
    expect(runEphemeral).toHaveBeenCalledWith(expect.objectContaining({ mode: 'plan' }))
    expect(runEphemeral.mock.calls[0]?.[0]).not.toHaveProperty('runtimeId')
    await dispose?.()
    expect(configured.at(-1)).toMatchObject({ baseUrl: '', expectedBaseUrl: bridgeUrl })
  })

  it('does not start CDP planner resources for the Legacy-only compatibility path', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('must not configure CDP resources') })
    vi.stubGlobal('fetch', fetchImpl)
    const entry = createDomainMainEntry({
      getUserDataDir: () => '/tmp/user-data',
      getAppRoot: () => '/app',
      defineCapability: () => ({})
    })
    const lifecycle = entry.contributions.find((item) => item.kind === 'main.runtime-lifecycle')
      ?.value as { activate(context: Record<string, unknown>): Promise<unknown> }

    await expect(lifecycle.activate({
      environment: {
        SCIFORGE_CUA_SERVICE_URL: 'http://127.0.0.1:3900',
        SCIFORGE_CUA_SERVICE_TOKEN: 'test-token'
      },
      appRoot: '/workspace',
      agentExecution: {
        run: vi.fn(),
        runEphemeral: vi.fn()
      }
    })).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
