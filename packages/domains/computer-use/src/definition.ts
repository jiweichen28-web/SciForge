import {
  defineTrustedDomainPackage,
  type TrustedDomainPackageDefinition,
  type TrustedDomainPackageDefinitionInput
} from '@sciforge/domain-sdk/contract'
import manifest from '../sciforge.domain.json' with { type: 'json' }

export const domainPackageDefinition: TrustedDomainPackageDefinition =
  defineTrustedDomainPackage(manifest as TrustedDomainPackageDefinitionInput)

export const COMPUTER_USE_DOMAIN_MODULE_ID = domainPackageDefinition.module.id
export const COMPUTER_USE_CAPABILITY_FACTORY_CONTRIBUTION = contributionFor(
  'main.capability-factory'
)
export const COMPUTER_USE_RUNTIME_MCP_SERVER_CONTRIBUTION = contributionFor(
  'main.runtime-mcp-server'
)
export const COMPUTER_USE_TRUSTED_METADATA_CONTRIBUTION = contributionFor(
  'main.mcp-trusted-invocation-metadata'
)
export const COMPUTER_USE_RENDERER_SETTINGS_CONTRIBUTION = contributionFor(
  'renderer.settings-section',
  'renderer'
)
export const COMPUTER_USE_RENDERER_SETTINGS_CONTRACT =
  domainPackageDefinition.contributionContracts[
    COMPUTER_USE_RENDERER_SETTINGS_CONTRIBUTION.id
  ]!

function contributionFor(kind: string, process: 'main' | 'renderer' = 'main') {
  const contribution = domainPackageDefinition.entrypoints
    .find((entrypoint) => entrypoint.process === process)
    ?.contributions.find((candidate) => candidate.kind === kind)
  if (!contribution) throw new Error(`Computer Use manifest is missing main:${kind}.`)
  return contribution
}
