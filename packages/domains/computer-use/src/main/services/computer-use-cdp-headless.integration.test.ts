import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { createPlaywrightCdpDriver, startComputerUseCdpAdapter } from './computer-use-cdp-adapter.js'

const edge = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(existsSync)

describe.skipIf(!edge)('test-owned headless CDP page', () => {
  it('observes, clicks, types, navigates, reads back and never touches its neighbor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sciforge-pr3-cdp-'))
    const app = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const name = url.pathname === '/b' ? 'B' : url.pathname === '/done' ? 'Done' : 'A'
      const body = Buffer.from(name === 'Done'
        ? `<!doctype html><title>Done</title><h1 id="done">DONE:${url.searchParams.get('value') ?? ''}</h1>`
        : `<!doctype html><title>Page ${name}</title><style>input{position:absolute;left:640px;top:60px;width:120px;height:30px}</style><form action="/done"><label>Editor ${name}<input name="value" aria-label="Editor ${name}"></label><button type="submit">Commit ${name}</button><output id="state"></output></form>`)
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length)
      })
      response.end(body)
    })
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
    const appAddress = app.address()
    if (!appAddress || typeof appAddress === 'string') throw new Error('test server did not listen')
    const cdpPort = await freePort()
    const browser = await chromium.launch({
      executablePath: edge,
      headless: true,
      args: [`--remote-debugging-port=${cdpPort}`]
    })
    try {
      const context = await browser.newContext()
      const pageA = await context.newPage()
      const pageB = await context.newPage()
      await Promise.all([
        pageA.setViewportSize({ width: 800, height: 600 }),
        pageB.setViewportSize({ width: 800, height: 600 })
      ])
      await Promise.all([
        pageA.goto(`http://127.0.0.1:${appAddress.port}/a`),
        pageB.goto(`http://127.0.0.1:${appAddress.port}/b`)
      ])
      const endpoint = `http://127.0.0.1:${cdpPort}`
      const adapter = await startComputerUseCdpAdapter({ driver: createPlaywrightCdpDriver([endpoint]) })
      const rawCall = async (path: string, body?: Record<string, unknown>) => {
        const response = await fetch(`${adapter.url}/v1/${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${adapter.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {})
        })
        return await response.json() as {
          ok: boolean
          data?: Record<string, unknown>
          error?: Record<string, unknown>
        }
      }
      const call = async (path: string, body?: Record<string, unknown>) => {
        const payload = await rawCall(path, body)
        expect(payload.ok).toBe(true)
        return payload.data!
      }
      try {
        const listed = await call('targets')
        const targets = listed.targets as Array<{
          targetId: string
          metadata: { title: string }
          [key: string]: unknown
        }>
        const targetA = targets.find((target) => target.metadata.title === 'Page A')
        const targetB = targets.find((target) => target.metadata.title === 'Page B')
        expect(targetA).toBeTruthy()
        expect(targetB).toBeTruthy()
        expect(targetA?.targetId).not.toBe(targetB?.targetId)
        const opened = await call('handles/open', { target: targetA, requestId: 'request-a' })
        const openedB = await call('handles/open', { target: targetB, requestId: 'request-b' })
        const first = await call('observe', { handleId: opened.handleId })
        expect(first).toMatchObject({ targetId: targetA!.targetId, revision: 'cdp:1' })
        const tree = (first.metadata as Record<string, unknown>).semanticTree as Array<Record<string, unknown>>
        const editor = tree.find((node) => node.name === 'Editor A')
        expect(editor?.center).toEqual(expect.any(Array))
        const invalid = await fetch(`${adapter.url}/v1/action`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adapter.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            handleId: opened.handleId,
            expectedRevision: first.revision,
            action: { action: 'click', coordinate: [1001, 100] }
          })
        })
        expect(invalid.status).toBe(409)
        const invalidPayload = await invalid.json() as { error: Record<string, unknown> }
        expect(invalidPayload).toMatchObject({
          ok: false,
          error: { code: 'INVALID_ARGUMENT', safeToRetry: true }
        })
        expect(invalidPayload.error).not.toHaveProperty('mayHaveTakenEffect')
        const stale = await rawCall('action', {
          handleId: opened.handleId,
          expectedRevision: 'cdp:0',
          action: { action: 'click', coordinate: editor!.center }
        })
        expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_OBSERVATION' } })
        expect(stale.error).not.toHaveProperty('mayHaveTakenEffect')
        const clicked = await call('action', {
          handleId: opened.handleId,
          expectedRevision: first.revision,
          action: { action: 'click', coordinate: editor!.center }
        })
        expect(clicked.verification).toMatchObject({ status: 'verified' })
        const typed = await call('action', {
          handleId: opened.handleId,
          expectedRevision: clicked.revision,
          action: { action: 'type', text: 'alpha' }
        })
        expect(typed.verification).toMatchObject({ status: 'verified' })
        const navigated = await call('action', {
          handleId: opened.handleId,
          expectedRevision: typed.revision,
          action: { action: 'key', keys: ['ENTER'] }
        })
        expect(navigated.verification).toMatchObject({ status: 'verified' })
        const final = await call('observe', { handleId: opened.handleId })
        const finalMetadata = final.metadata as Record<string, unknown>
        expect(finalMetadata.url).toContain('/done?value=alpha')
        expect(finalMetadata.semanticTree).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'DONE:alpha' })
        ]))
        expect(await pageB.locator('input').inputValue()).toBe('')
        await pageA.close()
        const [lost, survivor] = await Promise.all([
          rawCall('observe', { handleId: opened.handleId }),
          call('observe', { handleId: openedB.handleId })
        ])
        expect(lost).toMatchObject({ ok: false, error: { code: 'TARGET_LOST' } })
        expect(survivor).toMatchObject({ targetId: targetB!.targetId })
        expect(await pageB.title()).toBe('Page B')
        await call('handles/close', { handleId: opened.handleId, reason: 'test_complete' })
        await call('handles/close', { handleId: openedB.handleId, reason: 'test_complete' })
        expect((await call('capabilities')).activeHandleCount).toBe(0)
      } finally {
        await adapter.close()
        expect(pageB.isClosed()).toBe(false)
        expect(await pageB.title()).toBe('Page B')
      }
    } finally {
      await browser.close()
      await new Promise<void>((resolve) => app.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no free loopback port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
