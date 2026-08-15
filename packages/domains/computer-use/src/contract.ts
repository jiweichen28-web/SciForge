import { z } from 'zod'

/** Stable compatibility input for callers that do not bind a target session. */
export const computerUseV1InputSchema = z.object({
  instruction: z.string().trim().min(1).max(16_384)
}).strict()

export type ComputerUseV1Input = z.infer<typeof computerUseV1InputSchema>

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)

export const computerUseRunInputSchema = z.object({
  instruction: z.string().trim().min(1).max(16_384),
  computerUseSessionId: safeId.optional()
}).strict()

export const computerUseTargetSchema = z.object({
  targetId: safeId,
  kind: z.literal('browser-page'),
  generation: safeId,
  title: z.string().max(512),
  url: z.string().max(4_096)
}).strict()

export const computerUseBindTargetInputSchema = z.object({
  targetId: safeId,
  requestedIsolation: z.literal('host-app-scoped').default('host-app-scoped')
}).strict()

export const computerUseReleaseSessionInputSchema = z.object({
  computerUseSessionId: safeId
}).strict()

export const computerUseEmptyInputSchema = z.object({}).strict()

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
  backend: z.enum(['legacy-pyautogui', 'browser-cdp']),
  effectiveIsolation: z.enum(['host-approved', 'host-app-scoped']),
  leaseScope: z.enum(['process-global', 'target']),
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
