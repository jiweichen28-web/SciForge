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
      tools: ['computer_use'],
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
})
