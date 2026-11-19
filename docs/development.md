# Development

```bash
npm install
npm run seed     # optional demo data: demo@ansa.local / demo1234
npm run dev      # API on :3000, web app with hot reload on :5173
npm test         # unit and integration tests
npm run typecheck
scripts/ci.sh    # everything, before you open a pull request
```

`scripts/ci.sh` is the one check for this repository: typecheck, the Node tests, the same isolation tests inside workerd (`npm run test:workerd`), and the build. It runs on your machine; there is no hosted CI.

`npm run test:mail` runs a full send-and-receive check against a local GreenMail server. The command to start GreenMail is at the top of `server/test/e2e-mail.ts`, with the variables that point the same check at `npm run dev:cf`.

```
server/            Hono API, SQLite, mail, MCP. Runs on Node.js and on Workers
  app.ts           The HTTP app both platforms share
  tenant.ts        Everything one install keeps in memory, and the context that carries it
  platform-node.ts Node.js: SQLite file, attachments on disk
  mail/            SMTP sending, IMAP sync, parsing and cleaning email
  services/        Conversations, customers, workflows, reports
  mcp.ts           MCP tools
worker/            Cloudflare: the Worker (index.ts) and its Durable Object (store.ts)
web/               React + Vite + Tailwind single-page app
```
