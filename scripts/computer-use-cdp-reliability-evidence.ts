import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type JsonRecord = Record<string, unknown>
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const SECRET_KEY = /(?:authorization|api.?key|token|secret|password|cookie|localStorage|sessionStorage|cdpEndpoint|imageBase64|imagePath)/iu
const SENSITIVE_VALUE = /(?:\b(?:https?|wss?|file):\/\/|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+|(?:^|[\s=])(?:[A-Za-z]:\\|\\\\)|(?:^|[\s=])\/(?:Users|home|tmp)\/)/iu
const RESOURCE_NAMES = [
  'sessions', 'requests', 'activeLeases', 'activeChannels',
  'activeRequests', 'cleanupPending', 'waiters', 'backendHandles'
] as const

export type ReliabilityEvidenceBundle = Readonly<{
  evidence: JsonRecord
  evidenceJson: string
  manifest: JsonRecord
  manifestJson: string
}>

export function buildReliabilityEvidenceBundle(input: unknown): ReliabilityEvidenceBundle {
  const capture = record(input, 'capture')
  const runId = safeId(capture.runId, 'runId')
  const capturedAt = timestampString(capture.capturedAt, 'capturedAt')
  const source = sourceMetadata(capture.source)
  const batchEnvelope = record(capture.batch, 'batch')
  if (batchEnvelope.ok !== true) throw new Error('batch must be an ok service envelope')
  const batch = record(batchEnvelope.data, 'batch.data')
  const rawChildren = array(batch.results, 'batch.data.results').map((value, index) => (
    record(value, `batch.data.results[${index}]`)
  ))
  if (rawChildren.length < 2 || rawChildren.length > 8) {
    throw new Error('batch results must contain between 2 and 8 children')
  }
  const children = rawChildren.map(childEvidence)
  requireUnique(children.map((child) => String(child.computerUseSessionId)), 'session')
  requireUnique(children.map((child) => String(child.targetId)), 'target')
  requireUnique(children.map((child) => String(child.requestId)), 'request')
  const successCount = children.filter((child) => child.ok === true).length
  const failureCount = children.length - successCount
  assertCount(batch.requestedCount, children.length, 'batch.requestedCount')
  assertCount(batch.successCount, successCount, 'batch.successCount')
  assertCount(batch.failureCount, failureCount, 'batch.failureCount')
  const actionOverlapMs = commonVerifiedActionOverlap(children)
  if (actionOverlapMs <= 0) throw new Error('at least two verified action intervals must overlap')
  const concurrencyEvidence = serviceConcurrencyEvidence(batch.concurrencyEvidence, children.length)

  const releases = array(capture.releases, 'releases').map((value, index) => {
    const release = record(value, `releases[${index}]`)
    const result = record(release.result, `releases[${index}].result`)
    if (result.ok !== true) throw new Error(`releases[${index}] did not succeed`)
    const data = record(result.data, `releases[${index}].result.data`)
    if (data.status !== 'closed') throw new Error(`releases[${index}] did not close its session`)
    return {
      computerUseSessionId: safeId(data.computerUseSessionId, `releases[${index}].sessionId`),
      targetId: safeId(release.targetId, `releases[${index}].targetId`),
      status: 'closed'
    }
  })
  if (releases.length !== children.length) {
    throw new Error('releases must contain exactly one successful close per child')
  }
  requireUnique(releases.map((release) => release.computerUseSessionId), 'release session')
  for (const child of children) {
    const release = releases.find((item) => item.computerUseSessionId === child.computerUseSessionId)
    if (!release || release.targetId !== child.targetId) {
      throw new Error(`release target does not match child ${String(child.computerUseSessionId)}`)
    }
  }

  const finalEnvelope = record(capture.finalStatus, 'finalStatus')
  const finalStatus = finalEnvelope.ok === true ? record(finalEnvelope.data, 'finalStatus.data') : finalEnvelope
  const finalResources = Object.fromEntries(RESOURCE_NAMES.map((name) => {
    const value = nonnegativeInteger(finalStatus[name], `finalStatus.${name}`)
    if (value !== 0) throw new Error(`active resource ${name} must be zero, received ${value}`)
    return [name, value]
  }))
  const provenance = record(
    batchEnvelope.provenance ?? { requestId: capture.parentRequestId }, 'batch.provenance'
  )
  const evidence = sanitize({
    schemaVersion: 1,
    runId,
    capturedAt,
    source,
    scope: {
      backend: 'browser-cdp', targetKind: 'browser-page', testOwnedBrowser: true,
      realProductSmoke: false, electronWebContents: 'not-tested', frameTargets: 'not-tested',
      windowsDesktopIsolation: 'not-tested'
    },
    batch: {
      requestId: safeId(provenance.requestId, 'batch.provenance.requestId'),
      requestedCount: children.length, successCount, failureCount, actionOverlapMs,
      concurrencyEvidence
    },
    children,
    releases,
    finalResources
  }) as JsonRecord
  const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`
  const evidenceName = 'computer-use-cdp-reliability-evidence.json'
  const digest = createHash('sha256').update(evidenceJson, 'utf8').digest('hex')
  const manifest = {
    schemaVersion: 1,
    algorithm: 'sha256',
    files: [{ path: evidenceName, bytes: Buffer.byteLength(evidenceJson), sha256: digest }]
  }
  return {
    evidence,
    evidenceJson,
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`
  }
}

