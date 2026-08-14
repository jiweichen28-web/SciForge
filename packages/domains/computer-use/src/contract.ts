import { z } from 'zod'

/** Stable external v1 MCP input. PR2 deliberately adds no target/session fields. */
export const computerUseV1InputSchema = z.object({
  instruction: z.string().trim().min(1).max(16_384)
}).strict()

export type ComputerUseV1Input = z.infer<typeof computerUseV1InputSchema>

export const computerUseSettingsSchema = z.object({
  enabled: z.boolean(),
  runtimeEnabled: z.object({
    sciforge: z.boolean(),
    codex: z.boolean(),
    claude: z.boolean()
  }).strict()
}).strict()

export const computerUsePermissionsSchema = z.object({
  platform: z.string(),
  supported: z.boolean(),
  needsPermission: z.boolean(),
  accessibility: z.enum(['granted', 'denied', 'unknown']),
  screenRecording: z.enum(['granted', 'denied', 'unknown']),
  accessibilityNeedsRestart: z.boolean()
}).strict()

export const computerUseRuntimeStatusSchema = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  backend: z.literal('legacy-pyautogui'),
  effectiveIsolation: z.literal('host-approved'),
  leaseScope: z.literal('process-global'),
  activeChannels: z.number().int().nonnegative(),
  cleanupPending: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  activeLeases: z.number().int().nonnegative(),
  reason: z.string().nullable()
}).strict()

export const computerUseSettingsStatusInputSchema = z.object({
  settings: computerUseSettingsSchema
}).strict()
export const computerUseSettingsStatusOutputSchema = z.object({
  settings: computerUseSettingsSchema,
  permissions: computerUsePermissionsSchema,
  runtime: computerUseRuntimeStatusSchema
}).strict()
export const computerUsePermissionRequestInputSchema = z.object({
  kind: z.enum(['accessibility', 'screenRecording'])
}).strict()

export const COMPUTER_USE_CAPABILITY_IDS = Object.freeze({
  status: 'computer-use.status',
  requestPermission: 'computer-use.request-permission'
})

export const COMPUTER_USE_STATUS_CONTRACT = Object.freeze({
  actionId: COMPUTER_USE_CAPABILITY_IDS.status,
  effect: 'read' as const,
  inputSchema: computerUseSettingsStatusInputSchema,
  outputSchema: computerUseSettingsStatusOutputSchema
})

export const COMPUTER_USE_REQUEST_PERMISSION_CONTRACT = Object.freeze({
  actionId: COMPUTER_USE_CAPABILITY_IDS.requestPermission,
  effect: 'external-write' as const,
  inputSchema: computerUsePermissionRequestInputSchema,
  outputSchema: computerUsePermissionsSchema
})
