import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['web/src/lib/hooks.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
  plugins: [{
    name: 'hook-environment',
    setup(build) {
      build.onResolve({ filter: /^(react|@tanstack\/react-query|\.\/api|\.\/workspace)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'react' ? `
        export const createContext = value => ({ value });
        export const useContext = () => globalThis.hookSession;
        export const useCallback = fn => fn;
        export const useRef = current => ({ current });
        export const useState = value => [value, () => {}];
        export const useEffect = fn => { globalThis.hookCleanup = fn(); };
      ` : path === '@tanstack/react-query' ? `
        export const useQueryClient = () => globalThis.hookClient;
        export const useQuery = () => ({});
      ` : path === './api' ? 'export const api = {};' : 'export const brand = () => "Ansa";' }))
    },
  }],
})
const hooks = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

test('live hello refreshes queries only after reconnecting and only 1008 signs out', () => {
  const globals = ['hookSession', 'hookClient', 'hookCleanup', 'window', 'document', 'location', 'WebSocket', 'EventSource']
  const original = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let cleanup: (() => void) | undefined
  try {
    for (const transport of ['sse', 'websocket']) {
      const events = new EventTarget()
      const page = new EventTarget()
      let signedOut = 0
      events.addEventListener('ansa:signed-out', () => signedOut++)
      Object.assign(page, { visibilityState: 'visible' })
      const connections: Connection[] = []
      class Connection {
        static OPEN = 1
        readyState = 1
        onmessage: ((event: { data: string }) => void) | null = null
        onclose: ((event: { code: number }) => void) | null = null
        close() {}
        send() {}
        constructor() { connections.push(this) }
      }
      let invalidations = 0
      Object.assign(globalThis, {
        window: events, document: page, location: { href: 'https://ansa.test', protocol: 'https:' },
        WebSocket: Connection, EventSource: Connection,
        hookSession: { liveTransport: transport },
        hookClient: { invalidateQueries: () => { invalidations++ } },
      })
      hooks.useLiveEvents()
      cleanup = Reflect.get(globalThis, 'hookCleanup')
      connections[0].onmessage?.({ data: '{"type":"hello"}' })
      assert.equal(invalidations, 0, `${transport}: first connection keeps the initial query fetches`)
      events.dispatchEvent(new Event('pagehide'))
      events.dispatchEvent(new Event('pageshow'))
      assert.equal(connections.length, 2, 'returning to the page creates a new connection')
      connections[1].onmessage?.({ data: '{"type":"hello"}' })
      assert.equal(invalidations, 1, `${transport}: another hello refreshes missed events`)
      if (transport === 'websocket') {
        connections[1].onclose?.({ code: 1007 })
        assert.equal(signedOut, 0, 'invalid input does not sign out')
        events.dispatchEvent(new Event('online'))
        connections.at(-1)?.onclose?.({ code: 1008 })
        assert.equal(signedOut, 1, 'authentication failure signs out')
      }
      cleanup?.()
      cleanup = undefined
    }
  } finally {
    cleanup?.()
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
