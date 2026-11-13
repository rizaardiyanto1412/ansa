# MCP server and REST API

Ansa speaks the Model Context Protocol for AI assistants, and a JSON API for your own scripts. Both use the same token.

## Connect an AI assistant (MCP)

Ansa serves the Model Context Protocol at `https://your-domain/mcp` (Streamable HTTP).

1. Open **Settings → API & MCP** and create a token. The page shows ready-to-paste setup for Claude Code, Claude Desktop and Cursor.
2. For Claude Code:

   ```bash
   claude mcp add --transport http ansa https://your-domain/mcp \
     --header "Authorization: Bearer ansa_your_token"
   ```

The assistant acts as the teammate who created the token. Revoke the token to cut it off.

| Tool | What it does |
|---|---|
| `list_mailboxes` | Mailboxes and how many conversations need attention |
| `list_conversations` | List, filter or full-text search conversations |
| `get_conversation` | Read a thread: messages, replies, notes, customer |
| `reply_to_conversation` | Email a reply to the customer |
| `add_note` | Add an internal note |
| `update_conversation` | Change status, assignee, tags, subject, snooze |
| `create_conversation` | Email a customer, or log a message or call |
| `list_customers`, `get_customer`, `update_customer` | Find and edit customer profiles |
| `list_saved_replies`, `list_tags`, `list_team` | Reference data |
| `get_report` | Support metrics for the last N days |

`reply_to_conversation` and `create_conversation` (kind `email`) send real email. The server tells assistants to confirm with you first.

## Internal-only tokens

Choose **Internal only** when creating a token in **Settings → API & MCP**. These tokens work with both REST and MCP.

An internal-only token can read conversations, add notes, save drafts, tag, assign, and change status. It can create conversations from notes or customer messages and cancel scheduled replies.

It cannot email customers, schedule replies, send scheduled replies, or retry failed deliveries. It cannot use admin-only routes or change settings. The MCP server hides `reply_to_conversation` and tells assistants to add notes for the team instead.

Existing tokens keep full access.

## REST API

The web app's JSON API accepts the same token:

```bash
curl https://your-domain/api/conversations?folder=open \
  -H "Authorization: Bearer ansa_your_token"
```

| Method and path | Purpose |
|---|---|
| `GET /api/conversations` | List. Query: `mailbox`, `folder`, `status`, `assignee`, `tag`, `customer`, `q`, `sort`, `limit`, `offset` |
| `POST /api/conversations` | Create. Body: `mailboxId`, `customerEmail`, `subject`, `bodyHtml`, `kind` (`reply`, `customer`, `note`) |
| `GET /api/conversations/:id` | One conversation with its thread |
| `PATCH /api/conversations/:id` | `status`, `assigneeId`, `subject`, `addTags`, `removeTags`, `snoozedUntil`, `mailboxId` |
| `POST /api/conversations/:id/reply` | `bodyHtml`, `status`, `cc`, `bcc`, `attachmentIds` |
| `POST /api/conversations/:id/note` | `bodyHtml` |
| `POST /api/conversations/:id/merge` | `intoId` |
| `GET /api/customers`, `GET/PATCH /api/customers/:id` | Customers |
| `GET /api/tags`, `/api/saved-replies`, `/api/users`, `/api/mailboxes` | Reference data |
| `GET /api/reports` | Query: `from`, `to` (ms), `mailbox`, `tz` |
| `POST /api/attachments` | Multipart `file`. Returns an id for `attachmentIds` |
