import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const LOOPBACK_BIND_ATTEMPTS = 20
// WHATWG Fetch §2.9. A Windows ephemeral range can include these ports, and
// standard Fetch clients reject them before sending even to a loopback peer.
const FETCH_BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080
])

export async function listenOnFetchSafeLoopbackPort(
  server: Server,
  requestedPort?: number
): Promise<AddressInfo> {
  if (requestedPort && FETCH_BLOCKED_PORTS.has(requestedPort)) {
    throw new Error(`Loopback HTTP port ${requestedPort} is blocked by the Fetch standard.`)
  }
  const attempts = requestedPort ? 1 : LOOPBACK_BIND_ATTEMPTS
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(requestedPort ?? 0, '127.0.0.1')
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await closeServer(server)
      throw new Error('Loopback HTTP server did not bind a TCP port.')
    }
    if (!FETCH_BLOCKED_PORTS.has(address.port)) return address
    await closeServer(server)
  }
  throw new Error(`Loopback HTTP server could not bind a Fetch-safe port after ${attempts} attempts.`)
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
