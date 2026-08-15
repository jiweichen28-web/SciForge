import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { computerUseV1InputSchema } from '../contract.js'
import {
  COMPUTER_USE_MCP_LAUNCH_FLAG,
  COMPUTER_USE_MCP_TOOL_NAME,
  GUI_COMPUTER_USE_MCP_SERVER_NAME
} from './mcp-config.js'

const TRUSTED_INVOCATION_METADATA_KEY = 'io.sciforge/computer-use-invocation'

type ComputerUseToolResult = CallToolResult & {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: true
}

type ComputerUseServiceConfig = {
  serviceUrl: string
  serviceToken: string
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 600_000

export type StartComputerUseMcpServerOptions = {
  transport?: Transport
  env?: NodeJS.ProcessEnv
}

export async function runComputerUseMcpServerFromArgv(
  argv: string[],
  options: StartComputerUseMcpServerOptions = {}
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
  config: ComputerUseServiceConfig | null = resolveComputerUseServiceConfig()
): McpServer {
  const server = new McpServer(
    { name: GUI_COMPUTER_USE_MCP_SERVER_NAME, version: '0.1.0' },
    { capabilities: { logging: {} } }
  )
  if (!config) return server

  server.registerTool(COMPUTER_USE_MCP_TOOL_NAME, {
    description: [
      'Control the user\'s real desktop through the host-approved GUI-Owl worker.',
      'Backend: Legacy/PyAutoGUI. Isolation: host-approved. Lease: process-global.',
      'Provide one natural-language instruction. Host input is process-global and cannot overlap.',
      'Returns a ServiceResult trace; the caller must verify task completion.'
    ].join(' '),
    inputSchema: computerUseV1InputSchema,
    annotations: {
      title: 'Computer use',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async (args, extra) => {
    const parsed = computerUseV1InputSchema.safeParse(args)
    if (!parsed.success) return errorToolResult('INVALID_ARGUMENT', 'instruction is required')
    const trusted = parseTrustedInvocation(extra._meta)
    if (!trusted) {
      return errorToolResult(
        'APPROVAL_PROOF_REQUIRED',
        'Computer Use requires one trusted, confirmed Host invocation.'
      )
    }
    return callComputerUseService(config, parsed.data.instruction, trusted, extra.signal)
  })
  return server
}

export function resolveComputerUseServiceConfig(
  env: NodeJS.ProcessEnv = process.env
): ComputerUseServiceConfig | null {
  const serviceUrl = (env.SCIFORGE_CUA_SERVICE_URL ?? '').trim().replace(/\/+$/, '')
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(serviceUrl)) return null
  const timeout = Number(env.SCIFORGE_CUA_SERVICE_TIMEOUT_MS)
  return {
    serviceUrl,
    serviceToken: (env.SCIFORGE_CUA_SERVICE_TOKEN ?? env.CUA_SERVICE_TOKEN ?? '').trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS
  }
}

type TrustedInvocation = Readonly<{
  requestId: string
  runtimeId: string
  threadId: string
  actionId: string
  invocationId: string
  approval: 'confirmation'
}>

function parseTrustedInvocation(meta: Record<string, unknown> | undefined): TrustedInvocation | null {
  const value = meta?.[TRUSTED_INVOCATION_METADATA_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.approval !== 'confirmation') return null
  const requestId = stringId(record.requestId)
  const runtimeId = stringId(record.runtimeId)
  const threadId = stringId(record.threadId)
  const actionId = stringId(record.actionId)
  const invocationId = stringId(record.invocationId)
  if (!requestId || !runtimeId || !threadId || !actionId || !invocationId) return null
  return { requestId, runtimeId, threadId, actionId, invocationId, approval: 'confirmation' }
}

function stringId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
    ? value
    : ''
}

async function callComputerUseService(
  config: ComputerUseServiceConfig,
  instruction: string,
  trusted: TrustedInvocation,
  signal: AbortSignal
): Promise<ComputerUseToolResult> {
  const requestId = trusted.requestId
  const controller = new AbortController()
  const unlink = linkAbortSignal(signal, controller)
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  const cancel = (): void => {
    void fetch(`${config.serviceUrl}/computer-use/cancel`, {
      method: 'POST',
      headers: jsonHeaders(config.serviceToken),
      body: JSON.stringify({ requestId }),
      redirect: 'error'
    }).catch(() => undefined)
  }
  controller.signal.addEventListener('abort', cancel, { once: true })
  try {
    const response = await fetch(`${config.serviceUrl}/computer-use/run`, {
      method: 'POST',
      headers: jsonHeaders(config.serviceToken),
      body: JSON.stringify({
        instruction,
        execute: true,
        approve: true,
        requestId,
        invocation: trusted
      }),
      signal: controller.signal,
      redirect: 'error'
    })
    const payload = await response.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return errorToolResult('BAD_RESPONSE', `computer-use service returned non-JSON (HTTP ${response.status})`)
    }
    const record = payload as Record<string, unknown>
    const summary = sidecarResultSummary(record, response.status, response.ok)
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: record,
      ...(record.ok === false || !response.ok ? { isError: true as const } : {})
    }
  } catch (error) {
    return errorToolResult(
      'UNAVAILABLE',
      controller.signal.aborted
        ? 'computer-use call timed out or was cancelled'
        : `computer-use call failed: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    clearTimeout(timeout)
    controller.signal.removeEventListener('abort', cancel)
    unlink()
  }
}

function sidecarResultSummary(
  record: Record<string, unknown>,
  status: number,
  responseOk: boolean
): string {
  if (typeof record.summary === 'string' && record.summary.trim()) return record.summary
  if (record.ok === false && record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>
    const code = typeof error.code === 'string' && error.code.trim() ? error.code : 'UNKNOWN'
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message
      : 'computer-use failed'
    return `${code}: ${message}`
  }
  return responseOk ? 'computer-use run completed' : `computer-use failed (HTTP ${status})`
}

function jsonHeaders(serviceToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {})
  }
}

function linkAbortSignal(signal: AbortSignal, controller: AbortController): () => void {
  if (signal.aborted) {
    controller.abort(signal.reason)
    return () => undefined
  }
  const abort = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

function errorToolResult(code: string, message: string): ComputerUseToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { ok: false, error: { code, message } },
    isError: true
  }
}