export async function writeReliabilityEvidenceBundle(input: unknown, outputDir: string): Promise<void> {
  const bundle = buildReliabilityEvidenceBundle(input)
  await mkdir(outputDir, { recursive: true })
  await writeFile(resolve(outputDir, 'computer-use-cdp-reliability-evidence.json'), bundle.evidenceJson, 'utf8')
  await writeFile(resolve(outputDir, 'computer-use-cdp-reliability-sha256.json'), bundle.manifestJson, 'utf8')
}

function childEvidence(value: unknown, index: number): JsonRecord {
  const child = record(value, `batch.data.results[${index}]`)
  const prefix = `batch.data.results[${index}]`
  const result = record(child.result, `${prefix}.result`)
  const ok = result.ok === true
  const error = ok ? undefined : record(result.error, `${prefix}.result.error`)
  const data = ok ? record(result.data, `${prefix}.result.data`) : optionalRecord(error?.details) ?? {}
  const steps = Array.isArray(data.steps) ? data.steps.filter(isRecord) : []
  const actionSpans = steps.flatMap((step) => {
    if (step.executed !== true) return []
    const timeline = optionalRecord(step.timeline)
    const verification = optionalRecord(step.verification)
    if (!timeline || !verification) return []
    return [{
      step: nonnegativeInteger(step.step, `${prefix}.step`),
      startedAt: timestampString(timeline.actionStartedAt, `${prefix}.actionStartedAt`),
      completedAt: timestampString(timeline.actionCompletedAt, `${prefix}.actionCompletedAt`),
      verification: verification.status
    }]
  })
  if (ok) {
    if (data.backend !== 'browser-cdp') throw new Error(`${prefix} backend must be browser-cdp`)
    if (data.requestedIsolation !== 'host-app-scoped' ||
        data.effectiveIsolation !== 'host-app-scoped' || data.degraded !== false) {
      throw new Error(`${prefix} isolation must be non-degraded host-app-scoped`)
    }
    if (!actionSpans.some((span) => span.verification === 'verified')) {
      throw new Error(`${prefix} must contain a backend-verified action span`)
    }
    const finalObservation = record(data.finalObservation, `${prefix}.finalObservation`)
    requiredString(finalObservation.revision, `${prefix}.finalObservation.revision`)
    if (array(finalObservation.semanticTree, `${prefix}.finalObservation.semanticTree`).length === 0) {
      throw new Error(`${prefix} final semanticTree must not be empty`)
    }
  }
  return sanitize({
    computerUseSessionId: safeId(child.computerUseSessionId, `${prefix}.computerUseSessionId`),
    targetId: safeId(child.targetId, `${prefix}.targetId`),
    requestId: safeId(child.requestId, `${prefix}.requestId`),
    startedAt: timestampString(child.startedAt, `${prefix}.startedAt`),
    completedAt: timestampString(child.completedAt, `${prefix}.completedAt`),
    ok,
    backend: data.backend,
    requestedIsolation: data.requestedIsolation,
    effectiveIsolation: data.effectiveIsolation,
    degraded: data.degraded,
    status: data.status,
    actionSpans,
    finalObservation: data.finalObservation,
    ...(error ? { error: { code: safeId(error.code, `${prefix}.error.code`), retryable: error.retryable === true } } : {})
  }) as JsonRecord
}

