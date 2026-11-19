# Cloudflare live updates and hibernation

`GET /api/bootstrap` advertises `liveTransport: "websocket"` on Cloudflare and `"sse"` on Node. Both transports use `/api/events` and send the same JSON events. Cloudflare requires a WebSocket upgrade authenticated by the session cookie or an API bearer token. Browser upgrades must have the same origin.

A socket sends presence as `{"type":"presence","presence":{"conversationId":1,"state":"viewing"}}`. The other state is `"replying"`. Sending `{"type":"presence","presence":null}` leaves the conversation. Closing the socket also leaves. Attachments retain the connection time, user, credential hash, and presence across hibernation. Multiple tabs for one person produce one viewer, with replying taking precedence. Revoked credentials cannot receive later events.

Clients must send `ping` every 30 seconds. Sockets with no heartbeat for 75 seconds are closed when presence is read. Cloudflare answers `pong` through `setWebSocketAutoResponse`, without invoking JavaScript or reconstructing the object. The browser reconnects with exponential backoff and jitter, restores its current presence, and refetches active queries after reconnecting. Open sockets disable the 60-second presence refresh. Cloudflare presence uses no HTTP heartbeat. Node retains SSE and its HTTP presence heartbeat.

Invalid messages close with 1003 (unsupported input) or 1007 (invalid JSON or presence). Only authentication failures close with 1008.

Cloudflare starts no periodic application timers. Its alarm selects the earliest snooze, scheduled reply, password-reset email, import step or import retry, or IMAP poll. IMAP, import and reset deadlines persist across reconstruction. Removing the last job removes the alarm. An open socket adds no alarm.
