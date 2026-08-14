import type {
  DomainMainHost,
  DomainMainRuntimeLifecycleContribution,
  DomainMainRuntimeMcpServerContribution,
  DomainMcpTrustedInvocationMetadataContribution
} from '@sciforge/domain-sdk/host'
import {
  defineTrustedMainDomainPackageEntry,
  type TrustedMainDomainPackageEntry
} from '@sciforge/domain-sdk/main'
import type { z } from 'zod'
import {
  COMPUTER_USE_CAPABILITY_IDS,
  computerUsePermissionRequestInputSchema,
  computerUsePermissionsSchema,
  computerUseRuntimeStatusSchema,
  computerUseSettingsStatusInputSchema,
  computerUseSettingsStatusOutputSchema
} from './contract.js'
import {
  COMPUTER_USE_CAPABILITY_FACTORY_CONTRIBUTION,
  COMPUTER_USE_DOMAIN_MODULE_ID,
  COMPUTER_USE_RUNTIME_LIFECYCLE_CONTRIBUTION,
  COMPUTER_USE_RUNTIME_MCP_SERVER_CONTRIBUTION,
  COMPUTER_USE_TRUSTED_METADATA_CONTRIBUTION,
  domainPackageDefinition
} from './definition.js'
import {
  COMPUTER_USE_MCP_TIMEOUT_MS,
  COMPUTER_USE_MCP_TOOL_NAME,
  COMPUTER_USE_BIND_TARGET_TOOL_NAME,
  COMPUTER_USE_RELEASE_SESSION_TOOL_NAME,
  GUI_COMPUTER_USE_MCP_SERVER_NAME,
  buildComputerUseMcpArgs,
  computerUseMcpEnabledTools,
  computerUseMcpEnv,
  isComputerUseMcpConfigured,
  resolveComputerUseMcpCommand,
  type AppSettingsLike,
  type ComputerUseMcpLaunchConfig
} from './main/mcp-config.js'
import {
  startComputerUseAdapterRuntime,
  type ComputerUseAdapterRuntime
} from './main/services/computer-use-adapter-runtime.js'
import {
  startComputerUseAgentModelBridge,
  type ComputerUseAgentModelBridge
} from './main/services/computer-use-agent-model-bridge.js'
import {
  getComputerUsePermissions,
  requestComputerUsePermission
} from './main/services/computer-use-permissions.js'

type CapabilityOptions = Readonly<{
  id: string
  version: string
  title: string
  description: string
  audiences: readonly ('ui' | 'agent' | 'system')[]
  scope: 'global'
  effect: 'read' | 'external-write'
  approval: 'none' | 'confirmation'
  concurrency: Readonly<{ revision: 'none'; idempotency: 'none' | 'required' }>
  tags: readonly string[]
  inputSchema: z.ZodType
  outputSchema: z.ZodType
  handler: (input: any) => Promise<{ output: unknown }>
}>

export type ComputerUseCapabilityFactory<Definition = unknown> = Readonly<{
  moduleId: typeof COMPUTER_USE_DOMAIN_MODULE_ID
  policy: Readonly<{
    id: 'computer-use'
    title: 'Computer Use'
    directTransportPrefixes: readonly []
    allowedDirectTransports: readonly []
  }>
  createDefinitions: () => readonly Definition[]
}>

