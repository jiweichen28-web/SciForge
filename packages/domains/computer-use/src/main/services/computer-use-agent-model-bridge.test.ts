import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainMainAgentExecutionHost } from '@sciforge/domain-sdk'
import {
  startComputerUseAgentModelBridge,
  type ComputerUseAgentModelBridge
} from './computer-use-agent-model-bridge.js'

let bridge: ComputerUseAgentModelBridge | null = null

afterEach(async () => {
  await bridge?.close()
  bridge = null
})

const observation = {
  sciforge_observation_mode: 'semantic',
  sciforge_semantic_observation: {
    targetId: 'cdp:adapter:page-1',
    revision: 'cdp:4',
    semanticTree: [{ tag: 'button', name: 'Submit', center: [500, 400] }]
  }
}

const actionSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['click', 'type', 'key'] },
    coordinate: {
      type: 'array', items: { type: 'number', minimum: 0, maximum: 1000 },
      minItems: 2, maxItems: 2
    }
  },
  required: ['action'],
  additionalProperties: false
}

function execution(text: string) {
  const runEphemeral = vi.fn(async (_request: Record<string, unknown>) => ({
    text, threadId: 'ephemeral-1'
  }))
  const host: DomainMainAgentExecutionHost = {
    run: vi.fn(async () => { throw new Error('persistent planner path must not run') }),
    runEphemeral
  }
  return { host, runEphemeral }
}

async function start(text: string) {
  const state = execution(text)
  bridge = await startComputerUseAgentModelBridge({
    agentExecution: state.host,
    workspaceRoot: 'C:\\workspace'
  })
  return state
}

async function request(body: Record<string, unknown>) {
  return fetch(`${bridge!.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridge!.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
}

function forced(parameters: unknown = actionSchema) {
  return {
    stream: false,
    metadata: observation,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Act once.' }] }],
    tools: [{ type: 'function', name: 'computer_use', parameters }],
    tool_choice: { type: 'function', name: 'computer_use' }
  }
}

describe('Computer Use agent model bridge', () => {
  it('uses active-runtime one-shot execution with a target-bound semantic prompt', async () => {
    const state = await start(JSON.stringify({
      name: 'computer_use', arguments: { action: 'click', coordinate: [500, 400] }
    }))

    const response = await request(forced())

    expect(response.status).toBe(200)
    expect(state.runEphemeral).toHaveBeenCalledWith(expect.objectContaining({
      allowedTools: [],
      interaction: 'background',
      mode: 'plan',
      prompt: expect.stringContaining('cdp:adapter:page-1')
    }))
    expect(state.runEphemeral.mock.calls[0]?.[0]).not.toHaveProperty('runtimeId')
  })

  it.each([
    ['wrong function name', { name: 'other', arguments: { action: 'click' } }],
    ['missing required', { name: 'computer_use', arguments: {} }],
    ['wrong type', { name: 'computer_use', arguments: { action: 1 } }],
    ['wrong enum', { name: 'computer_use', arguments: { action: 'open_app' } }],
    ['additional property', { name: 'computer_use', arguments: { action: 'key', extra: true } }],
    ['out-of-range coordinate', {
      name: 'computer_use', arguments: { action: 'click', coordinate: [1001, 500] }
    }]
  ])('rejects %s before any backend can dispatch', async (_label, output) => {
    await start(JSON.stringify(output))
    const response = await request(forced())
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'computer_use_planner_unavailable' }
    })
  })

  it('rejects an invalid declared schema before Agent execution', async () => {
    const state = await start(JSON.stringify({ name: 'computer_use', arguments: {} }))
    const response = await request(forced({ type: 'not-a-json-schema-type' }))
    expect(response.status).toBe(502)
    expect(state.runEphemeral).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated and unbound observations before Agent execution', async () => {
    const state = await start(JSON.stringify({ name: 'computer_use', arguments: { action: 'key' } }))
    const unauthorized = await fetch(`${bridge!.baseUrl}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })
    expect(unauthorized.status).toBe(401)
    const unbound = await request({ ...forced(), metadata: {} })
    expect(unbound.status).toBe(502)
    expect(state.runEphemeral).not.toHaveBeenCalled()
  })
})
