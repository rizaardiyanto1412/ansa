import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const state = {
  buttons: [] as { children: unknown; onClick?: () => Promise<void> }[],
  posts: [] as unknown[],
  confirmations: [] as { body: string }[],
  confirmed: false,
  billing: {} as unknown,
}
const result = await build({
  stdin: {
    contents: `export { Message } from './web/src/inbox/ConversationView'; export { BillingSettings, trialDaysLeft } from './web/src/settings/Billing';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  plugins: [{
    name: 'hosted-ui-environment',
    setup(build) {
      build.onLoad({ filter: /ConversationView\.tsx$/ }, async ({ path: file }) => ({ contents: `${await fs.readFile(file, 'utf8')}\nexport { Message };`, loader: 'tsx' }))
      build.onResolve({ filter: /^(test:state|@tanstack\/react-query|\.\.\/ui|\.\.\/lib\/api)$/ }, ({ path: name }) => name === 'test:state' ? { path: name, external: true } : { path: name, namespace: 'fixture' })
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: name === '@tanstack/react-query' ? `
        import state from 'test:state';
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = () => ({ data: state.billing });
        export const useMutation = ({ mutationFn }) => ({ mutate: value => mutationFn(value) });
      ` : name === '../lib/api' ? `
        import state from 'test:state';
        export { ApiError } from ${JSON.stringify(path.resolve('web/src/lib/api.ts'))};
        export const api = { post: (...args) => { state.posts.push(args); return Promise.resolve({}); } };
        export const qs = () => '';
      ` : `
        import React from 'react';
        import state from 'test:state';
        export * from ${JSON.stringify(path.resolve('web/src/ui.tsx'))};
        export const Button = props => { state.buttons.push(props); return React.createElement('button', { onClick: props.onClick }, props.children); };
        export const useFeedback = () => ({ toast() {}, confirm: async options => { state.confirmations.push(options); return state.confirmed; } });
      `, resolveDir: process.cwd() }))
    },
  }],
})
const module = { exports: {} as { Message: unknown; BillingSettings: unknown; trialDaysLeft: (plan: unknown, at: number) => number | null } }
new Function('require', 'module', 'exports', result.outputFiles[0].text)((name: string) => name === 'test:state' ? state : require(name), module, module.exports)
const ui = module.exports

test('an uncertain reply warns about delivery and requires confirmation before Send again', async () => {
  const thread = {
    id: 42, type: 'reply', state: 'uncertain', bodyHtml: '<p>Answer</p>', attachments: [], to: ['cara@customer.test'], cc: [], bcc: [],
    author: { kind: 'user', name: 'Ada' }, createdAt: Date.now(), via: 'web', error: 'Delivery could not be confirmed.',
  }
  state.buttons = []
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let html: string
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ innerHTML: '', content: { firstChild: null, lastChild: null } }) } })
    html = renderToStaticMarkup(React.createElement(ui.Message, { thread, folded: false, onToggle() {} }))
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
  assert.match(html, /This reply may have been delivered\./)
  const resend = state.buttons.find((button) => button.children === 'Send again')
  assert.ok(resend?.onClick)
  await resend.onClick()
  assert.equal(state.confirmations.length, 1)
  assert.match(state.confirmations[0].body, /may already have received/)
  assert.equal(state.posts.length, 0, 'canceling confirmation sends no request')
  state.confirmed = true
  await resend.onClick()
  assert.deepEqual(state.posts, [['/threads/42/retry', { confirm: true }]])
})

test('billing shows days left from the optional control-plane trial deadline', () => {
  const at = Date.now()
  const plan = { plan: 'trial', trialEndsAt: at + 2.5 * 86_400_000, mailboxLimit: 2, readOnly: false, hourlySendLimit: 100 }
  state.billing = { plan, mailboxes: 1, links: { checkout: {}, portal: null } }
  const html = renderToStaticMarkup(React.createElement(ui.BillingSettings))
  assert.match(html, /3 days left/)
  assert.equal(ui.trialDaysLeft({ ...plan, trialEndsAt: at - 1 }, at), 0, 'expired trials do not show negative days')
  assert.equal(ui.trialDaysLeft({ ...plan, trialEndsAt: undefined }, at), null, 'older control planes may omit the deadline')
  assert.equal(ui.trialDaysLeft({ ...plan, plan: 'team' }, at), null, 'paid plans do not show trial days')
})
