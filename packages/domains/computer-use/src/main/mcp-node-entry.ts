import { runComputerUseMcpServerFromArgv } from './mcp-server.js'

void runComputerUseMcpServerFromArgv(process.argv)
  .then((handled) => {
    if (handled) return
    console.error('[computer-use-mcp] missing MCP launch flag')
    process.exitCode = 1
  })
  .catch((error) => {
    console.error('[computer-use-mcp] server failed:', error)
    process.exitCode = 1
  })
