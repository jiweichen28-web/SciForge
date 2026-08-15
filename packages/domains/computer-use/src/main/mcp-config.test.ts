import { describe, expect, it } from 'vitest'
import {
  buildComputerUseMcpArgs,
  computerUseMcpEnv,
  isComputerUseMcpConfigured
} from './mcp-config'

describe('domain-owned Computer Use MCP config', () => {
  it('enables only configured runtimes with a sidecar URL', () => {
    const settings = { computerUse: { enabled: true, runtimeEnabled: { codex: true, claude: false } } }
    const env = { SCIFORGE_CUA_SERVICE_URL: 'http://127.0.0.1:3900' }
    expect(isComputerUseMcpConfigured(settings, 'codex', env)).toBe(true)
    expect(isComputerUseMcpConfigured(settings, 'claude', env)).toBe(false)
    expect(isComputerUseMcpConfigured(settings, 'codex', {})).toBe(false)
  })

  it('keeps secrets in the spawned process environment and the v1 launch flag', () => {
    expect(computerUseMcpEnv({
      SCIFORGE_CUA_SERVICE_URL: 'http://127.0.0.1:3900',
      SCIFORGE_CUA_SERVICE_TOKEN: 'test-token'
    })).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      SCIFORGE_CUA_SERVICE_URL: 'http://127.0.0.1:3900',
      SCIFORGE_CUA_SERVICE_TOKEN: 'test-token'
    })
    expect(buildComputerUseMcpArgs({
      appPath: '/app',
      execPath: '/app/sciforge',
      isPackaged: true
    })).toEqual(['/app/out/main/computer-use-mcp-node-entry.js', '--gui-owl-computer-use-mcp-server'])
  })
})
