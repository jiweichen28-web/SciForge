import { describe, expect, it } from 'vitest'
import { startComputerUseAdapterRuntime } from './computer-use-adapter-runtime.js'

describe('Computer Use adapter runtime', () => {
  it('closes the adapter listener when sidecar registration fails', async () => {
    let adapterUrl = ''
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { adapterUrl?: string }
      adapterUrl = body.adapterUrl ?? ''
      return new Response('{}', { status: 503 })
    }) as typeof fetch

    await expect(startComputerUseAdapterRuntime({
      serviceUrl: 'http://127.0.0.1:3900',
      serviceToken: 'test-token',
      browserEndpoints: ['http://127.0.0.1:9222'],
      fetchImpl
    })).rejects.toThrow('registration failed')

    expect(adapterUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await expect(fetch(`${adapterUrl}/v1/capabilities`, {
      headers: { Authorization: 'Bearer unavailable' }
    })).rejects.toThrow()
  })

  it('closes the adapter listener and reports a failed sidecar unregister', async () => {
    let adapterUrl = ''
    let calls = 0
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      const body = JSON.parse(String(init?.body)) as { adapterUrl?: string }
      if (body.adapterUrl) adapterUrl = body.adapterUrl
      return new Response('{}', { status: calls === 1 ? 200 : 503 })
    }) as typeof fetch
    const runtime = await startComputerUseAdapterRuntime({
      serviceUrl: 'http://127.0.0.1:3900',
      serviceToken: 'test-token',
      browserEndpoints: ['http://127.0.0.1:9222'],
      fetchImpl
    })

    await expect(runtime.close()).rejects.toThrow('registration failed')
    expect(calls).toBe(2)
    await expect(fetch(`${adapterUrl}/v1/capabilities`, {
      headers: { Authorization: 'Bearer unavailable' }
    })).rejects.toThrow()
  })
})
