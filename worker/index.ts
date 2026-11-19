/**
 * Cloudflare Workers platform for a self-hosted install. The whole app runs inside one Durable Object
 * (store.ts). The web app is served as static assets.
 */
import { CODE_HEADER, codeStamp, type StoreEnv } from './store.ts'

export { AnsaStore } from './store.ts'

interface Env extends StoreEnv {
  ANSA: DurableObjectNamespace
}

/** True once this Worker instance has seen the Durable Object answer with code at least as new as its own. */
let objectIsCurrent = false

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mine = codeStamp(env)
    const object = () => env.ANSA.get(env.ANSA.idFromName('main'))
    const forward = () => {
      const headers = new Headers(request.headers)
      headers.set(CODE_HEADER, String(mine))
      return object().fetch(new Request(request, { headers }))
    }
    const isCurrent = (response: Response | null) => !mine || Number(response?.headers.get(CODE_HEADER) || 0) >= mine

    // Do not open a long-lived stream to an object that still runs old code: the stream is what keeps it old.
    // The browser retries the stream every few seconds, and by then the object has restarted.
    if (!objectIsCurrent && mine && new URL(request.url).pathname === '/api/events') {
      const probe = await object()
        .fetch(new Request(new URL('/healthz', request.url), { headers: { [CODE_HEADER]: String(mine) } }))
        .catch(() => null)
      if (isCurrent(probe)) objectIsCurrent = true
      else return new Response('Updating. Try again in a moment.', { status: 503, headers: { 'Retry-After': '3' } })
    }

    const safe = request.method === 'GET' || request.method === 'HEAD'
    try {
      const response = await forward()
      if (isCurrent(response)) objectIsCurrent = true
      return response
    } catch (err) {
      // The object restarted to load new code. A read can be repeated at once.
      if (!safe) throw err
      return forward()
    }
  },
}
