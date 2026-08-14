import type {
  DomainMainHost,
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
  COMPUTER_USE_RUNTIME_MCP_SERVER_CONTRIBUTION,
  COMPUTER_USE_TRUSTED_METADATA_CONTRIBUTION,
  domainPackageDefinition
} from './definition.js'
import {
  COMPUTER_USE_MCP_TIMEOUT_MS,
  COMPUTER_USE_MCP_TOOL_NAME,
  GUI_COMPUTER_USE_MCP_SERVER_NAME,
  buildComputerUseMcpArgs,
  computerUseMcpEnv,
  isComputerUseMcpConfigured,
  resolveComputerUseMcpCommand,
  type AppSettingsLike,
  type ComputerUseMcpLaunchConfig
} from './main/mcp-config.js'
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
        enabledTools: [COMPUTER_USE_MCP_TOOL_NAME]
      }
    },
    isRuntimeEnabled: (settings, runtimeId) =>
      (runtimeId === 'codex' || runtimeId === 'claude') &&
      isComputerUseMcpConfigured(settings as AppSettingsLike, runtimeId)
  })
  const trustedMetadata: DomainMcpTrustedInvocationMetadataContribution = Object.freeze({
    serverId: GUI_COMPUTER_USE_MCP_SERVER_NAME,
    tools: Object.freeze([COMPUTER_USE_MCP_TOOL_NAME]),
    metadataKey: 'io.sciforge/computer-use-invocation',
    source: 'trusted-invocation'
  })
  const capabilities = createComputerUseCapabilityFactory(
    host.defineCapability as (options: CapabilityOptions) => unknown
  )
  return defineTrustedMainDomainPackageEntry<unknown>({
    definition: domainPackageDefinition,
    contributions: [
      { ...COMPUTER_USE_CAPABILITY_FACTORY_CONTRIBUTION, value: capabilities },
      { ...COMPUTER_USE_RUNTIME_MCP_SERVER_CONTRIBUTION, value: runtimeMcpServer },
      { ...COMPUTER_USE_TRUSTED_METADATA_CONTRIBUTION, value: trustedMetadata }
    ]
  })
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
        description: 'Reads domain-owned permissions and Legacy lifecycle status.',
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
