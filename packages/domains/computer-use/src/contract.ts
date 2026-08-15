import { z } from 'zod'

/** Stable compatibility input for callers that do not bind a target session. */
export const computerUseV1InputSchema = z.object({
  instruction: z.string().trim().min(1).max(16_384)
}).strict()

export type ComputerUseV1Input = z.infer<typeof computerUseV1InputSchema>

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)

const computerUseParallelEntrySchema = z.object({
  instruction: z.string().trim().min(1).max(16_384),
  computerUseSessionId: safeId,
  deadlineMs: z.number().int().min(1).max(600_000).optional()
}).strict()

export const computerUseRunInputSchema = z.object({
  instruction: z.string().trim().min(1).max(16_384).optional(),
  computerUseSessionId: safeId.optional(),
  deadlineMs: z.number().int().min(1).max(600_000).optional(),
  parallel: z.array(computerUseParallelEntrySchema).min(2).max(8).optional()
}).strict().superRefine((input, context) => {
  if (input.parallel) {
    if (input.instruction !== undefined || input.computerUseSessionId !== undefined || input.deadlineMs !== undefined) {
      context.addIssue({ code: 'custom', message: 'parallel entries own instruction, session and deadline fields' })
    }
    const sessions = new Set<string>()
    input.parallel.forEach((entry, index) => {
      if (sessions.has(entry.computerUseSessionId)) {
        context.addIssue({
          code: 'custom', path: ['parallel', index, 'computerUseSessionId'],
          message: 'parallel computerUseSessionId values must be unique'
        })
      }
      sessions.add(entry.computerUseSessionId)
    })
    return
  }
  if (input.instruction === undefined) {
    context.addIssue({ code: 'custom', path: ['instruction'], message: 'instruction is required' })
  }
})

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
  activeRequests: z.number().int().nonnegative(),
  cleanupPending: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  activeLeases: z.number().int().nonnegative(),
  waiters: z.number().int().nonnegative(),
  backendHandles: z.number().int().nonnegative(),
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