function commonVerifiedActionOverlap(children: JsonRecord[]): number {
  const intervals = children.flatMap((child) => {
    if (child.ok !== true) return []
    const spans = array(child.actionSpans, 'child.actionSpans')
      .map((span) => record(span, 'child.actionSpan'))
      .filter((span) => span.verification === 'verified')
    if (spans.length === 0) return []
    return [[Date.parse(String(spans[0].startedAt)), Date.parse(String(spans[0].completedAt))] as const]
  })
  if (intervals.length < 2) throw new Error('evidence requires at least two successful verified children')
  return Math.max(
    0,
    Math.min(...intervals.map(([, end]) => end)) - Math.max(...intervals.map(([start]) => start))
  )
}

function serviceConcurrencyEvidence(value: unknown, childCount: number): JsonRecord {
  const evidence = record(value, 'batch.data.concurrencyEvidence')
  const maximum = nonnegativeInteger(
    evidence.maxConcurrentExecutions, 'batch.data.concurrencyEvidence.maxConcurrentExecutions'
  )
  const commonMs = nonnegativeNumber(
    evidence.commonExecutionOverlapMs, 'batch.data.concurrencyEvidence.commonExecutionOverlapMs'
  )
  if (maximum < 2 || maximum > childCount || commonMs <= 0) {
    throw new Error('batch concurrency evidence must describe bounded overlapping execution')
  }
  return { commonExecutionOverlapMs: commonMs, maxConcurrentExecutions: maximum }
}

function sourceMetadata(value: unknown): JsonRecord {
  const source = record(value, 'source')
  const commit = requiredString(source.commit, 'source.commit').toLowerCase()
  if (!COMMIT.test(commit)) throw new Error('source.commit must be a full lowercase Git SHA')
  const browser = record(source.browser, 'source.browser')
  if (browser.testOwned !== true || browser.headless !== true) {
    throw new Error('source browser must be test-owned and headless')
  }
  return {
    commit,
    platform: requiredString(source.platform, 'source.platform'),
    arch: requiredString(source.arch, 'source.arch'),
    nodeVersion: requiredString(source.nodeVersion, 'source.nodeVersion'),
    pythonVersion: requiredString(source.pythonVersion, 'source.pythonVersion'),
    browser: {
      name: requiredString(browser.name, 'source.browser.name'),
      version: requiredString(browser.version, 'source.browser.version'),
      testOwned: true,
      headless: true
    }
  }
}

export function sanitize(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '<redacted>'
  if (typeof value === 'string') {
    return SENSITIVE_VALUE.test(value) ? '<redacted-sensitive-value>' : value.slice(0, 8_192)
  }
  if (Array.isArray(value)) return value.slice(0, 512).map((item) => sanitize(item))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => (
      [childKey, sanitize(child, childKey)]
    )))
  }
  return value
}

function record(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${name} must be an object`)
  return value
}
function optionalRecord(value: unknown): JsonRecord | undefined { return isRecord(value) ? value : undefined }
function isRecord(value: unknown): value is JsonRecord { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}
function safeId(value: unknown, name: string): string {
  const id = requiredString(value, name)
  if (!SAFE_ID.test(id)) throw new Error(`${name} must be a safe identifier`)
  return id
}
function timestampString(value: unknown, name: string): string {
  const text = requiredString(value, name)
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${name} must be an ISO timestamp`)
  return text
}
function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${name} must be a nonnegative integer`)
  return Number(value)
}
function nonnegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative finite number`)
  }
  return value
}
function assertCount(value: unknown, expected: number, name: string): void {
  if (nonnegativeInteger(value, name) !== expected) throw new Error(`${name} does not match results`)
}
function requireUnique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} values must be unique`)
}

function options(argv: string[]): { input: string; outputDir: string } {
  const parsed = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error('Expected --input and --output-dir arguments')
    parsed.set(key, value)
  }
  const input = parsed.get('--input')
  const outputDir = parsed.get('--output-dir')
  if (!input || !outputDir) throw new Error('--input and --output-dir are required')
  return { input: resolve(input), outputDir: resolve(outputDir) }
}

async function main(): Promise<void> {
  const parsed = options(process.argv.slice(2))
  const capture = JSON.parse(await readFile(parsed.input, 'utf8')) as unknown
  await writeReliabilityEvidenceBundle(capture, parsed.outputDir)
  process.stdout.write('Wrote sanitized Computer Use CDP reliability evidence and SHA256 manifest.\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
