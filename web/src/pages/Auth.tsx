import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useDocumentTitle } from '../lib/hooks'
import { Banner, Button, Field, Input } from '../ui'
import { brand, place, workspace } from '../lib/workspace'

/** The workspace logo when one is uploaded, otherwise the built-in mark. */
export const Logo = ({ size = 28 }: { size?: number }) =>
  workspace().logoUrl ? (
    <img src={workspace().logoUrl!} alt="" style={{ height: size, maxWidth: size * 5 }} className="w-auto shrink-0 rounded-md object-contain" />
  ) : (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <rect width="32" height="32" rx="8" fill="var(--accent)" />
    <path d="M9 11.5A3.5 3.5 0 0 1 12.5 8h7A3.5 3.5 0 0 1 23 11.5v5a3.5 3.5 0 0 1-3.5 3.5H15l-4.2 3.3a.5.5 0 0 1-.8-.4V19.7A3.5 3.5 0 0 1 9 16.5z" fill="#fff" />
    <circle cx="13.2" cy="14" r="1.25" fill="var(--accent)" />
    <circle cx="18.8" cy="14" r="1.25" fill="var(--accent)" />
  </svg>
  )

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={40} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-fg-3">{subtitle}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">{children}</div>
      </div>
    </main>
  )
}

export function Login({ onDone }: { onDone: () => void }) {
  useDocumentTitle('Sign in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/login', { email, password })
      onDone()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <AuthCard title={`Sign in to ${place()}`} subtitle="Your team's shared inbox">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Sign in
        </Button>
        <Link to="/forgot" className="self-center text-[13px] font-medium text-fg-2 hover:text-fg hover:underline">
          Forgot your password?
        </Link>
      </form>
    </AuthCard>
  )
}

export function Setup({ onDone }: { onDone: () => void }) {
  useDocumentTitle('Set up')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/setup', form)
      onDone()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })
  return (
    <AuthCard title={`Welcome to ${brand()}`} subtitle="Create the first admin account to get started">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="Your name">{(id) => <Input id={id} autoComplete="name" required autoFocus value={form.name} onChange={set('name')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required value={form.email} onChange={set('email')} />}</Field>
        <Field label="Password" hint="At least 8 characters.">
          {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthCard>
  )
}
