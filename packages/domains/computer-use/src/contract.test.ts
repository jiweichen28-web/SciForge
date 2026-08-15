import { describe, expect, it } from 'vitest'
import {
  computerUseBindTargetInputSchema,
  computerUseRunInputSchema,
  computerUseV1InputSchema
} from './contract'

describe('Computer Use v1 contract', () => {
  it('preserves the one-instruction schema and rejects unconsumed fields', () => {
    expect(computerUseV1InputSchema.parse({ instruction: ' open Settings ' })).toEqual({
      instruction: 'open Settings'
    })
    expect(computerUseV1InputSchema.safeParse({ instruction: 'x', targetId: 'unused' }).success)
      .toBe(false)
  })

  it('adds target fields only where PR3 consumes them', () => {
    expect(computerUseBindTargetInputSchema.parse({ targetId: 'cdp:page-1' })).toEqual({
      targetId: 'cdp:page-1', requestedIsolation: 'host-app-scoped'
    })
    expect(computerUseRunInputSchema.parse({ instruction: 'submit', computerUseSessionId: 'session-1' }))
      .toEqual({ instruction: 'submit', computerUseSessionId: 'session-1' })
    expect(computerUseV1InputSchema.safeParse({ instruction: 'submit', computerUseSessionId: 'session-1' }).success)
      .toBe(false)
  })

  it('accepts a bounded parallel batch with unique bound sessions only', () => {
    expect(computerUseRunInputSchema.parse({
      parallel: [
        { instruction: 'alpha', computerUseSessionId: 'session-a', deadlineMs: 5_000 },
        { instruction: 'beta', computerUseSessionId: 'session-b' }
      ]
    })).toEqual({
      parallel: [
        { instruction: 'alpha', computerUseSessionId: 'session-a', deadlineMs: 5_000 },
        { instruction: 'beta', computerUseSessionId: 'session-b' }
      ]
    })
    expect(computerUseRunInputSchema.safeParse({
      parallel: [
        { instruction: 'alpha', computerUseSessionId: 'session-a' },
        { instruction: 'beta', computerUseSessionId: 'session-a' }
      ]
    }).success).toBe(false)
    expect(computerUseRunInputSchema.safeParse({
      instruction: 'top-level',
      parallel: [
        { instruction: 'alpha', computerUseSessionId: 'session-a' },
        { instruction: 'beta', computerUseSessionId: 'session-b' }
      ]
    }).success).toBe(false)
  })
})
