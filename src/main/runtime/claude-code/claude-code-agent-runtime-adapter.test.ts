import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeAdapterContext } from '../agent-runtime/adapter'
import type { ClaudeCodeRuntimeService } from './claude-code-service'
import { createClaudeCodeAgentRuntimeAdapter } from './claude-code-agent-runtime-adapter'

describe('createClaudeCodeAgentRuntimeAdapter', () => {
  it('forwards one-shot thread ownership to the Claude service', async () => {
    const startThread = vi.fn(async () => ({
      ok: true as const,
      thread: { id: 'thread-ephemeral', runtimeId: 'claude' as const, title: 'One shot', updatedAt: '' }
    }))
    const adapter = createClaudeCodeAgentRuntimeAdapter({
      startThread
    } as unknown as ClaudeCodeRuntimeService)

    await adapter.startThread({ settings: {} as never }, {
      runtimeId: 'claude',
      workspace: '/tmp/workspace',
      ephemeral: true
    })

    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
  })

  it('seeds Claude pre-dispatch governance from Host-owned typed turn metadata', async () => {
    const received: unknown[] = []
    const adapter = createClaudeCodeAgentRuntimeAdapter({
      startTurn: async (input: unknown) => {
        received.push(input)
        return {
          ok: true,
          threadId: 'thread-seeded-governance',
          turnId: 'turn-seeded-governance',
          userMessageItemId: 'user-seeded-governance'
        }
      }
    } as unknown as ClaudeCodeRuntimeService)
    const ctx = {
      settings: {},
      turnGovernanceSnapshot: {
        ownedVisualToolsAvailable: true,
        nativeVisualProofChainPending: true
      }
    } as AgentRuntimeAdapterContext

    await adapter.startTurn(ctx, {
      runtimeId: 'claude',
      threadId: 'thread-seeded-governance',
      text: 'Host prepared text',
      workspace: '/tmp/workspace',
      allowedTools: ['sciforge_discover']
    })

    expect(received).toEqual([expect.objectContaining({
      threadId: 'thread-seeded-governance',
      allowedTools: ['sciforge_discover'],
      ownedVisualToolsAvailable: true,
      nativeVisualProofChainPending: true
    })])
  })

  it('forwards Host-owned turn governance snapshots without interpreting them', async () => {
    const received: unknown[] = []
    const adapter = createClaudeCodeAgentRuntimeAdapter({
      updateTurnGovernanceSnapshot: (input: unknown) => {
        received.push(input)
      }
    } as unknown as ClaudeCodeRuntimeService)
    const ctx = { settings: {} } as AgentRuntimeAdapterContext
    const input = {
      runtimeId: 'claude' as const,
      threadId: 'thread-governance',
      turnId: 'turn-governance',
      snapshot: {
        ownedVisualToolsAvailable: true,
        nativeVisualProofChainPending: true
      }
    }

    await adapter.updateTurnGovernanceSnapshot?.(ctx, input)

    expect(received).toEqual([input])
  })

  it('reports domain-owned tools only through the generic Claude MCP capability', async () => {
    const adapter = createClaudeCodeAgentRuntimeAdapter({
      isMcpConfigured: () => true,
      runtimeInfo: async () => ({
        command: 'claude',
        model: 'sciforge-router'
      })
    } as unknown as ClaudeCodeRuntimeService)
    const ctx = { settings: {} } as AgentRuntimeAdapterContext

    await expect(adapter.capabilities(ctx)).resolves.toMatchObject({
      runtimeId: 'claude',
      tools: {
        mcp: { available: true },
        computerUse: {
          available: false,
          reason: 'Domain-owned tools are exposed through the generic MCP capability.'
        }
      }
    })
    await expect(adapter.auxiliary?.(ctx, {
      operation: 'getToolDiagnostics'
    })).resolves.toMatchObject({ mcpServers: [] })
    await expect(adapter.auxiliary?.(ctx, {
      operation: 'getRuntimeInfo'
    })).resolves.toMatchObject({
      capabilities: {
        mcp: {
          configuredServers: 1
        }
      }
    })
  })

  it('honors shared subagent capability settings', async () => {
    const adapter = createClaudeCodeAgentRuntimeAdapter({
      runtimeInfo: async () => ({
        command: 'claude',
        model: 'sciforge-router'
      })
    } as unknown as ClaudeCodeRuntimeService)
    const ctx = {
      settings: {
        agentCapabilities: {
          subagents: {
            enabled: false,
            maxParallel: 2
          }
        }
      }
    } as AgentRuntimeAdapterContext

    await expect(adapter.capabilities(ctx)).resolves.toMatchObject({
      tools: {
        subagents: {
          available: false,
          maxParallel: 2
        }
      }
    })
    await expect(adapter.auxiliary?.(ctx, {
      operation: 'getRuntimeInfo'
    })).resolves.toMatchObject({
      capabilities: {
        subagents: {
          available: false,
          maxParallel: 2
        }
      }
    })
  })

  it('reports memory as unavailable without failing listMemories diagnostics', async () => {
    const adapter = createClaudeCodeAgentRuntimeAdapter({
      runtimeInfo: async () => ({
        command: 'claude',
        model: 'sciforge-router'
      })
    } as unknown as ClaudeCodeRuntimeService)
    const ctx = { settings: {} } as AgentRuntimeAdapterContext

    await expect(adapter.capabilities(ctx)).resolves.toMatchObject({
      runtimeId: 'claude',
      storage: {
        memory: { available: false }
      }
    })
    await expect(adapter.auxiliary?.(ctx, {
      operation: 'getRuntimeInfo'
    })).resolves.toMatchObject({
      host: 'claude-code',
      command: 'claude',
      model: 'sciforge-router',
      capabilities: {
        attachments: { available: false },
        web: {
          fetch: { available: false },
          search: { available: false }
        },
        memory: { available: false }
      }
    })
    await expect(adapter.auxiliary?.(ctx, {
      operation: 'listMemories',
      payload: { options: { workspace: '/tmp/project', includeDeleted: false } }
    })).resolves.toEqual([])
    await expect(adapter.auxiliary?.(ctx, {
      operation: 'updateMemory',
      payload: { memoryId: 'mem_1', patch: { disabled: true } }
    })).rejects.toThrow(/does not support memory operations/)
  })
})
