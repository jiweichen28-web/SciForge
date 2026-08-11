import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright-core'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core') as typeof import('playwright-core')

export const WEB_TASKS = Object.freeze([
  { id: 'alpha', label: 'Alpha', scenario: 'todo', oracle: { status: 'todo-completed', semanticTextTemplate: 'Completed: {value}' } },
  { id: 'beta', label: 'Beta', scenario: 'wiki', oracle: { status: 'wiki-result', semanticHeadingTemplate: 'Knowledge Result: {query}' } },
  { id: 'gamma', label: 'Gamma', scenario: 'form', oracle: { status: 'form-submitted', semanticTextTemplate: 'Submitted: {sample} | {discipline} | {priority}' } },
  { id: 'delta', label: 'Delta', scenario: 'multipage', oracle: { status: 'workflow-step-3', semanticHeading: 'Workflow Complete Delta', semanticText: 'Verified code DELTA-42' } },
  { id: 'epsilon', label: 'Epsilon', scenario: 'download', oracle: { status: 'download-served', downloadRequestDelta: 1 } },
  { id: 'zeta', label: 'Zeta', scenario: 'dynamic', oracle: { status: 'dynamic-completed', semanticText: 'Dynamic task completed Zeta' } },
  { id: 'eta', label: 'Eta', scenario: 'todo', oracle: { status: 'todo-completed', semanticTextTemplate: 'Completed: {value}' } },
  { id: 'theta', label: 'Theta', scenario: 'wiki', oracle: { status: 'wiki-result', semanticHeadingTemplate: 'Knowledge Result: {query}' } }
] as const)

export type WebTask = typeof WEB_TASKS[number]
export type WebTaskState = {
  scenario: WebTask['scenario']
  status: string
  value: string
  count: number
  cookie: string
  storage: string
  downloadRequests: number
  updatedAt: string | null
}

type WebTaskLabOptions = Readonly<{
  readyFile: string
  runtimeDir: string
  browserExecutable?: string
}>

const KNOWLEDGE: Readonly<Record<string, string>> = Object.freeze({
  CRISPR: 'CRISPR is a programmable system used for targeted genome editing.',
  Cas9: 'Cas9 is an RNA-guided nuclease used in CRISPR systems.',
  'Genome editing': 'Genome editing changes DNA at a selected genomic location.',
  Bacteriophage: 'A bacteriophage is a virus that infects bacteria.'
})

export function emptyWebTaskState(): Record<string, WebTaskState> {
  return Object.fromEntries(WEB_TASKS.map((task) => [task.id, {
    scenario: task.scenario,
    status: 'ready',
    value: '',
    count: 0,
    cookie: '',
    storage: '',
    downloadRequests: 0,
    updatedAt: null
  }]))
}

