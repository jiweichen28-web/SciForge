import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  computerUseBindTargetInputSchema,
  computerUseEmptyInputSchema,
  computerUseReleaseSessionInputSchema,
  computerUseRunInputSchema
} from '../contract.js'
import {
  COMPUTER_USE_BIND_TARGET_TOOL_NAME,
  COMPUTER_USE_GET_CAPABILITIES_TOOL_NAME,
  COMPUTER_USE_LIST_TARGETS_TOOL_NAME,
  COMPUTER_USE_MCP_LAUNCH_FLAG,
  COMPUTER_USE_MCP_TOOL_NAME,
  COMPUTER_USE_RELEASE_SESSION_TOOL_NAME,
  GUI_COMPUTER_USE_MCP_SERVER_NAME
} from './mcp-config.js'

const TRUSTED_INVOCATION_METADATA_KEY = 'io.sciforge/computer-use-invocation'
const DEFAULT_TIMEOUT_MS = 600_000

type ToolResult = CallToolResult & {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: true
}

type ServiceConfig = { serviceUrl: string; serviceToken: string; timeoutMs: number }
type TrustedInvocation = Readonly<{
  requestId: string
  runtimeId: string
  threadId: string
  actionId: string
  invocationId: string
  approval: 'confirmation'
}>

export type StartComputerUseMcpServerOptions = { transport?: Transport; env?: NodeJS.ProcessEnv }

export async function runComputerUseMcpServerFromArgv(
  argv: string[], options: StartComputerUseMcpServerOptions = {}
): Promise<boolean> {
  if (!argv.includes(COMPUTER_USE_MCP_LAUNCH_FLAG)) return false
  await startComputerUseMcpServer(options)
  return true
}

export async function startComputerUseMcpServer(
  options: StartComputerUseMcpServerOptions = {}
): Promise<void> {
  const server = createComputerUseMcpServer(resolveComputerUseServiceConfig(options.env ?? process.env))
  await server.connect(options.transport ?? new StdioServerTransport())
}