export function createDomainMainEntry(
  host: DomainMainHost
): TrustedMainDomainPackageEntry<unknown> {
  const launch: ComputerUseMcpLaunchConfig = {
    appPath: host.getAppRoot?.() ?? process.cwd(),
    execPath: host.getExecutablePath?.() ?? process.execPath,
    isPackaged: host.isPackaged?.() ?? false
  }
  let adapterRuntime: ComputerUseAdapterRuntime | null = null
  let modelBridge: ComputerUseAgentModelBridge | null = null
  const runtimeMcpServer: DomainMainRuntimeMcpServerContribution = Object.freeze({
    serverId: GUI_COMPUTER_USE_MCP_SERVER_NAME,
    createConfig: (settings: unknown) => {
      const appSettings = settings as AppSettingsLike
      if (
        !isComputerUseMcpConfigured(appSettings, 'codex') &&
        !isComputerUseMcpConfigured(appSettings, 'claude')
      ) return null
      return {
        id: GUI_COMPUTER_USE_MCP_SERVER_NAME,
        command: resolveComputerUseMcpCommand(launch),
        args: buildComputerUseMcpArgs(launch),
        env: computerUseMcpEnv(),
        timeoutMs: COMPUTER_USE_MCP_TIMEOUT_MS,
        enabledTools: computerUseMcpEnabledTools()
      }
    },
    isRuntimeEnabled: (settings, runtimeId) =>
      (runtimeId === 'codex' || runtimeId === 'claude') &&
      isComputerUseMcpConfigured(settings as AppSettingsLike, runtimeId)
  })
  const trustedMetadata: DomainMcpTrustedInvocationMetadataContribution = Object.freeze({
    serverId: GUI_COMPUTER_USE_MCP_SERVER_NAME,
    tools: Object.freeze([
      COMPUTER_USE_BIND_TARGET_TOOL_NAME,
      COMPUTER_USE_MCP_TOOL_NAME,
      COMPUTER_USE_RELEASE_SESSION_TOOL_NAME
    ]),
    metadataKey: 'io.sciforge/computer-use-invocation',
    source: 'trusted-invocation'
  })
  const capabilities = createComputerUseCapabilityFactory(
    host.defineCapability as (options: CapabilityOptions) => unknown
  )
  const lifecycle: DomainMainRuntimeLifecycleContribution = Object.freeze({
    activate: async (context) => {
      const serviceUrl = (context.environment.SCIFORGE_CUA_SERVICE_URL ?? '').trim()
      const serviceToken = (
        (context.environment.SCIFORGE_CUA_SERVICE_TOKEN ?? '').trim() ||
        (context.environment.CUA_SERVICE_TOKEN ?? '').trim()
      )
      if (!serviceUrl || !serviceToken) return
      const endpoints = (context.environment.SCIFORGE_CUA_CDP_ENDPOINTS ?? '')
        .split(',').map((value) => value.trim()).filter(Boolean)
      // Keep the compatibility-only Legacy runtime untouched unless an
      // operator explicitly opts into allowlisted target-scoped CDP.
      if (endpoints.length === 0) return
      if (!context.agentExecution) {
        throw new Error('Target-scoped Computer Use requires Host Agent execution.')
      }
      try {
        modelBridge = await startComputerUseAgentModelBridge({
          agentExecution: context.agentExecution,
          workspaceRoot: context.appRoot
        })
        await configureSidecar(serviceUrl, serviceToken, '/computer-use/model-access/configure', {
          baseUrl: modelBridge.baseUrl,
          apiKey: modelBridge.token,
          model: 'sciforge-computer-use-agent'
        }, context.signal)
        adapterRuntime = await startComputerUseAdapterRuntime({
          serviceUrl, serviceToken, browserEndpoints: endpoints, signal: context.signal
        })
      } catch (error) {
        const adapter = adapterRuntime
        adapterRuntime = null
        const bridge = modelBridge
        modelBridge = null
        const cleanupErrors = await cleanupRuntimeResources(
          serviceUrl, serviceToken, adapter, bridge
        )
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            'Computer Use runtime activation failed and cleanup was incomplete.',
            { cause: error }
          )
        }
        throw error
      }
      return async () => {
        const adapter = adapterRuntime
        adapterRuntime = null
        const bridge = modelBridge
        modelBridge = null
        const errors = await cleanupRuntimeResources(serviceUrl, serviceToken, adapter, bridge)
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Computer Use runtime cleanup was incomplete.')
        }
      }
    }
  })
  return defineTrustedMainDomainPackageEntry<unknown>({
    definition: domainPackageDefinition,
    contributions: [
      { ...COMPUTER_USE_CAPABILITY_FACTORY_CONTRIBUTION, value: capabilities },
      { ...COMPUTER_USE_RUNTIME_LIFECYCLE_CONTRIBUTION, value: lifecycle },
      { ...COMPUTER_USE_RUNTIME_MCP_SERVER_CONTRIBUTION, value: runtimeMcpServer },
      { ...COMPUTER_USE_TRUSTED_METADATA_CONTRIBUTION, value: trustedMetadata }
    ]
  })
}

