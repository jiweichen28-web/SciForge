import {
  createPlaywrightCdpDriver,
  startComputerUseCdpAdapter,
  type ComputerUseCdpAdapter
} from './computer-use-cdp-adapter.js'

export type ComputerUseAdapterRuntime = Readonly<{
  adapter: ComputerUseCdpAdapter
  close(): Promise<void>
}>

export async function startComputerUseAdapterRuntime(options: Readonly<{
  serviceUrl: string
  serviceToken: string
  browserEndpoints: readonly string[]
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}>): Promise<ComputerUseAdapterRuntime> {
  const serviceUrl = trustedLoopback(options.serviceUrl)
  const serviceToken = options.serviceToken.trim()
  if (!serviceToken) throw new Error('Computer Use sidecar token is required for adapter registration.')
  const endpoints = options.browserEndpoints.map((value) => value.trim()).filter(Boolean)
  if (endpoints.length === 0) throw new Error('No allowlisted browser CDP endpoint is configured.')
  const adapter = await startComputerUseCdpAdapter({ driver: createPlaywrightCdpDriver(endpoints) })
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    await configure(fetchImpl, serviceUrl, serviceToken, {
      adapterUrl: adapter.url,
      adapterToken: adapter.token
    }, options.signal)
  } catch (error) {
    try {
      await adapter.close()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'CDP adapter registration failed and adapter cleanup was incomplete.',
        { cause: error }
      )
    }
    throw error
  }
  let closed = false
  return Object.freeze({
    adapter,
    async close() {
      if (closed) return
      closed = true
      const errors: unknown[] = []
      try {
        await configure(fetchImpl, serviceUrl, serviceToken, {
          adapterUrl: '', adapterToken: '', expectedAdapterUrl: adapter.url
        })
      } catch (error) {
        errors.push(error)
      }
      try {
        await adapter.close()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(errors, 'CDP adapter shutdown was incomplete.')
      }
    }
  })
}

async function configure(
  fetchImpl: typeof fetch,
  serviceUrl: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetchImpl(`${serviceUrl}/computer-use/backends/cdp/configure`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(3_000)])
      : AbortSignal.timeout(3_000)
  })
  if (!response.ok) throw new Error(`CDP adapter registration failed (HTTP ${response.status}).`)
}

function trustedLoopback(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '')
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(value)) {
    throw new Error('Computer Use sidecar must use credential-free loopback HTTP.')
  }
  return value
}
