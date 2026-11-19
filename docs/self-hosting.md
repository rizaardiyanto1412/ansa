# Self-hosting guide

How to run Ansa on your own server or on Cloudflare, connect your email, and keep it backed up.

## Install on a VPS

You need a server with Docker, and a domain name that points to it.

```bash
git clone https://github.com/rizaardiyanto1412/ansa.git ansa && cd ansa
cp .env.example .env
nano .env                      # set DOMAIN and APP_URL
docker compose --profile https up -d --build
```

Open `https://your-domain`. The first visit asks you to create the admin account, then to connect your mailbox. Do this right after the first start: until an admin exists, anyone who finds the address can create it.

Caddy gets and renews the HTTPS certificate for you. Ports 80 and 443 must be open.

**Already have a reverse proxy** (nginx, Traefik, Cloudflare Tunnel)? Skip the profile and point your proxy at port 3000. Keep `TRUST_PROXY=1` only when the proxy sets `X-Forwarded-For` itself:

```bash
docker compose up -d --build   # serves http://127.0.0.1:3000
```

**Want to look around first?** Load demo data into an empty install, then sign in with `demo@ansa.local` / `demo1234`:

```bash
docker compose exec ansa node dist/seed.js
```

### Update

```bash
git pull && docker compose --profile https up -d --build
```

Database changes apply by themselves on start.

### Teammates and passwords

Invite teammates in **Settings → Team**. Ansa emails each one a link to choose a name and a password. Anyone can use **Forgot your password?** on the sign-in page to get a link by email. Links work once, for 24 hours.

These emails go out through the SMTP server of your first mailbox. Until a mailbox is connected, switch on **Set their password myself** when you add a teammate.

### Back up

Everything lives in the `ansa-data` volume: `ansa.db` (all data), `attachments/` and `secret.key`.

```bash
docker run --rm -v ansa_ansa-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/ansa-backup-$(date +%F).tar.gz -C /data .
```

Keep `secret.key` with the database. It encrypts the saved mail passwords, and they cannot be read without it.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rizaardiyanto1412/ansa)

The button copies this repository to your GitHub account, builds it, and deploys it to your Cloudflare account. Accept the suggested build and deploy commands. When it finishes, open the `workers.dev` address, create the admin account, and connect your mailbox.

The button only works while this repository is public. For a private repository, deploy from your machine:

```bash
npm ci
npx wrangler login
npm run deploy
```

How it runs on Cloudflare:

- **One Worker and one Durable Object.** The Durable Object's built-in SQLite database holds all data, attachments included. You do not create a database, a bucket or a secret.
- **Email works the same way.** Ansa sends over SMTP and reads over IMAP with the settings from **Settings → Mailboxes**. It checks for new mail every 60 seconds (`IMAP_POLL_SECONDS` in `wrangler.jsonc`), because a Worker cannot hold a connection open.
- **Use port 587 or 465 for SMTP.** Cloudflare blocks port 25.
- **Your domain.** Add a custom domain to the Worker in the Cloudflare dashboard. Links in notification emails use the address you sign in on. To pin it, set `APP_URL` under `vars` in `wrangler.jsonc`.
- **Plan.** The free plan is enough to try Ansa. For a team that keeps it open all day, use Workers Paid: an open browser tab keeps the Durable Object awake, and the free plan's daily allowance covers about one tab.
- **Backups.** Cloudflare keeps 30 days of point-in-time recovery for the Durable Object. There is no file to download.
- **Updates.** Push to the repository that the button created. Cloudflare rebuilds and deploys it.

Try it locally with `npm run dev:cf` (http://localhost:8787).

## Connect Google Workspace or Gmail

Google does not accept your normal password for SMTP and IMAP. Use an app password.

1. Turn on **2-Step Verification** for the Google account that owns the support address.
2. Create an app password at <https://myaccount.google.com/apppasswords>.
3. In Ansa, open **Settings → Mailboxes → Add mailbox** and choose **Google Workspace or Gmail**. This fills in the servers:

   | | Host | Port | Security |
   |---|---|---|---|
   | SMTP | `smtp.gmail.com` | 587 | STARTTLS |
   | IMAP | `imap.gmail.com` | 993 | SSL/TLS |

4. Username: the full email address. Password: the 16-character app password.
5. Press **Test connection** in both sections, then save.

If your Workspace admin disabled app passwords, ask them to allow them for this account. If the address is an alias or a group, sign in as the real mailbox that receives its mail, and add the alias under Gmail's **Send mail as** setting so Google lets you send from it.

Ansa only reads mail. It does not delete or move anything in your Google inbox. By default it imports mail that arrives after you connect; tick **Import the last 30 days** to bring in recent history.

## Import from Help Scout

Open **Settings → Import**. Help Scout gives out conversations only through its API, so you create a private app there first.

1. In Help Scout, open **Your Profile → My Apps** and press **Create My App**. Use any name, and `https://example.com` as the redirection URL.
2. Paste the **App ID** and **App Secret** into Ansa and press **Connect**.
3. Choose where each Help Scout inbox goes, then start the import.

It runs in the background and can be stopped and resumed. Running it again adds only what is new. Nothing in Help Scout is changed.

- **Imported:** conversations with their dates and status, customer messages, replies, notes, customers, tags, attachments.
- **Not imported:** spam, drafts, activity lines, saved replies, workflows, custom fields, ratings.
- **Speed:** about 20,000 conversations an hour. Help Scout allows 200 requests a minute.
- **On Cloudflare:** a large import needs the Workers Paid plan. The free plan limits database writes per day; the import pauses when it hits the limit and you resume it the next day.

## Settings

Set these in `.env` (Docker) or the environment.

| Variable | Default | Meaning |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | Public address. Used in links and to mark cookies secure |
| `DOMAIN` | | Domain for Caddy's certificate (Docker `https` profile) |
| `PORT` | `3000` | Port the app listens on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, attachments and the secret key |
| `APP_SECRET` | generated into `DATA_DIR/secret.key` | Key that encrypts saved mail passwords |
| `IMAP_POLL_SECONDS` | `60` | Fallback check interval. New mail usually arrives instantly through IMAP IDLE |
| `MAX_ATTACHMENT_MB` | `25` | Upload limit per file |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy that sets `X-Forwarded-For`, so sign-in limits count each visitor. Without it, Ansa counts the address that connects to it |

Mailboxes, teammates and everything else are set up in the app.

## Run without Docker

Needs Node.js 22.13 or newer.

```bash
npm ci
npm run build
APP_URL=https://your-domain NODE_ENV=production npm start
```

Put it behind any HTTPS reverse proxy. A minimal systemd unit:

```ini
[Service]
WorkingDirectory=/opt/ansa
Environment=NODE_ENV=production APP_URL=https://your-domain DATA_DIR=/var/lib/ansa
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/index.js
Restart=always
User=ansa

[Install]
WantedBy=multi-user.target
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘K` or `/` | Search and commands |
| `C` | New conversation |
| `J` / `K` | Next / previous conversation |
| `R` / `N` | Reply / add a note |
| `A` | Assign to me |
| `E` | Close the conversation |
| `⌘Enter` | Send |
| `?` | Show all shortcuts |