async function cleanupRuntimeResources(
  serviceUrl: string,
  serviceToken: string,
  adapter: ComputerUseAdapterRuntime | null,
  bridge: ComputerUseAgentModelBridge | null
): Promise<unknown[]> {
  const errors: unknown[] = []
  if (adapter) {
    try {
      await adapter.close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (bridge) {
    try {
      await configureSidecar(serviceUrl, serviceToken, '/computer-use/model-access/configure', {
        baseUrl: '', apiKey: '', model: '', expectedBaseUrl: bridge.baseUrl
      })
    } catch (error) {
      errors.push(error)
    }
    try {
      await bridge.close()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

async function configureSidecar(
  serviceUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<void> {
  const base = serviceUrl.trim().replace(/\/+$/, '')
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(base)) {
    throw new Error('Computer Use sidecar must use credential-free loopback HTTP.')
  }
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    ...(signal ? { signal } : {})
  })
  if (!response.ok) throw new Error(`Computer Use sidecar configuration failed (HTTP ${response.status}).`)
}

function createComputerUseCapabilityFactory<Definition>(
  defineCapability: (options: CapabilityOptions) => Definition
): ComputerUseCapabilityFactory<Definition> {
  const define = (options: Omit<CapabilityOptions, 'version' | 'scope' | 'concurrency' | 'tags'>) =>
    defineCapability({
      ...options,
      version: '1.0.0',
      scope: 'global',
      concurrency: {
        revision: 'none',
        idempotency: options.effect === 'read' ? 'none' : 'required'
      },
      tags: ['computer-use']
    })
  return Object.freeze({
    moduleId: COMPUTER_USE_DOMAIN_MODULE_ID,
    policy: Object.freeze({
      id: 'computer-use' as const,
      title: 'Computer Use' as const,
      directTransportPrefixes: Object.freeze([]) as readonly [],
      allowedDirectTransports: Object.freeze([]) as readonly []
    }),
    createDefinitions: () => [
      define({
        id: COMPUTER_USE_CAPABILITY_IDS.status,
        title: 'Read Computer Use status',
        description: 'Reads domain-owned permissions and Computer Use lifecycle status.',
        audiences: ['ui'],
        effect: 'read',
        approval: 'none',
        inputSchema: computerUseSettingsStatusInputSchema,
        outputSchema: computerUseSettingsStatusOutputSchema,
        handler: async (input) => ({
          output: {
            settings: input.settings,
            permissions: await getComputerUsePermissions(),
            runtime: await readComputerUseRuntimeStatus()
          }
        })
      }),
      define({
        id: COMPUTER_USE_CAPABILITY_IDS.requestPermission,
        title: 'Request Computer Use permission',
        description: 'Opens the operating system permission enrollment flow.',
        audiences: ['ui'],
        effect: 'external-write',
        approval: 'confirmation',
        inputSchema: computerUsePermissionRequestInputSchema,
        outputSchema: computerUsePermissionsSchema,
        handler: async (input) => ({
          output: await requestComputerUsePermission(input.kind)
        })
      })
    ]
  })
}

async function readComputerUseRuntimeStatus(): Promise<z.infer<typeof computerUseRuntimeStatusSchema>> {
  const serviceUrl = (process.env.SCIFORGE_CUA_SERVICE_URL ?? '').trim().replace(/\/+$/, '')
  const unavailable = (reason: string) => ({
    configured: Boolean(serviceUrl),
    available: false,
    backend: 'legacy-pyautogui' as const,
    effectiveIsolation: 'host-approved' as const,
    leaseScope: 'process-global' as const,
    activeChannels: 0,
    cleanupPending: 0,
    sessions: 0,
    requests: 0,
    activeLeases: 0,
    reason
  })
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(serviceUrl)) {
    return unavailable('GUI-Owl sidecar is not configured on a trusted loopback URL.')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)
  try {
    const token = (
      process.env.SCIFORGE_CUA_SERVICE_TOKEN ?? process.env.CUA_SERVICE_TOKEN ?? ''
    ).trim()
    const response = await fetch(`${serviceUrl}/computer-use/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
      redirect: 'error'
    })
    const payload = await response.json() as { data?: unknown }
    if (!response.ok) return unavailable(`GUI-Owl status returned HTTP ${response.status}.`)
    return computerUseRuntimeStatusSchema.parse({
      configured: true,
      available: true,
      ...(payload.data as object),
      reason: null
    })
  } catch (error) {
    return unavailable(error instanceof Error && error.name === 'AbortError'
      ? 'GUI-Owl status request timed out.'
      : 'GUI-Owl sidecar status is unavailable.')
  } finally {
    clearTimeout(timeout)
  }
}
