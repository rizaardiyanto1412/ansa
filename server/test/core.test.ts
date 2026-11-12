import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Every test file gets its own throwaway database. Set before the app modules load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-test-'))
process.env.MAIL_DISABLED = '1'

await import('../platform-node.ts')
const html = await import('../mail/html.ts')
const { migrate, run, get, all } = await import('../db.ts')
const { ingestRaw } = await import('../mail/ingest.ts')
const conversations = await import('../services/conversations.ts')
const { matches } = await import('../services/workflows.ts')
const { hashPassword, verifyPassword, encrypt, decrypt } = await import('../crypto.ts')

let mailboxId = 0
let agentId = 0
before(() => {
  migrate()
  mailboxId = run(`INSERT INTO mailboxes (name, email, auto_reply_enabled, auto_reply_body, created_at) VALUES ('Support', 'support@acme.test', 1, 'Hi {{customer.firstName}}, we got your message.', 1)`).id
  agentId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Agent', 'agent@acme.test', 'x', 'admin', 1)`).id
})

const eml = (headers: Record<string, string>, body: string, type = 'text/plain') =>
  [...Object.entries({ 'MIME-Version': '1.0', 'Content-Type': `${type}; charset=utf-8`, ...headers }).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n')

test('cleanHtml removes scripts, handlers and unsafe links', () => {
  const out = html.cleanHtml('<p onclick="x()">Hi <a href="javascript:alert(1)">a</a><script>bad()</script><img src="x" onerror="y()"><iframe src="//evil"></iframe></p><style>p{}</style>')
  assert.ok(!/script|onclick|onerror|javascript:|iframe|style/i.test(out), out)
  assert.ok(out.includes('Hi'))
})

test('cleanHtml makes links open safely in a new tab', () => {
  assert.match(html.cleanHtml('<a href="https://example.com">x</a>'), /target="_blank" rel="noopener noreferrer nofollow"/)
})

test('stripQuotedHtml trims Gmail, Apple Mail and Outlook quotes', () => {
  assert.equal(html.stripQuotedHtml('<div>Thanks!</div><div class="gmail_quote"><blockquote>old</blockquote></div>'), '<div>Thanks!</div>')
  const apple = html.stripQuotedHtml('<div>Sounds good</div><div>On Nov 3, 2026, at 10:00, Sam &lt;s@x.com&gt; wrote:</div><blockquote type="cite">old</blockquote>')
  assert.ok(apple && apple.includes('Sounds good') && !apple.includes('wrote') && !apple.includes('old'), String(apple))
  const outlook = html.stripQuotedHtml('<p>Yes please</p><div id="divRplyFwdMsg"><b>From:</b> Support</div><p>old</p>')
  assert.ok(outlook && !outlook.includes('old'))
})

test('stripQuotedHtml leaves a message alone when nothing or everything would be removed', () => {
  assert.equal(html.stripQuotedHtml('<p>No quote here</p>'), null)
  assert.equal(html.stripQuotedHtml('<div class="gmail_quote">only a forward</div>'), null)
})

test('stripQuotedText trims "On … wrote:" and trailing > lines', () => {
  assert.equal(html.stripQuotedText('Works now.\n\nOn Tue, 3 Nov 2026 at 10:00, Sam <s@x.com> wrote:\n> old\n> text'), 'Works now.')
  assert.equal(html.stripQuotedText('Works now.\n\n> old\n> text\n'), 'Works now.')
  assert.equal(html.stripQuotedText('Just one line'), null)
})

test('textToHtml escapes, links and keeps paragraphs; htmlToText reverses it', () => {
  const out = html.textToHtml('Hi <b>\nsee https://example.com/a?b=1.\n\nBye')
  assert.equal(out, '<p>Hi &lt;b&gt;<br>see <a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a?b=1</a>.</p><p>Bye</p>')
  assert.equal(html.htmlToText('<p>Hi &amp; bye</p><ul><li>one</li><li>two</li></ul>'), 'Hi & bye\n\n- one\n- two')
})

test('passwords hash and verify; secrets encrypt and decrypt', () => {
  const hash = hashPassword('correct horse')
  assert.ok(verifyPassword('correct horse', hash))
  assert.ok(!verifyPassword('wrong', hash))
  const sealed = encrypt('app-password')
  assert.notEqual(sealed, 'app-password')
  assert.equal(decrypt(sealed), 'app-password')
  assert.equal(decrypt('garbage'), '')
})

test('workflow conditions match all or any', () => {
  const ctx = { subject: 'Refund please', body: 'I want my money back', from: 'a@globex.test', to: '', customer_name: 'Al' }
  assert.ok(matches('all', [{ field: 'subject', op: 'contains', value: 'refund' }, { field: 'from', op: 'ends_with', value: '@globex.test' }], ctx))
  assert.ok(!matches('all', [{ field: 'subject', op: 'contains', value: 'refund' }, { field: 'body', op: 'contains', value: 'invoice' }], ctx))
  assert.ok(matches('any', [{ field: 'subject', op: 'is', value: 'nope' }, { field: 'body', op: 'contains', value: 'money' }], ctx))
})

test('incoming email creates a conversation, auto-replies once, and runs workflows', async () => {
  run(`INSERT INTO workflows (name, trigger, match, conditions, actions, created_at) VALUES ('Tag refunds', 'new', 'all', ?, ?, 1)`, JSON.stringify([{ field: 'subject', op: 'contains', value: 'refund' }]), JSON.stringify([{ type: 'add_tag', value: 'refund' }, { type: 'assign', value: String(agentId) }]))
  const result = await ingestRaw(mailboxId, eml({ From: 'Jane Doe <jane@customer.test>', To: 'support@acme.test', Subject: 'Refund for order 7', 'Message-ID': '<m1@customer.test>' }, 'Please refund order 7.'))
  assert.ok(result?.created)
  const conv = conversations.getConversation(result.conversationId)
  assert.equal(conv.subject, 'Refund for order 7')
  assert.equal(conv.customer.name, 'Jane Doe')
  assert.deepEqual(conv.tags.map((t) => t.name), ['refund'])
  assert.equal(conv.assignee?.id, agentId)
  assert.equal(conv.status, 'active', 'an auto reply does not change the status')
  const auto = conv.threads.find((t) => t.type === 'reply')
  assert.ok(auto?.bodyHtml.includes('Hi Jane, we got your message.'))
  assert.ok(conv.waitingSince, 'the customer is still waiting for a real answer')

  assert.equal(await ingestRaw(mailboxId, eml({ From: 'jane@customer.test', Subject: 'Refund for order 7', 'Message-ID': '<m1@customer.test>' }, 'dup')), null, 'the same Message-ID is imported once')
})

test('a reply threads by In-Reply-To or References, reopens the conversation and trims the quote', async () => {
  const first = await ingestRaw(mailboxId, eml({ From: 'Sam <sam@customer.test>', Subject: 'Login broken', 'Message-ID': '<s1@customer.test>' }, 'I cannot log in.'))
  const id = first!.conversationId
  conversations.addReply(id, { bodyHtml: '<p>Try again now.</p>', status: 'closed' }, { userId: agentId, via: 'web' })
  const ours = get<{ message_id: string }>(`SELECT message_id FROM threads WHERE conversation_id = ? AND type = 'reply' AND via = 'web'`, id)!
  assert.equal(conversations.getSummary(id).status, 'closed')

  const second = await ingestRaw(mailboxId, eml({ From: 'Sam <sam@customer.test>', Subject: 'Re: Login broken', 'Message-ID': '<s2@customer.test>', References: `<unrelated@x> ${ours.message_id}` }, 'Works, thanks!\n\nOn Tue, Nov 3, 2026 at 10:00 Support wrote:\n> Try again now.'))
  assert.equal(second?.conversationId, id)
  assert.equal(second?.created, false)
  const conv = conversations.getConversation(id)
  assert.equal(conv.status, 'active')
  const last = conv.threads.filter((t) => t.type === 'customer').at(-1)!
  assert.equal(last.bodyHtml, '<p>Works, thanks!</p>')
  assert.ok(last.hasQuoted)
  assert.match(conversations.getQuotedHtml(last.id), /Try again now/)
})

test('our own mail, notifications and automated senders are handled safely', async () => {
  assert.equal(await ingestRaw(mailboxId, eml({ From: 'support@acme.test', Subject: 'loop', 'Message-ID': '<own@x>' }, 'x')), null)
  const before = all(`SELECT id FROM threads WHERE type = 'reply' AND via = 'auto'`).length
  const bounce = await ingestRaw(mailboxId, eml({ From: 'MAILER-DAEMON@mx.test', Subject: 'Undeliverable', 'Message-ID': '<b1@x>', 'Auto-Submitted': 'auto-replied' }, 'bounce'))
  assert.ok(bounce?.created)
  assert.equal(all(`SELECT id FROM threads WHERE type = 'reply' AND via = 'auto'`).length, before, 'never auto-reply to automated mail')
})

test('search, folders, snooze and merge behave', async () => {
  const a = conversations.createConversation({ mailboxId, customerEmail: 'kim@customer.test', subject: 'Zebra printer jams', bodyHtml: '<p>The zebra printer jams daily.</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const b = conversations.createConversation({ mailboxId, customerEmail: 'kim@customer.test', subject: 'Printer again', bodyHtml: '<p>Still jammed.</p>', kind: 'customer' }, { userId: null, via: 'email' })
  assert.deepEqual(conversations.listConversations({ q: 'zebra jam' }).items.map((c) => c.id), [a.id], 'full-text search with a prefix on the last word')
  assert.deepEqual(conversations.listConversations({ q: `#${b.id}` }).items.map((c) => c.id), [b.id])
  assert.equal(conversations.listConversations({ q: '"\'; DROP' }).items.length, 0)

  conversations.updateConversation(a.id, { snoozedUntil: Date.now() + 60_000 }, { userId: agentId, via: 'web' })
  assert.ok(!conversations.listConversations({ mailboxId, folder: 'unassigned' }).items.some((c) => c.id === a.id))
  assert.ok(conversations.listConversations({ mailboxId, folder: 'snoozed' }).items.some((c) => c.id === a.id))
  run('UPDATE conversations SET snoozed_until = 1 WHERE id = ?', a.id)
  conversations.wakeSnoozed()
  assert.equal(conversations.getSummary(a.id).snoozedUntil, null)

  const merged = conversations.mergeConversations(b.id, a.id, { userId: agentId, via: 'web' })
  assert.equal(merged.threadCount, 2)
  assert.throws(() => conversations.getSummary(b.id), /not found/)
  assert.deepEqual(conversations.listConversations({ q: 'still jammed' }).items.map((c) => c.id), [a.id])
})

test('inline images are served from our own URLs and other files become attachments', async () => {
  const boundary = 'BOUND'
  const raw = [
    'From: Pat <pat@customer.test>',
    'Subject: Screenshot',
    'Message-ID: <img1@customer.test>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>See <img src="cid:shot1"></p>',
    `--${boundary}`,
    'Content-Type: image/png; name="shot.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <shot1>',
    'Content-Disposition: inline; filename="shot.png"',
    '',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    `--${boundary}--`,
  ].join('\r\n')
  const result = await ingestRaw(mailboxId, raw)
  const thread = conversations.getConversation(result!.conversationId).threads[0]
  assert.match(thread.bodyHtml, /<img src="\/api\/attachments\/\d+\/shot\.png"/)
  assert.equal(thread.attachments[0].inline, true)
})

test('hostile HTML cannot stall quote stripping', () => {
  const started = Date.now()
  assert.equal(html.stripQuotedHtml('<div '.repeat(200_000)), null)
  assert.equal(html.stripQuotedHtml(`<p>Hi</p>${'<div class="x" '.repeat(100_000)}<div class="gmail_quote">old</div>`)?.includes('old'), false)
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`)
})

test('Reply-To names the customer when a form sends from its own address', async () => {
  const result = await ingestRaw(mailboxId, eml({ From: 'Website <support@acme.test>', 'Reply-To': 'Lee Wong <lee@customer.test>', Subject: 'Contact form', 'Message-ID': '<form1@acme.test>' }, 'Please call me.'))
  assert.ok(result?.created)
  const conv = conversations.getConversation(result.conversationId)
  assert.equal(conv.customer.email, 'lee@customer.test')
  assert.equal(conv.customer.name, 'Lee Wong')
})

test('a follow-up still threads after the conversation moved to another mailbox', async () => {
  const other = run(`INSERT INTO mailboxes (name, email, created_at) VALUES ('Billing', 'billing@acme.test', 1)`).id
  const first = await ingestRaw(mailboxId, eml({ From: 'Ana <ana@customer.test>', Subject: 'Invoice', 'Message-ID': '<a1@customer.test>' }, 'Where is my invoice?'))
  conversations.updateConversation(first!.conversationId, { mailboxId: other }, { userId: agentId, via: 'web' })
  const second = await ingestRaw(mailboxId, eml({ From: 'Ana <ana@customer.test>', Subject: 'Re: Invoice', 'Message-ID': '<a2@customer.test>', 'In-Reply-To': '<a1@customer.test>' }, 'Any news?'))
  assert.equal(second?.conversationId, first!.conversationId)
  assert.equal(conversations.getSummary(first!.conversationId).mailboxId, other)
})

test('a spoofed Date header does not backdate live mail, and bad input is rejected', async () => {
  const result = await ingestRaw(mailboxId, eml({ From: 'Old <old@customer.test>', Subject: 'Dated', 'Message-ID': '<d1@customer.test>', Date: 'Mon, 1 Jan 2001 10:00:00 +0000' }, 'hello'))
  assert.ok(Date.now() - conversations.getSummary(result!.conversationId).createdAt < 5000)
  assert.throws(() => conversations.createConversation({ mailboxId, customerEmail: 'x@customer.test', subject: 's', bodyHtml: '<p>b</p>', kind: 'note', status: 'archived' as never }, { userId: agentId, via: 'api' }), /Status must be/)
  assert.throws(() => conversations.createConversation({ mailboxId, customerEmail: 'x@customer.test', subject: 's', bodyHtml: '<p>b</p>', kind: 'note', assigneeId: 9999 }, { userId: agentId, via: 'api' }), /teammate/)
})

test('a customer reply releases a conversation from a deactivated teammate', async () => {
  const gone = run(`INSERT INTO users (name, email, password_hash, role, disabled, created_at) VALUES ('Gone', 'gone@acme.test', 'x', 'agent', 0, 1)`).id
  const created = conversations.createConversation({ mailboxId, customerEmail: 'zed@customer.test', subject: 'Old ticket', bodyHtml: '<p>Help</p>', kind: 'customer', assigneeId: gone }, { userId: null, via: 'email' })
  run('UPDATE users SET disabled = 1 WHERE id = ?', gone)
  const customerId = conversations.getSummary(created.id).customer.id
  conversations.addCustomerMessage(created.id, { customerId, bodyHtml: '<p>Still broken</p>' })
  assert.equal(conversations.getSummary(created.id).assignee, null)
})

test('apps: static sidebar fills placeholders safely, webhooks are signed', async () => {
  const http = await import('node:http')
  const crypto = await import('node:crypto')
  const apps = await import('../services/apps.ts')
  const received: { event: string; signature: string; body: string }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ event: String(req.headers['x-ansa-event']), signature: String(req.headers['x-ansa-signature']), body })
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  try {
    apps.createApp({ name: 'Links', sidebarMode: 'static', sidebarContent: '[Admin](https://admin.test/u?email={{customer.email|url}})\n\nHello {{customer.name}}' })
    const hook = apps.createApp({ name: 'Hook', webhookUrl: `http://127.0.0.1:${port}/hook`, events: ['conversation.created', 'conversation.status_changed'] })
    assert.throws(() => apps.createApp({ name: 'Bad', webhookUrl: 'ftp://x', events: ['conversation.created'] }))

    const { id } = conversations.createConversation(
      { mailboxId, customerEmail: 'eve+x@apps.test', customerName: 'Eve <script>alert(1)</script>', subject: 'Apps', bodyHtml: '<p>Hi</p>', kind: 'customer' },
      { userId: null, via: 'email' },
    )
    conversations.updateConversation(id, { status: 'closed' }, { userId: agentId, via: 'web' })

    const panels = await apps.sidebarsFor(id)
    const links = panels.find((p) => p.name === 'Links')!
    assert.ok(links.html.includes('href="https://admin.test/u?email=eve%2Bx%40apps.test"'), links.html)
    assert.ok(links.html.includes('>Admin</a>'), links.html)
    assert.ok(!links.html.includes('<script'), 'customer data cannot inject markup')

    for (let i = 0; i < 40 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(received.map((r) => r.event).sort(), ['conversation.created', 'conversation.status_changed'])
    for (const r of received) {
      assert.equal(r.signature, 'sha256=' + crypto.createHmac('sha256', hook.secret).update(r.body).digest('hex'))
      assert.equal(JSON.parse(r.body).customer.email, 'eve+x@apps.test')
    }
    assert.deepEqual(JSON.parse(received.find((r) => r.event === 'conversation.status_changed')!.body).change.to, 'closed')
    assert.equal(apps.listDeliveries(hook.id).filter((d) => d.ok).length, 2)
  } finally {
    server.close()
  }
})

test('help desk notification emails keep only the newest message', () => {
  const item = (who: string, verb: string, body: string) =>
    `<tr><td><table><tr><td><table><tr><td><h3 style="margin:0"><span><strong>${who}</strong> ${verb}</span></h3></td><td><div>Nov 10, 10:15pm</div></td></tr><tr><td colspan="2">&nbsp;</td></tr><tr><td colspan="2" style="padding:0"><div>${body}</div></td></tr></table></td></tr></table></td></tr>`
  const mail = `<table><tr><td><table><tr><td><p>-- Please reply above this line --</p></td></tr></table><table><tr><td><p><strong>Jane Doe</strong> replied to conversation <a href="https://desk.test/conversation/7">#7</a></p></td></tr>${item('Jane Doe', 'replied', '<div>Newest message</div><table><tr><td>a cell</td></tr></table>')}<tr><td><table><tr><td><table><tr><td><div>Sam assigned to you</div></td><td><div>Nov 8</div></td></tr></table></td></tr></table></td></tr>${item('Sam Agent', 'added a note', 'Older note')}${item('Jane Doe', 'started the conversation', 'First message')}<tr><td><p><a href="https://desk.test/users/notifications/7">Notification Settings</a></p></td></tr></table></td></tr></table>`
  const out = html.stripHelpdeskNotification(mail)!
  const text = html.htmlToText(out)
  assert.ok(text.includes('Newest message') && text.includes('a cell'), text)
  assert.ok(!/Older note|First message|assigned to you|Notification Settings|reply above/.test(text), text)
  // A single message still ends at the footer.
  const single = html.htmlToText(html.stripHelpdeskNotification(mail.replace(item('Sam Agent', 'added a note', 'Older note'), '').replace(item('Jane Doe', 'started the conversation', 'First message'), '').replace(/<tr><td><table><tr><td><table><tr><td><div>Sam assigned.*?<\/table><\/td><\/tr><\/table><\/td><\/tr>/, ''))!)
  assert.ok(single.includes('Newest message') && !single.includes('Notification Settings'), single)
  // Ordinary mail is left alone, even when it mentions the marker phrase.
  assert.equal(html.stripHelpdeskNotification('<p>Please reply above this line</p><p>Hello</p>'), null)
  assert.equal(html.stripHelpdeskNotification('<h3><strong>Jane</strong> replied</h3><p>Hello</p>'), null)
})

test('notification email shows the conversation newest first and escapes content', async () => {
  const { renderNotification } = await import('../services/notify.ts')
  const { id } = conversations.createConversation(
    { mailboxId, customerEmail: 'nora@notify.test', customerName: 'Nora <i>N</i>', subject: 'Invoice <b>question</b>', bodyHtml: '<p>First message</p>', kind: 'customer' },
    { userId: null, via: 'email' },
  )
  conversations.addNote(id, { bodyHtml: '<p>Internal note</p>' }, { userId: agentId, via: 'web' })
  conversations.updateConversation(id, { assigneeId: agentId, status: 'pending' }, { userId: agentId, via: 'web' })
  const out = renderNotification({ appUrl: 'https://ansa.test', viewerId: agentId, leadHtml: 'x', conversation: conversations.getConversation(id) })
  assert.ok(out.includes('Invoice &lt;b&gt;question&lt;/b&gt;') && !out.includes('<b>question</b>'))
  assert.ok(out.includes('PENDING') && out.includes('Assigned to you') && out.includes(`https://ansa.test/c/${id}`))
  assert.ok(out.includes('assigned to you') && out.includes('marked as Pending') && out.includes('added a note') && out.includes('started the conversation'))
  assert.ok(out.indexOf('Internal note') < out.indexOf('First message'), 'newest first')
})

test('workspace features: mentions always work; four statuses are off until enabled', async () => {
  const workspace = await import('../services/workspace.ts')
  const other = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Ann Lee', 'ann@acme.test', 'x', 'agent', 1)`).id
  const shortName = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Ann', 'ann2@acme.test', 'x', 'agent', 1)`).id
  const make = () =>
    conversations.createConversation({ mailboxId, customerEmail: 'wes@features.test', subject: 'Features', bodyHtml: '<p>Hi</p>', kind: 'customer' }, { userId: null, via: 'email' }).id
  const mentionedIn = (userId: number) => conversations.listConversations({ mailboxId, folder: 'mentioned', me: userId }).items.map((c) => c.id)

  // The folder setting is off, but the mention is still recorded. A customer answer makes the conversation active.
  const first = make()
  conversations.addNote(first, { bodyHtml: '<p>@Ann Lee please look</p>' }, { userId: agentId, via: 'web' })
  assert.deepEqual(mentionedIn(other), [first])
  conversations.addReply(first, { bodyHtml: '<p>On it</p>', status: 'pending', skipDelivery: true }, { userId: agentId, via: 'web' })
  conversations.addCustomerMessage(first, { customerId: get<{ customer_id: number }>('SELECT customer_id FROM conversations WHERE id = ?', first)!.customer_id, bodyHtml: '<p>Thanks</p>' })
  assert.equal(conversations.getSummary(first).status, 'active')

  workspace.saveWorkspace({ mentions: true, fourStatuses: true })
  try {
    const second = make()
    assert.equal(conversations.getSummary(second).status, 'active', 'a new conversation starts active')
    conversations.addNote(second, { bodyHtml: '<p>Hey <strong>@Ann Lee</strong> can you check? cc @nobody</p>' }, { userId: agentId, via: 'web' })
    assert.deepEqual(mentionedIn(other).sort(), [first, second].sort())
    assert.deepEqual(mentionedIn(shortName), [], '"@Ann Lee" does not also mention "Ann"')
    const third = make()
    conversations.addNote(third, { bodyHtml: '<p>Mail team@ann.example or ask @Annabel. Not a mention.</p>' }, { userId: agentId, via: 'web' })
    assert.ok(!mentionedIn(shortName).includes(third), 'an email address or a longer name is not a mention')
    conversations.addNote(third, { bodyHtml: '<p>Thanks @Ann, and (@ann lee).</p>' }, { userId: agentId, via: 'web' })
    assert.ok(mentionedIn(shortName).includes(third) && mentionedIn(other).includes(third), 'a mention can end with punctuation')
    conversations.updateConversation(third, { status: 'closed' }, { userId: agentId, via: 'web' })
    assert.deepEqual(mentionedIn(agentId), [], 'the author is not mentioned')
    assert.equal(conversations.folderCounts(other).find((c) => c.mailboxId === mailboxId)?.mentioned, 2)

    conversations.addReply(second, { bodyHtml: '<p>Checking</p>', status: 'pending', skipDelivery: true }, { userId: agentId, via: 'web' })
    assert.equal(conversations.getSummary(second).status, 'pending')
    conversations.updateConversation(second, { assigneeId: agentId }, { userId: agentId, via: 'web' })
    const inFolder = (folder: 'mine' | 'pending') => conversations.listConversations({ mailboxId, folder, me: agentId }).items.some((c) => c.id === second)
    assert.deepEqual([inFolder('mine'), inFolder('pending')], [false, true], 'waiting on customer leaves Mine')
    conversations.addCustomerMessage(second, { customerId: get<{ customer_id: number }>('SELECT customer_id FROM conversations WHERE id = ?', second)!.customer_id, bodyHtml: '<p>Any news?</p>' })
    assert.equal(conversations.getSummary(second).status, 'waiting', 'a customer answer puts it on our side')
    assert.deepEqual([inFolder('mine'), inFolder('pending')], [true, false], 'waiting on me is in Mine')
    assert.equal(workspace.statusLabel('waiting'), 'Waiting on me')
    assert.equal(workspace.statusLabel('pending'), 'Waiting on customer')

    // Closing the conversation takes it out of the Mentioned folder.
    conversations.updateConversation(second, { status: 'closed' }, { userId: agentId, via: 'web' })
    assert.deepEqual(mentionedIn(other), [first])
  } finally {
    workspace.saveWorkspace({ mentions: false, fourStatuses: false })
  }
  assert.equal(workspace.statusLabel('pending'), 'Pending')
  assert.equal(workspace.brandName(), 'Ansa')
  workspace.saveWorkspace({ brandName: 'Acme Desk' })
  assert.equal(workspace.brandName(), 'Acme Desk')
  workspace.saveWorkspace({ brandName: '' })
})

test('Help Scout import: conversations, threads, tags, files; skips spam; safe to repeat', async () => {
  const http = await import('node:http')
  const hsImport = await import('../services/import-helpscout.ts')
  const person = (id: number, type: string, first: string, last: string, email: string) => ({ id, type, first, last, email })
  const jane = person(500, 'customer', 'Jane', 'Doe', 'jane@hs-import.test')
  const tyler = person(900, 'user', 'Tyler', 'Channell', 'tyler@hs-import.test')
  const thread = (id: number, type: string, by: object, body: string, at: string, extra: object = {}) => ({ id, type, status: 'active', state: 'published', body, createdBy: by, createdAt: at, ...extra })
  const fixtures = [
    {
      id: 1001, number: 84966, threads: 3, status: 'closed', state: 'published', subject: 'New launch form', createdAt: '2026-11-07T01:16:00Z', closedAt: '2026-11-07T09:59:00Z', primaryCustomer: jane, assignee: tyler, tags: [{ tag: 'launch' }, { tag: 'vip' }], cc: ['boss@hs-import.test'],
      _embedded: { threads: [
        thread(3, 'message', tyler, '<p>This should be all set!</p><script>x()</script>', '2026-11-07T09:59:00Z', { status: 'closed', to: ['jane@hs-import.test'], _embedded: { attachments: [{ id: 77, filename: 'shot.txt', mimeType: 'text/plain', size: 5, state: 'valid' }] } }),
        thread(1, 'customer', jane, 'Very handy guide. <b>Thank you!</b>', '2026-11-07T01:16:00Z'),
        thread(2, 'note', tyler, 'Internal: check with design', '2026-11-07T05:00:00Z'),
        thread(4, 'lineitem', tyler, '', '2026-11-07T10:00:00Z'),
      ] },
    },
    { id: 1002, number: 84967, threads: 1, status: 'spam', state: 'published', subject: 'Buy now', createdAt: '2026-11-08T00:00:00Z', primaryCustomer: person(501, 'customer', 'Spam', 'Bot', 'spam@hs-import.test'), _embedded: { threads: [thread(9, 'customer', jane, 'spam', '2026-11-08T00:00:00Z')] } },
    { id: 1003, number: 84968, threads: 2, status: 'active', state: 'published', subject: 'Question', createdAt: '2026-11-09T00:00:00Z', primaryCustomer: { id: 502, type: 'customer', first: 'No', last: 'Email' }, _embedded: { threads: [thread(10, 'customer', { id: 502, type: 'customer' }, 'First', '2026-11-09T00:00:00Z')] } },
  ]
  let tokens = 0
  let throttled = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(data))
    if (url.pathname === '/v2/oauth2/token') {
      tokens++
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => (body.includes('client_secret=good') ? json({ access_token: 'tok', expires_in: 172800 }) : json({ error: 'invalid_client' }, 401)))
      return
    }
    if (req.headers.authorization !== 'Bearer tok') return json({}, 401)
    if (url.pathname === '/v2/mailboxes') return json({ _embedded: { mailboxes: [{ id: 13, name: 'PaywallProject', email: 'help@hs-import.test' }] }, page: { number: 1, size: 50, totalElements: 1, totalPages: 1 } })
    if (url.pathname === '/v2/conversations') {
      if (url.searchParams.get('embed') && !throttled) {
        throttled = true
        return json({}, 429, { 'X-RateLimit-Retry-After': '1' })
      }
      const page = Number(url.searchParams.get('page') || 1)
      // Two per page, to exercise paging.
      return json({ _embedded: { conversations: fixtures.slice((page - 1) * 2, page * 2) }, page: { number: page, size: 2, totalElements: 3, totalPages: 2 } })
    }
    if (url.pathname === '/v2/conversations/1003/threads') return json({ _embedded: { threads: [thread(10, 'customer', { id: 502, type: 'customer' }, 'First', '2026-11-09T00:00:00Z'), thread(11, 'customer', { id: 502, type: 'customer' }, 'Second, fetched separately', '2026-11-09T01:00:00Z')] }, page: { number: 1, size: 25, totalElements: 2, totalPages: 1 } })
    if (url.pathname === '/v2/conversations/1001/attachments/77/data') return json({ data: Buffer.from('hello').toString('base64') })
    json({}, 404)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  process.env.HELPSCOUT_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await assert.rejects(() => hsImport.connectHelpScout('app', 'bad'), /did not accept/)
    const inboxes = await hsImport.connectHelpScout('app', 'good')
    assert.deepEqual(inboxes, [{ id: 13, name: 'PaywallProject', email: 'help@hs-import.test', conversations: 3 }])

    await hsImport.startImport({ appId: 'app', appSecret: 'good', attachments: true, inboxes: [{ hsId: 13, name: 'PaywallProject', email: 'help@hs-import.test', mailboxId: null }] })
    for (let i = 0; i < 100 && hsImport.importStatus().status === 'running'; i++) await new Promise((r) => setTimeout(r, 100))
    const state = hsImport.importStatus()
    assert.equal(state.status, 'done', state.message ?? '')
    assert.deepEqual([state.imported, state.skipped, state.files], [2, 1, 1])
    assert.ok(!('secretEnc' in state) && !JSON.stringify(state).includes('good'), 'credentials are not exposed')

    const box = get<{ id: number }>(`SELECT id FROM mailboxes WHERE email = 'help@hs-import.test'`)!
    const list = conversations.listConversations({ mailboxId: box.id, folder: 'all', sort: 'oldest' }).items
    assert.deepEqual(list.map((c) => [c.subject, c.status]), [['New launch form', 'closed'], ['Question', 'active']])
    const first = conversations.getConversation(list[0].id)
    assert.deepEqual(first.threads.map((t) => [t.type, t.author.name]), [['customer', 'Jane Doe'], ['note', 'Tyler Channell'], ['reply', 'Tyler Channell']])
    assert.ok(!first.threads[2].bodyHtml.includes('script'))
    assert.equal(first.threads[2].event?.status, 'closed')
    assert.equal(first.threads[2].attachments[0].filename, 'shot.txt')
    assert.deepEqual(first.tags.map((t) => t.name).sort(), ['launch', 'vip'])
    assert.equal(first.createdAt, Date.parse('2026-11-07T01:16:00Z'))
    assert.equal(get<{ disabled: number }>(`SELECT disabled FROM users WHERE email = 'tyler@hs-import.test'`)?.disabled, 1, 'unknown Help Scout users become disabled teammates')
    const second = conversations.getConversation(list[1].id)
    assert.equal(second.threads.length, 2, 'cut-off thread lists are fetched in full')
    assert.ok(second.waitingSince, 'an open conversation that ends with the customer is waiting')
    assert.equal(conversations.listConversations({ q: 'handy guide' }).items[0]?.id, list[0].id, 'imported text is searchable')

    // Running it again brings in nothing new.
    await hsImport.startImport({ appId: 'app', appSecret: 'good', attachments: true, inboxes: [{ hsId: 13, name: 'PaywallProject', email: 'help@hs-import.test', mailboxId: box.id }] })
    for (let i = 0; i < 100 && hsImport.importStatus().status === 'running'; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(hsImport.importStatus().imported, 0)
    assert.equal(conversations.listConversations({ mailboxId: box.id, folder: 'all' }).total, 2)
    assert.ok(tokens >= 3)
  } finally {
    delete process.env.HELPSCOUT_API
    server.close()
  }
})

test('merging customers moves conversations and addresses to one profile', async () => {
  const customers = await import('../services/customers.ts')
  const make = (email: string, name: string, subject: string) =>
    conversations.createConversation({ mailboxId, customerEmail: email, customerName: name, subject, bodyHtml: '<p>Hi</p>', kind: 'customer' }, { userId: null, via: 'email' }).id
  const work = make('sam@work.test', 'Sam Rivers', 'From work')
  const home = make('sam@home.test', 'Sammy', 'From home')
  const target = conversations.getConversation(work).customer
  const source = conversations.getConversation(home).customer
  customers.updateCustomer(source.id, { phone: '555-0100', notes: 'Prefers calls' })
  assert.throws(() => customers.updateCustomer(target.id, { emails: ['sam@work.test', 'sam@home.test'] }), /another customer/)

  conversations.mergeCustomers(target.id, source.id)
  const merged = customers.getCustomer(target.id)
  assert.deepEqual(merged.emails, ['sam@work.test', 'sam@home.test'])
  assert.deepEqual([merged.name, merged.phone, merged.notes, merged.conversationCount], ['Sam Rivers', '555-0100', 'Prefers calls', 2])
  assert.equal(conversations.getConversation(home).customer.id, target.id)
  assert.throws(() => customers.getCustomer(source.id), /not found/)
  assert.ok(conversations.listConversations({ q: 'Rivers' }).items.some((c) => c.id === home), 'search finds the moved conversation by the new name')
  // New mail from the second address now lands with the same customer.
  assert.equal(customers.findOrCreateCustomer('sam@home.test').id, target.id)
  // The primary address can be switched.
  assert.equal(customers.updateCustomer(target.id, { emails: ['sam@home.test', 'sam@work.test'] }).email, 'sam@home.test')
})

test('send later: a scheduled reply waits, goes out when due, and holds back if the customer writes first', async () => {
  const actor = { userId: agentId, via: 'web' as const }
  const open = (email: string) => conversations.createConversation({ mailboxId, customerEmail: email, subject: 'Later', bodyHtml: '<p>Help</p>', kind: 'customer' }, { userId: null, via: 'email' }).id
  const soon = Date.now() + 3_600_000

  // Scheduled: nothing changes for the customer or the status yet.
  const a = open('later-a@acme.test')
  const ta = conversations.addReply(a, { bodyHtml: '<div>See you tomorrow</div>', status: 'closed', sendAt: soon }, actor)
  let conv = conversations.getConversation(a)
  let thread = conv.threads.find((t) => t.id === ta)!
  assert.deepEqual([thread.state, thread.sendAt, conv.status, conv.assignee?.id], ['scheduled', soon, 'active', agentId])
  assert.ok(conv.waitingSince, 'the customer is still waiting')
  await conversations.dispatchScheduled()
  assert.equal(conversations.getConversation(a).threads.find((t) => t.id === ta)!.state, 'scheduled', 'not due yet')

  // Due: it becomes an ordinary reply and applies its status.
  run('UPDATE threads SET send_at = ? WHERE id = ?', Date.now() - 1000, ta)
  await conversations.dispatchScheduled()
  conv = conversations.getConversation(a)
  thread = conv.threads.find((t) => t.id === ta)!
  assert.deepEqual([thread.state, thread.sendAt, conv.status, conv.waitingSince, conv.threadCount], ['sent', null, 'closed', null, 2])

  // "If no reply": the customer writes first, so it is held, and can still be sent by hand.
  const b = open('later-b@acme.test')
  const tb = conversations.addReply(b, { bodyHtml: '<div>Any news?</div>', status: 'pending', sendAt: soon, ifNoReply: true }, actor)
  const customerId = conversations.getConversation(b).customer.id
  conversations.addCustomerMessage(b, { customerId, bodyHtml: '<p>Fixed it myself</p>' })
  thread = conversations.getConversation(b).threads.find((t) => t.id === tb)!
  assert.deepEqual([thread.state, thread.sendAt, thread.event?.held], ['scheduled', null, true])
  run('UPDATE threads SET created_at = created_at - 5000 WHERE id = ?', tb)
  await conversations.dispatchScheduled()
  assert.equal(conversations.getConversation(b).threads.find((t) => t.id === tb)!.state, 'scheduled', 'a held reply never sends by itself')
  conversations.sendScheduledNow(tb, actor)
  conv = conversations.getConversation(b)
  assert.deepEqual([conv.threads.at(-1)!.id, conv.threads.at(-1)!.state, conv.status], [tb, 'sent', 'pending'])

  // "Always": a customer message does not stop it. Cancelling returns the text as a draft.
  const c = open('later-c@acme.test')
  const tc = conversations.addReply(c, { bodyHtml: '<div>Reminder</div>', sendAt: soon }, actor)
  conversations.addCustomerMessage(c, { customerId: conversations.getConversation(c).customer.id, bodyHtml: '<p>Hello?</p>' })
  assert.equal(conversations.getConversation(c).threads.find((t) => t.id === tc)!.sendAt, soon)
  conversations.cancelScheduled(tc, actor)
  conv = conversations.getConversation(c, { userId: agentId })
  assert.ok(!conv.threads.some((t) => t.id === tc))
  assert.deepEqual([conv.drafts[0]?.bodyHtml, conv.threadCount], ['<div>Reminder</div>', 2])
  assert.throws(() => conversations.sendScheduledNow(tc, actor), /not waiting/)
})

test('collision check: a teammate reply sent after you started writing is reported, your own is not', async () => {
  const other = run('INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'Tyler Teammate', 'tyler@ansa.test', 'x', 'agent', '#0a7', Date.now()).id as number
  const id = conversations.createConversation({ mailboxId, customerEmail: 'twice@acme.test', subject: 'Twice', bodyHtml: '<p>Help</p>', kind: 'customer' }, { userId: null, via: 'email' }).id
  const started = Math.max(...conversations.getConversation(id).threads.map((t) => t.id))
  assert.equal(conversations.teammateReplyAfter(id, started, agentId), null)

  // A scheduled reply has not reached the customer, so it is no collision yet.
  conversations.addReply(id, { bodyHtml: '<div>Later</div>', sendAt: Date.now() + 3_600_000 }, { userId: other, via: 'web' })
  assert.equal(conversations.teammateReplyAfter(id, started, agentId), null)

  conversations.addReply(id, { bodyHtml: '<div>Fixed</div>' }, { userId: other, via: 'web' })
  assert.equal(conversations.teammateReplyAfter(id, started, agentId)?.name, 'Tyler Teammate')
  assert.equal(conversations.teammateReplyAfter(id, started, other), null, 'your own reply is not a collision')
})

test('drafts: a reply draft and a note draft live side by side, and each goes away with its own kind', async () => {
  const id = conversations.createConversation({ mailboxId, customerEmail: 'drafts@acme.test', subject: 'Drafts', bodyHtml: '<p>Help</p>', kind: 'customer' }, { userId: null, via: 'email' }).id
  const mine = () => conversations.getConversation(id, { userId: agentId }).drafts.map((d) => [d.kind, d.bodyHtml])
  conversations.saveDraft(id, agentId, 'reply', '<p>Answer</p>')
  conversations.saveDraft(id, agentId, 'note', '<p>Check billing</p>')
  assert.deepEqual(mine(), [['reply', '<p>Answer</p>'], ['note', '<p>Check billing</p>']])
  conversations.saveDraft(id, agentId, 'note', '')
  assert.deepEqual(mine(), [['reply', '<p>Answer</p>']])
  conversations.saveDraft(id, agentId, 'note', '<p>Again</p>')
  conversations.addReply(id, { bodyHtml: '<div>Answer</div>' }, { userId: agentId, via: 'web' })
  assert.deepEqual(mine(), [['note', '<p>Again</p>']], 'sending the reply keeps the note draft')
})
