# Cloudflare live updates and hibernation

`GET /api/bootstrap` advertises `liveTransport: "websocket"` on Cloudflare and `"sse"` on Node. Both transports use `/api/events` and send the same JSON events. Cloudflare requires a WebSocket upgrade authenticated by the session cookie or an API bearer token. Browser upgrades must have the same origin.

A socket sends presence as `{"type":"presence","presence":{"conversationId":1,"state":"viewing"}}`. The other state is `"replying"`. Sending `{"type":"presence","presence":null}` leaves the conversation. Closing the socket also leaves. Attachments retain the user, credential hash, and presence across hibernation. Multiple tabs for one person produce one viewer, with replying taking precedence. Revoked credentials cannot receive later events.

The browser sends `ping` every 30 seconds. Cloudflare answers `pong` through `setWebSocketAutoResponse`, without invoking JavaScript or reconstructing the object. The browser reconnects with exponential backoff and jitter, restores its current presence, and refetches active queries. Open sockets disable the 60-second presence refresh. Cloudflare presence uses no HTTP heartbeat. Node retains SSE and its HTTP presence heartbeat.

Cloudflare starts no periodic application timers. Its alarm selects the earliest snooze, scheduled reply, import step or import retry, or IMAP poll. IMAP and import deadlines persist across reconstruction. Removing the last job removes the alarm. An open socket adds no alarm.

## Verification

Run `bash scripts/ci.sh` for typechecking, Node tests, workerd tests, and both builds.

The workerd tests use Wrangler's `evictDurableObject` with `webSockets: "hibernate"`. They verify presence after reconstruction, explicit leave, close, multiple tabs, token authentication and revocation, invalid input, and broadcasts isolated to each workspace. Constructor instrumentation records zero calls to `setInterval` and `setTimeout`. An automatic ping produces a pong without increasing the message-handler counter. A second eviction attempt reports that the object is not currently running, proving that ping did not reconstruct it. Only the later inspection request increases the constructor counter. The idle object's alarm remains absent.

Local browser verification used `wrangler dev --local --port 8792` with two users in separate browser profiles. Each tab showed the other's viewing and replying state. A subject change appeared live in the other tab. Worker reloads reconnected the sockets, restored presence, and refetched the open conversation. Closing the second tab removed its viewer. With only the first tab left open, a 77.579-second idle observation recorded zero API resource requests in the browser. This spans both the old 20-second heartbeat and the old 60-second refresh. The workerd counter test separately proves that ping replies leave the object asleep and its constructor creates no timers.

A separate check started the built Node server, verified the SSE bootstrap field and content type, read its hello event, changed a conversation through the HTTP API, and received the conversation event on the same stream.
