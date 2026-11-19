import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useSession } from '../lib/hooks'
import type { Billing, PlanState } from '../lib/types'
import { Banner, Button, Card, PageHeader, Spinner } from '../ui'

const PLAN_NAME: Record<PlanState['plan'], string> = { trial: 'Free trial', starter: 'Starter', team: 'Team', business: 'Business' }
const DAY = 86_400_000

export const trialDaysLeft = (plan: PlanState, now = Date.now()) => (plan.plan === 'trial' && plan.trialEndsAt ? Math.max(0, Math.ceil((plan.trialEndsAt - now) / DAY)) : null)

function checkoutLabel(key: string): string {
  const [plan, interval] = key.split(/[_-]/)
  const name = PLAN_NAME[plan as PlanState['plan']] ?? plan.charAt(0).toUpperCase() + plan.slice(1)
  const every = interval === 'annual' || interval === 'yearly' ? 'yearly' : interval === 'monthly' ? 'monthly' : interval
  return every ? `${name}, ${every}` : name
}

export function PlanBanner() {
  const { hosted, plan, user } = useSession()
  if (!hosted || !plan) return null
  const days = trialDaysLeft(plan)
  if (!plan.readOnly && plan.plan !== 'trial') return null
  const action =
    user.role === 'admin' ? (
      <Link to="/settings/billing" className="shrink-0 font-medium underline">
        Choose a plan
      </Link>
    ) : null
  return (
    <div role="status" className={plan.readOnly ? 'flex flex-wrap items-center justify-center gap-x-3 bg-danger-soft px-4 py-1.5 text-[13px] text-danger' : 'flex flex-wrap items-center justify-center gap-x-3 bg-accent-soft px-4 py-1.5 text-[13px] text-accent-fg'}>
      <span>
        {plan.readOnly
          ? 'This workspace is read-only. New email still arrives, but replies are not sent until a plan is chosen.'
          : days === null
            ? 'You are on the free trial.'
            : days === 0
              ? 'Your free trial ends today.'
              : `Your free trial ends in ${plural(days, 'day')}.`}
      </span>
      {action ?? (plan.readOnly ? <span>Ask an admin to choose a plan.</span> : null)}
    </div>
  )
}

export function BillingSettings() {
  const billing = useQuery({ queryKey: ['billing'], queryFn: () => api.get<Billing>('/billing'), staleTime: 60_000 })
  if (billing.isPending) return <Spinner />
  if (billing.isError) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Billing" />
        <Banner kind="danger">{(billing.error as Error).message}</Banner>
      </div>
    )
  }
  const { plan, mailboxes, links } = billing.data
  const days = trialDaysLeft(plan)
  const offers = Object.entries(links.checkout)
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Billing" description="Your plan and what it includes." />
      {plan.readOnly && <Banner kind="danger">This workspace is read-only. New email still arrives and everything stays readable, but replies are not sent. Choose a plan to send again.</Banner>}
      <Card className="p-5">
        <dl className="grid gap-5 sm:grid-cols-3">
          <div>
            <dt className="text-[13px] text-fg-3">Plan</dt>
            <dd className="mt-0.5 text-lg font-semibold">{PLAN_NAME[plan.plan]}</dd>
            {days !== null && <dd className="text-[13px] text-fg-3">{days === 0 ? 'Ends today' : `${plural(days, 'day')} left`}</dd>}
          </div>
          <div>
            <dt className="text-[13px] text-fg-3">Mailboxes</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{plan.mailboxLimit === null ? mailboxes : `${mailboxes} of ${plan.mailboxLimit}`}</dd>
            <dd className="text-[13px] text-fg-3">{plan.mailboxLimit === null ? 'Unlimited' : mailboxes >= plan.mailboxLimit ? 'Limit reached' : 'In use'}</dd>
          </div>
          <div>
            <dt className="text-[13px] text-fg-3">Teammates and conversations</dt>
            <dd className="mt-0.5 text-lg font-semibold">Unlimited</dd>
            <dd className="text-[13px] text-fg-3">On every plan</dd>
          </div>
        </dl>
      </Card>
      {offers.length > 0 && (
        <Card className="p-5">
          <h2 className="text-[15px] font-semibold">{plan.plan === 'trial' ? 'Choose a plan' : 'Change plan'}</h2>
          <p className="mt-0.5 text-[13px] text-fg-3">Payment opens on a secure checkout page. Yearly plans include two months free.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {offers.map(([key, url]) => (
              <a key={key} href={url}>
                <Button variant={key.startsWith('team') ? 'primary' : 'secondary'}>{checkoutLabel(key)}</Button>
              </a>
            ))}
          </div>
        </Card>
      )}
      {links.portal && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <h2 className="text-[15px] font-semibold">Invoices and payment method</h2>
            <p className="text-[13px] text-fg-3">Change your card, download invoices or cancel.</p>
          </div>
          <a href={links.portal}>
            <Button>Open billing portal</Button>
          </a>
        </Card>
      )}
      {offers.length === 0 && !links.portal && <p className="text-[13px] text-fg-3">No billing actions are available for this workspace right now.</p>}
    </div>
  )
}
