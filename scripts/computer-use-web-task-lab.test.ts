import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyWebTaskState, WEB_TASKS, webTaskHtml } from './computer-use-web-task-lab'

describe('Computer Use Web Task Lab', () => {
  it('defines eight independently labelled tasks across required scenario classes', () => {
    assert.equal(WEB_TASKS.length, 8)
    assert.deepEqual(new Set(WEB_TASKS.map(({ scenario }) => scenario)), new Set([
      'todo', 'wiki', 'form', 'multipage', 'download', 'dynamic'
    ]))
    assert.equal(new Set(WEB_TASKS.map(({ id }) => id)).size, WEB_TASKS.length)
  })

  it('renders isolated semantic controls for every task', () => {
    for (const task of WEB_TASKS) {
      const html = webTaskHtml(task, new URL(`http://127.0.0.1/task/${task.id}`))
      assert.match(html, new RegExp(`Web Task ${task.label} ${task.scenario}`))
      assert.match(html, new RegExp(`${task.id.toUpperCase()}_WEB_TASK_CONTEXT`))
      assert.match(html, /publish/u)
    }
  })

  it('renders real navigation and safe file boundaries', () => {
    const wiki = WEB_TASKS.find(({ scenario }) => scenario === 'wiki')
    const multipage = WEB_TASKS.find(({ scenario }) => scenario === 'multipage')
    const download = WEB_TASKS.find(({ scenario }) => scenario === 'download')
    assert.ok(wiki && multipage && download)
    assert.match(webTaskHtml(wiki, new URL(`http://127.0.0.1/task/${wiki.id}?q=CRISPR`)), /Knowledge Result: CRISPR/u)
    assert.match(webTaskHtml(multipage, new URL(`http://127.0.0.1/task/${multipage.id}?step=2`)), /Verification code/u)
    const fileHtml = webTaskHtml(download, new URL(`http://127.0.0.1/task/${download.id}`))
    assert.match(fileHtml, /download="synthetic-epsilon\.txt"/u)
    assert.match(fileHtml, /type="file"[^>]+disabled/u)
  })

  it('starts with independent state and no synthetic success', () => {
    const state = emptyWebTaskState()
    assert.deepEqual(Object.keys(state), WEB_TASKS.map(({ id }) => id))
    assert.ok(Object.values(state).every((value) => value.status === 'ready' && value.count === 0 && value.downloadRequests === 0))
    assert.notEqual(state.alpha, state.beta)
  })
})
