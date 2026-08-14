import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildReliabilityEvidenceBundle,
  writeReliabilityEvidenceBundle
} from './computer-use-cdp-reliability-evidence'

function successfulChild(label: string, start: string, end: string) {
  return {
    computerUseSessionId: `session-${label}`,
    targetId: `cdp:target-${label}`,
    requestId: `request-${label}`,
    startedAt: '2026-08-15T00:00:00.000Z',
    completedAt: '2026-08-15T00:00:01.000Z',
    result: {
      ok: true,
      data: {
        status: 'agent_reported_done', backend: 'browser-cdp',
        requestedIsolation: 'host-app-scoped', effectiveIsolation: 'host-app-scoped',
        degraded: false,
        steps: [{
          step: 0, executed: true,
          verification: { status: 'verified', details: { url: 'http://127.0.0.1/private' } },
          timeline: { actionStartedAt: start, actionCompletedAt: end }
        }],
        finalObservation: {
          revision: 'cdp:3',
          semanticTree: [
            { role: 'status', name: `${label.toUpperCase()}_COMMITTED` },
            { role: 'link', name: 'http://127.0.0.1/private' },
            { role: 'note', name: 'artifact=E:\\private\\capture.png' },
            { role: 'note', name: 'file:///C:/private/capture.png' }
          ]
        }
      }
    }
  }
}

function capture() {
  const children = [
    successfulChild('alpha', '2026-08-15T00:00:00.100Z', '2026-08-15T00:00:00.500Z'),
    successfulChild('beta', '2026-08-15T00:00:00.200Z', '2026-08-15T00:00:00.600Z'),
    {
      computerUseSessionId: 'session-lost', targetId: 'cdp:target-lost',
      requestId: 'request-lost', startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:00:00.300Z',
      result: { ok: false, error: { code: 'TARGET_LOST', message: 'target closed' } }
    }
  ]
  return {
    runId: 'reliability-run-1',
    capturedAt: '2026-08-15T00:01:00.000Z',
    source: {
      commit: '7a6da908b2163f13ebdb3688a70972330934c97a',
      platform: 'win32', arch: 'x64', nodeVersion: 'v22.17.0', pythonVersion: '3.12.8',
      browser: { name: 'Microsoft Edge', version: '140.0.0.0', testOwned: true, headless: true }
    },
    batch: {
      ok: true,
      data: {
        requestedCount: 3, successCount: 2, failureCount: 1, results: children,
        concurrencyEvidence: { commonExecutionOverlapMs: 300, maxConcurrentExecutions: 3 }
      },
      provenance: { requestId: 'parent-batch-1' }
    },
    releases: children.map((child) => ({
      targetId: child.targetId,
      result: { ok: true, data: { computerUseSessionId: child.computerUseSessionId, status: 'closed' } }
    })),
    finalStatus: {
      sessions: 0, requests: 0, activeLeases: 0, activeChannels: 0,
      activeRequests: 0, cleanupPending: 0, waiters: 0, backendHandles: 0
    },
    apiKey: 'must-not-survive'
  }
}

describe('Computer Use CDP reliability evidence', () => {
  it('is deterministic, sanitized, resource-zero and hash-addressed', () => {
    const first = buildReliabilityEvidenceBundle(capture())
    const second = buildReliabilityEvidenceBundle(capture())
    assert.equal(first.evidenceJson, second.evidenceJson)
    assert.equal(first.manifestJson, second.manifestJson)
    assert.equal((first.evidence.batch as Record<string, unknown>).actionOverlapMs, 300)
    assert.deepEqual(first.evidence.finalResources, {
      sessions: 0, requests: 0, activeLeases: 0, activeChannels: 0,
      activeRequests: 0, cleanupPending: 0, waiters: 0, backendHandles: 0
    })
    assert.match(first.evidenceJson, /<redacted-sensitive-value>/u)
    assert.doesNotMatch(first.evidenceJson, /127\.0\.0\.1\/private/u)
    assert.doesNotMatch(first.evidenceJson, /private[\\/]capture/u)
    const file = (first.manifest.files as Array<Record<string, unknown>>)[0]
    assert.equal(file.sha256, createHash('sha256').update(first.evidenceJson).digest('hex'))
  })

  it('fails closed on residue, serialization, unverified success, or incomplete release', () => {
    const residue = capture()
    residue.finalStatus.backendHandles = 1
    assert.throws(() => buildReliabilityEvidenceBundle(residue), /backendHandles must be zero/u)
    const serialized = capture()
    serialized.batch.data.results[1] = successfulChild(
      'beta', '2026-08-15T00:00:00.600Z', '2026-08-15T00:00:00.900Z'
    )
    assert.throws(() => buildReliabilityEvidenceBundle(serialized), /must overlap/u)
    const falseConcurrency = capture()
    falseConcurrency.batch.data.concurrencyEvidence.maxConcurrentExecutions = 1
    assert.throws(() => buildReliabilityEvidenceBundle(falseConcurrency), /bounded overlapping/u)
    const unverified = capture()
    unverified.batch.data.results[0].result.data.steps[0].verification.status = 'unverified'
    assert.throws(() => buildReliabilityEvidenceBundle(unverified), /backend-verified/u)
    const wrongRequestedIsolation = capture()
    wrongRequestedIsolation.batch.data.results[0].result.data.requestedIsolation = 'auto'
    assert.throws(() => buildReliabilityEvidenceBundle(wrongRequestedIsolation), /isolation/u)
    const incomplete = capture()
    incomplete.releases.pop()
    assert.throws(() => buildReliabilityEvidenceBundle(incomplete), /exactly one/u)
  })

  it('writes evidence and its matching manifest without retaining raw capture', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sciforge-pr4-evidence-'))
    try {
      await writeReliabilityEvidenceBundle(capture(), directory)
      const evidence = await readFile(join(directory, 'computer-use-cdp-reliability-evidence.json'), 'utf8')
      const manifest = JSON.parse(await readFile(
        join(directory, 'computer-use-cdp-reliability-sha256.json'), 'utf8'
      )) as { files: Array<{ sha256: string }> }
      assert.equal(manifest.files[0].sha256, createHash('sha256').update(evidence).digest('hex'))
      assert.doesNotMatch(evidence, /must-not-survive/u)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
