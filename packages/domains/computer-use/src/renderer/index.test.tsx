import { describe, expect, it } from 'vitest'
import { domainPackageDefinition } from '../definition'
import { createDomainRendererEntry } from './index'

describe('Computer Use renderer domain entry', () => {
  it('contributes its settings surface through the generic renderer contract', () => {
    const entry = createDomainRendererEntry({ capabilityInvoker: {} } as never)
    expect(entry.definition).toStrictEqual(domainPackageDefinition)
    expect(entry.contributions).toHaveLength(1)
    expect(entry.contributions[0]).toMatchObject({
      kind: 'renderer.settings-section',
      id: 'computer-use.settings-section',
      contract: domainPackageDefinition.contributionContracts['computer-use.settings-section'],
      value: { section: 'agents.permissions', order: 180 }
    })
    const contribution = entry.contributions[0]?.value as { render(context: unknown): unknown }
    expect(contribution.render({ host: {} })).toBeTruthy()
  })
})
