import { describe, expect, it } from 'vitest'
import { computerUseV1InputSchema } from './contract'

describe('Computer Use v1 contract', () => {
  it('preserves the one-instruction schema and rejects unconsumed fields', () => {
    expect(computerUseV1InputSchema.parse({ instruction: ' open Settings ' })).toEqual({
      instruction: 'open Settings'
    })
    expect(computerUseV1InputSchema.safeParse({ instruction: 'x', targetId: 'unused' }).success)
      .toBe(false)
  })
})
