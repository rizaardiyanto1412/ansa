# Hosted mail contract

The generic hosted hooks are defined in `server/hosted.ts` and exposed by `worker/store.ts`. These rules extend the core and control-plane interface.

## Inbound delivery

The control plane stores queued raw mail at `inbound/<workspaceId>/<uuid>`. `ingestInbound` accepts an R2 key only under its own `inbound/<workspaceId>/` or `ws/<workspaceId>/` prefix. Unscoped `inbound/` keys and other workspaces' keys fail with `Invalid`. The caller owns the raw object and may remove it after successful ingestion.

An ingest is keyed by Message-ID, or by SHA-256 of the raw bytes when Message-ID is absent. Its durable state is `started` or `complete`. Attachments are written before message rows. The message, attachment rows, and completion state commit in one transaction. Retrying a started ingest repeats the blob writes at the same keys and files one message. Only completed ingestion returns `duplicate`.

Started ingests older than two days are removed with their unused hash-keyed attachment blobs by the Node timer or Worker alarm. A later retry starts clean. Skipped messages also discard unused delivery blobs. Filed attachments are retained.

Completed ingest rows are retained for 180 days. A Message-ID-less duplicate older than that can file again. Messages with a Message-ID still deduplicate against filed threads.

## Outbound delivery

A reply is stored as `sending` with an attempt ID before the provider receives it. The attempt ID is its Message-ID. After restart, replies left in `sending` with an attempt ID become `uncertain`, because the provider may have accepted them. Replies without an attempt ID return to `queued` for automatic delivery. Automatic retries skip uncertain replies. **Send again** requires confirmation and preserves the Message-ID so another delivery is recognisable.

A hard bounce fails a reply only when the recipient matches its To, Cc, or Bcc recipients. A complaint leaves delivery state unchanged.

## Sending domains

The control plane owns periodic checks of pending sending domains and pushes status through `setSendingDomain`. The object's alarm never checks sending domains. The mailbox's **Check now** action still calls `CONTROL.checkSendingDomain`.

## Trial deadline

`PlanState` accepts optional `trialEndsAt: number | null`, in epoch milliseconds. The control plane supplies this value through `provision` or `setPlan`. Billing and the trial banner show the remaining days when a trial has a deadline, rounded up and clamped to zero. An omitted or null deadline hides the countdown.

## Workspace deletion

Hosted `deleteWorkspace` closes sockets, stops mail polling, and deletes the object's data and alarm. It retains all R2 objects, including exports. The control plane owns deletion of `ws/<workspaceId>/` after a seven-day grace period. Repeating `deleteWorkspace` is safe.

Self-hosted attachment deletion remains immediate. Deleting an attachment, conversation, or mailbox still removes the corresponding blobs through the existing file-deletion paths.

## System email

Every system email carries an `X-Ansa-Kind` header, both through `CONTROL.sendSystemEmail` (in `message.headers`) and over SMTP. The value is one of `invite`, `reset`, `sign-in`, or `notification`. Core currently sends `invite`, `reset`, and `notification`; `sign-in` is reserved for sign-in links.

## Point-in-time restore

`restoreBookmark(atMs)` returns the Durable Object bookmark for an epoch-millisecond time. `restoreTo(atMs, confirm)` rolls the workspace's whole SQLite database, including its key-value data, back to that time. Both need a provisioned hosted workspace and fail with `NotProvisioned` otherwise.

`atMs` must be a whole number within the last 30 days and not in the future. Anything else fails with `Invalid`. `restoreTo` also fails with `Invalid` unless `confirm` equals the workspace ID stored in the object.

`restoreTo` schedules the restore and then aborts the object. The call rejects or returns when the object restarts; check `health` afterwards. The restore returns a bookmark for the state just before it, which the object writes to its log as `[restore] ... Undo bookmark`.

A restore never changes R2. Attachments added after the restore time stay in the bucket unreferenced, and attachments deleted after it are gone. Local `wrangler dev` and workerd do not implement point-in-time recovery, so the restore itself runs only on Cloudflare.