export function createComputerUseMcpServer(
  config: ServiceConfig | null = resolveComputerUseServiceConfig()
): McpServer {
  const server = new McpServer(
    { name: GUI_COMPUTER_USE_MCP_SERVER_NAME, version: '0.2.0' },
    { capabilities: { logging: {} } }
  )
  if (!config) return server

  server.registerTool(COMPUTER_USE_GET_CAPABILITIES_TOOL_NAME, {
    description: 'Read target-scoped Computer Use backend capabilities.',
    inputSchema: computerUseEmptyInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (_args, extra) => callService(config, 'GET', '/computer-use/capabilities', undefined, extra.signal))

  server.registerTool(COMPUTER_USE_LIST_TARGETS_TOOL_NAME, {
    description: 'List redacted browser-page targets currently owned by configured CDP adapters.',
    inputSchema: computerUseEmptyInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (_args, extra) => callService(config, 'GET', '/computer-use/targets', undefined, extra.signal))

  server.registerTool(COMPUTER_USE_BIND_TARGET_TOOL_NAME, {
    description: 'Bind one canonical browser page as a target-scoped Computer Use session.',
    inputSchema: computerUseBindTargetInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (args, extra) => mutation(config, '/computer-use/sessions/bind', args, extra._meta, extra.signal))

  server.registerTool(COMPUTER_USE_MCP_TOOL_NAME, {
    description: [
      'Execute one instruction.',
      'Omit computerUseSessionId for Backend: Legacy/PyAutoGUI. Isolation: host-approved. Lease: process-global.',
      'Provide a bound computerUseSessionId, or a bounded parallel batch with two to eight unique bound sessions,',
      'for Backend: browser-cdp. Isolation: host-app-scoped.',
      'Returns a ServiceResult trace; the caller must verify task completion.'
    ].join(' '),
    inputSchema: computerUseRunInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (args, extra) => mutation(config, '/computer-use/run', args, extra._meta, extra.signal, true))

  server.registerTool(COMPUTER_USE_RELEASE_SESSION_TOOL_NAME, {
    description: 'Release a bound target session and its adapter handle.',
    inputSchema: computerUseReleaseSessionInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (args, extra) => mutation(config, '/computer-use/sessions/release', args, extra._meta, extra.signal))
  return server
}

async function mutation(
  config: ServiceConfig,
  path: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  signal: AbortSignal,
  cancelOnAbort = false
): Promise<ToolResult> {
  const trusted = parseTrustedInvocation(meta)
  if (!trusted) return errorToolResult(
    'APPROVAL_PROOF_REQUIRED', 'Computer Use mutation requires one trusted, confirmed Host invocation.'
  )
  return callService(config, 'POST', path, {
    ...args,
    ...(path === '/computer-use/run' ? { execute: true, approve: true } : {}),
    requestId: trusted.requestId,
    invocation: trusted
  }, signal, cancelOnAbort ? trusted.requestId : undefined)
}

async function callService(
  config: ServiceConfig,
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
  cancelRequestId?: string
): Promise<ToolResult> {
  const controller = new AbortController()
  const cancel = (): void => {
    if (!cancelRequestId) return
    void fetch(`${config.serviceUrl}/computer-use/cancel`, {
      method: 'POST', headers: jsonHeaders(config.serviceToken),
      body: JSON.stringify({ requestId: cancelRequestId }), redirect: 'error'
    }).catch(() => undefined)
  }
  controller.signal.addEventListener('abort', cancel, { once: true })
  const unlink = linkAbortSignal(signal, controller)
  const timeout = setTimeout(() => controller.abort(new Error('Computer Use service timeout.')), config.timeoutMs)
  try {
    const response = await fetch(`${config.serviceUrl}${path}`, {
      method,
      headers: jsonHeaders(config.serviceToken),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
      redirect: 'error'
    })
    const payload = await response.json().catch(() => null)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return errorToolResult('BAD_RESPONSE', `Computer Use service returned non-JSON (HTTP ${response.status}).`)
    }
    const record = payload as Record<string, unknown>
    const summary = serviceSummary(record, response.status, response.ok)
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: record,
      ...(record.ok === false || !response.ok ? { isError: true as const } : {})
    }
  } catch (error) {
    return errorToolResult('UNAVAILABLE', controller.signal.aborted
      ? 'Computer Use call timed out or was cancelled.'
      : `Computer Use call failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timeout)
    controller.signal.removeEventListener('abort', cancel)
    unlink()
  }
}

export function resolveComputerUseServiceConfig(
  env: NodeJS.ProcessEnv = process.env
): ServiceConfig | null {
  const serviceUrl = (env.SCIFORGE_CUA_SERVICE_URL ?? '').trim().replace(/\/+$/, '')
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(serviceUrl)) return null
  const timeout = Number(env.SCIFORGE_CUA_SERVICE_TIMEOUT_MS)
  return {
    serviceUrl,
    serviceToken: (env.SCIFORGE_CUA_SERVICE_TOKEN ?? env.CUA_SERVICE_TOKEN ?? '').trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS
  }
}

function parseTrustedInvocation(meta: Record<string, unknown> | undefined): TrustedInvocation | null {
  const value = meta?.[TRUSTED_INVOCATION_METADATA_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.approval !== 'confirmation') return null
  const fields = ['requestId', 'runtimeId', 'threadId', 'actionId', 'invocationId'] as const
  const values = Object.fromEntries(fields.map((field) => [field, stringId(record[field])])) as Record<typeof fields[number], string>
  if (fields.some((field) => !values[field])) return null
  return { ...values, approval: 'confirmation' }
}

function stringId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : ''
}

function serviceSummary(record: Record<string, unknown>, status: number, ok: boolean): string {
  if (typeof record.summary === 'string' && record.summary.trim()) return record.summary
  const error = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown> : null
  if (record.ok === false && error) return `${String(error.code ?? 'UNKNOWN')}: ${String(error.message ?? 'Computer Use failed')}`
  return ok ? 'Computer Use operation completed.' : `Computer Use failed (HTTP ${status}).`
}

function jsonHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

function linkAbortSignal(signal: AbortSignal, controller: AbortController): () => void {
  if (signal.aborted) { controller.abort(signal.reason); return () => undefined }
  const abort = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

function errorToolResult(code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { ok: false, error: { code, message } },
    isError: true
  }
}
