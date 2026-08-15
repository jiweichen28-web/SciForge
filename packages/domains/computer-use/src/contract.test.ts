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
})