export function webTaskHtml(task: WebTask, url: URL): string {
  const marker = `${task.id.toUpperCase()}_WEB_TASK_CONTEXT`
  const body = scenarioBody(task, url)
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="sciforge-target-label" content="Web Task ${task.label} ${task.scenario}">
<title>Web Task ${task.label} ${task.scenario}</title>
<style>
body{margin:0;background:#eef3f8;color:#17212b;font:20px system-ui,sans-serif}main{box-sizing:border-box;width:820px;min-height:600px;margin:20px;padding:28px;background:#fff;border-radius:14px}h1{margin-top:0}label{display:block;margin:18px 0 8px}input,select,button,a.button{box-sizing:border-box;min-height:48px;padding:8px 12px;font:inherit}input[type=text],select{width:620px}button,a.button{display:inline-block;margin:14px 8px 14px 0}output,.result{display:block;margin-top:20px;padding:14px;background:#edf8ee}fieldset{margin:18px 0;padding:14px}li{margin:10px 0}
</style></head><body><main data-task="${task.id}" data-scenario="${task.scenario}">
${body}
<p>Context marker: ${marker}</p>
</main><script>
const taskId=${JSON.stringify(task.id)};const marker=${JSON.stringify(marker)};
document.cookie='sciforge_web_task_context='+marker+'; SameSite=Strict';localStorage.setItem('sciforge_web_task_context',marker);
const publish=async(status,value='',count=0)=>{await fetch('/state/'+taskId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status,value,count,cookie:document.cookie,storage:localStorage.getItem('sciforge_web_task_context')||'',updatedAt:new Date().toISOString()})})};
${scenarioScript(task, url)}
publish(${JSON.stringify(initialStatus(task, url))},${JSON.stringify(initialValue(task, url))},0);
</script></body></html>`
}

function scenarioBody(task: WebTask, url: URL): string {
  if (task.scenario === 'todo') return `<h1>Todo Lab ${task.label}</h1><label for="new-todo">New todo</label><input id="new-todo" type="text" aria-label="New todo ${task.label}" autocomplete="off"><ul id="todos" aria-label="Todo items ${task.label}"></ul><output id="todo-status">No todo items</output>`
  if (task.scenario === 'wiki') {
    const query = boundedText(url.searchParams.get('q'))
    if (query) {
      const summary = KNOWLEDGE[query] ?? `No controlled article exists for ${query}.`
      return `<h1>Knowledge Result: ${escapeHtml(query)}</h1><p class="result">${escapeHtml(summary)}</p><a class="button" href="/task/${task.id}">Back to search</a>`
    }
    return `<h1>Knowledge Search ${task.label}</h1><form method="get" action="/task/${task.id}"><label for="query">Search topic</label><input id="query" name="q" type="text" aria-label="Search topic ${task.label}" autocomplete="off"><button type="submit">Search ${task.label}</button></form><output>Ready for a controlled knowledge query</output>`
  }
  if (task.scenario === 'form') return `<h1>Research Intake Form ${task.label}</h1><form id="intake"><label for="sample">Sample name</label><input id="sample" type="text" aria-label="Sample name ${task.label}"><label for="discipline">Discipline</label><select id="discipline" aria-label="Discipline ${task.label}"><option value="">Choose</option><option>Genomics</option><option>Proteomics</option><option>Imaging</option></select><fieldset><legend>Priority</legend><label><input type="radio" name="priority" value="Routine"> Routine</label><label><input type="radio" name="priority" value="Urgent"> Urgent</label></fieldset><label><input id="terms" type="checkbox"> I confirm this is synthetic test data</label><button type="submit">Submit intake ${task.label}</button></form><output id="form-result">Not submitted</output>`
  if (task.scenario === 'multipage') {
    const step = url.searchParams.get('step') ?? '1'
    if (step === '3') return `<h1>Workflow Complete ${task.label}</h1><p class="result">Verified code ${escapeHtml(boundedText(url.searchParams.get('code')))}</p><a class="button" href="/task/${task.id}">Restart workflow</a>`
    if (step === '2') return `<h1>Workflow Step 2 ${task.label}</h1><label for="code">Verification code</label><input id="code" type="text" aria-label="Verification code ${task.label}"><button id="finish">Finish workflow ${task.label}</button><output id="workflow-status">Waiting for code</output>`
    return `<h1>Workflow Step 1 ${task.label}</h1><p>Review the synthetic request and continue.</p><a class="button" href="/task/${task.id}?step=2">Continue to step 2</a>`
  }
  if (task.scenario === 'download') return `<h1>File Transfer Lab ${task.label}</h1><p>Download a synthetic text artifact owned by this test.</p><a id="download" class="button" download="synthetic-${task.id}.txt" href="/download/${task.id}">Download synthetic artifact</a><output id="download-status">No download requested</output><label for="upload">Upload boundary</label><input id="upload" type="file" aria-label="Upload unavailable in target-scoped CDP" disabled><p>Upload is disabled because the current target-scoped action contract cannot safely populate a host file chooser.</p>`
  return `<h1>Dynamic Page Lab ${task.label}</h1><p id="dynamic-status">Preparing dynamic control</p><div id="dynamic-slot"><button id="stale" disabled>Old unavailable control</button></div><output id="dynamic-result">Waiting for replacement</output>`
}

function scenarioScript(task: WebTask, url: URL): string {
  if (task.scenario === 'todo') return `const input=document.querySelector('#new-todo'),list=document.querySelector('#todos'),status=document.querySelector('#todo-status');input.addEventListener('keydown',event=>{if(event.key!=='Enter'||!input.value.trim())return;const value=input.value.trim(),item=document.createElement('li'),check=document.createElement('input'),text=document.createElement('span'),remove=document.createElement('button');check.type='checkbox';check.setAttribute('aria-label','Complete '+value);text.textContent=value;remove.textContent='Delete';remove.setAttribute('aria-label','Delete '+value);item.append(check,text,remove);list.append(item);input.value='';status.textContent='Added: '+value;check.addEventListener('change',()=>{text.textContent=value+(check.checked?' completed':'');status.textContent=check.checked?'Completed: '+value:'Reopened: '+value;publish(check.checked?'todo-completed':'todo-reopened',value,list.children.length)});remove.addEventListener('click',()=>{item.remove();status.textContent='Deleted: '+value;publish('todo-deleted',value,list.children.length)});publish('todo-added',value,list.children.length)});`
  if (task.scenario === 'wiki') return ''
  if (task.scenario === 'form') return `document.querySelector('#intake').addEventListener('submit',event=>{event.preventDefault();const sample=document.querySelector('#sample').value.trim(),discipline=document.querySelector('#discipline').value,priority=document.querySelector('input[name=priority]:checked')?.value||'',terms=document.querySelector('#terms').checked,result=document.querySelector('#form-result');if(!sample||!discipline||!priority||!terms){result.textContent='Validation error: complete every field';publish('form-validation-error',sample,0);return}const value=sample+' | '+discipline+' | '+priority;result.textContent='Submitted: '+value;publish('form-submitted',value,1)});`
  if (task.scenario === 'multipage' && url.searchParams.get('step') === '2') return `document.querySelector('#finish').addEventListener('click',()=>{const code=document.querySelector('#code').value.trim(),status=document.querySelector('#workflow-status');if(code!==${JSON.stringify(`${task.id.toUpperCase()}-42`)}){status.textContent='Code rejected';publish('workflow-code-rejected',code,0);return}publish('workflow-completed',code,1).finally(()=>{location.href='/task/${task.id}?step=3&code='+encodeURIComponent(code)})});`
  if (task.scenario === 'download') return `document.querySelector('#download').addEventListener('click',()=>{document.querySelector('#download-status').textContent='Download requested';publish('download-requested','synthetic-${task.id}.txt',1)});`
  if (task.scenario === 'dynamic') return `setTimeout(()=>{const button=document.createElement('button');button.id='dynamic-action';button.textContent='Commit dynamic ${task.label}';button.addEventListener('click',()=>{document.querySelector('#dynamic-result').textContent='Dynamic task completed ${task.label}';publish('dynamic-completed','${task.label}',1)});document.querySelector('#dynamic-slot').replaceChildren(button);document.querySelector('#dynamic-status').textContent='Dynamic control ready';publish('dynamic-ready','${task.label}',0)},700);`
  return ''
}

function initialStatus(task: WebTask, url: URL): string {
  if (task.scenario === 'wiki' && url.searchParams.get('q')) return 'wiki-result'
  if (task.scenario === 'multipage') return `workflow-step-${url.searchParams.get('step') ?? '1'}`
  return 'ready'
}

function initialValue(task: WebTask, url: URL): string {
  if (task.scenario === 'wiki') return boundedText(url.searchParams.get('q'))
  if (task.scenario === 'multipage') return boundedText(url.searchParams.get('code'))
  return ''
}

export function browserExecutableCandidates(explicit?: string): string[] {
  return [
    explicit?.trim(), process.env.SCIFORGE_CUA_DEMO_BROWSER?.trim(),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter((value): value is string => Boolean(value))
}

export async function startWebTaskLab(options: WebTaskLabOptions): Promise<{ cdpEndpoint: string; stateEndpoint: string; close(): Promise<void> }> {
  const readyFile = resolve(options.readyFile)
  const runtimeDir = resolve(options.runtimeDir)
  await mkdir(runtimeDir, { recursive: true })
  await mkdir(dirname(readyFile), { recursive: true })
  const executablePath = browserExecutableCandidates(options.browserExecutable).find(existsSync)
  if (!executablePath) throw new Error('No supported Chromium executable was found for the Web Task Lab.')
  const state = emptyWebTaskState()
  const stateServer = createServer((request, response) => handleRequest(state, request, response))
  const statePort = await listenLoopback(stateServer)
  const cdpPort = await reserveLoopbackPort()
  const stateEndpoint = `http://127.0.0.1:${statePort}`
  const cdpEndpoint = `http://127.0.0.1:${cdpPort}`
  let browser: Browser | null = null
  const contexts: BrowserContext[] = []
  const pages: Page[] = []
  let closed = false
  try {
    browser = await chromium.launch({ executablePath, headless: true, downloadsPath: resolve(runtimeDir, 'downloads'), args: ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-default-browser-check'] })
    await waitForCdp(cdpEndpoint)
    for (const task of WEB_TASKS) {
      const context = await browser.newContext({ viewport: { width: 900, height: 680 }, acceptDownloads: true })
      contexts.push(context)
      const page = await context.newPage()
      pages.push(page)
      await page.goto(`${stateEndpoint}/task/${task.id}`, { waitUntil: 'networkidle' })
    }
    await waitForRegistration(state)
    await writeFile(readyFile, JSON.stringify({ schemaVersion: 2, runId: randomUUID(), cdpEndpoint, stateEndpoint, tasks: WEB_TASKS }, null, 2), 'utf8')
  } catch (error) {
    await Promise.allSettled(contexts.map((context) => context.close()))
    await browser?.close().catch(() => undefined)
    stateServer.close()
    throw error
  }
  return {
    cdpEndpoint, stateEndpoint,
    async close() {
      if (closed) return
      closed = true
      await Promise.allSettled(contexts.map((context) => context.close()))
      await browser?.close().catch(() => undefined)
      await new Promise<void>((resolveClose) => stateServer.close(() => resolveClose()))
      await rm(readyFile, { force: true })
    }
  }
}

function handleRequest(state: Record<string, WebTaskState>, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const taskMatch = /^\/task\/([a-z]+)$/u.exec(url.pathname)
  const task = taskMatch ? WEB_TASKS.find(({ id }) => id === taskMatch[1]) : undefined
  if (request.method === 'GET' && task) {
    if (task.scenario === 'wiki' && url.searchParams.get('q')) {
      state[task.id] = { ...state[task.id], status: 'wiki-result', value: boundedText(url.searchParams.get('q')), count: state[task.id].count + 1, updatedAt: new Date().toISOString() }
    }
    send(response, 200, webTaskHtml(task, url), 'text/html; charset=utf-8')
    return
  }
  if (request.method === 'GET' && url.pathname === '/state') {
    send(response, 200, JSON.stringify(state), 'application/json; charset=utf-8')
    return
  }
  const downloadMatch = /^\/download\/([a-z]+)$/u.exec(url.pathname)
  const downloadTask = downloadMatch ? WEB_TASKS.find(({ id }) => id === downloadMatch[1] && id === 'epsilon') : undefined
  if (request.method === 'GET' && downloadTask) {
    const content = `SciForge synthetic artifact ${downloadTask.label}\nsha256 source marker\n`
    state[downloadTask.id] = { ...state[downloadTask.id], status: 'download-served', value: createHash('sha256').update(content).digest('hex'), downloadRequests: state[downloadTask.id].downloadRequests + 1, updatedAt: new Date().toISOString() }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="synthetic-${downloadTask.id}.txt"`, 'content-length': Buffer.byteLength(content), 'cache-control': 'no-store' })
    response.end(content)
    return
  }
  const stateMatch = /^\/state\/([a-z]+)$/u.exec(url.pathname)
  const stateTask = stateMatch ? WEB_TASKS.find(({ id }) => id === stateMatch[1]) : undefined
  if (request.method === 'POST' && stateTask) {
    readJson(request).then((payload) => {
      const previous = state[stateTask.id]
      state[stateTask.id] = { ...previous, status: boundedText(payload.status), value: boundedText(payload.value), count: finiteNonnegativeInteger(payload.count), cookie: boundedText(payload.cookie), storage: boundedText(payload.storage), updatedAt: boundedText(payload.updatedAt) || null }
      send(response, 204, '')
    }).catch((error) => send(response, 400, String(error)))
    return
  }
  send(response, 404, 'not found')
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > 64_000) throw new Error('request body is too large')
    chunks.push(value)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object')
  return parsed as Record<string, unknown>
}

function send(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  response.end(body)
}

async function listenLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Web Task Lab server has no TCP address'))
      resolveListen(address.port)
    })
  })
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer()
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('port reservation failed'))
      resolvePort(address.port)
    })
  })
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

async function waitForCdp(endpoint: string): Promise<void> {
  const deadline = Date.now() + 15_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) { lastError = error }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Chromium CDP endpoint did not become ready: ${String(lastError)}`)
}

async function waitForRegistration(state: Record<string, WebTaskState>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (WEB_TASKS.every((task) => {
      const marker = `${task.id.toUpperCase()}_WEB_TASK_CONTEXT`
      return state[task.id].cookie.includes(marker) && state[task.id].storage === marker
    })) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error('Web Task Lab contexts did not establish isolated cookie/storage markers.')
}

function finiteNonnegativeInteger(value: unknown): number {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : 0
}

function boundedText(value: unknown): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 512)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

function parseOptions(argv: readonly string[]): WebTaskLabOptions {
  const values = new Map<string, string>()
  const allowed = new Set(['--ready-file', '--runtime-dir', '--browser'])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error('Expected --ready-file and --runtime-dir arguments.')
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}`)
    values.set(key, value)
  }
  const readyFile = values.get('--ready-file')
  const runtimeDir = values.get('--runtime-dir')
  if (!readyFile || !runtimeDir) throw new Error('--ready-file and --runtime-dir are required.')
  return { readyFile, runtimeDir, ...(values.get('--browser') ? { browserExecutable: values.get('--browser') } : {}) }
}

async function main(): Promise<void> {
  const lab = await startWebTaskLab(parseOptions(process.argv.slice(2)))
  const stop = async () => { await lab.close(); process.exitCode = 0 }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  await new Promise<void>(() => undefined)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
