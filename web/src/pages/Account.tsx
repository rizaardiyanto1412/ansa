import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useDocumentTitle } from '../lib/hooks'
import { place } from '../lib/workspace'
import { Banner, Button, Field, Input, Spinner } from '../ui'
import { AuthCard } from './Auth'

interface LinkInfo {
  purpose: 'sign_in' | 'invite' | 'reset'
  email: string
  name: string
  needsName: boolean
  needsPassword: boolean
}

const backToSignIn = (
  <Link to="/" className="self-center text-[13px] font-medium text-fg-2 hover:text-fg hover:underline">
    Back to sign in
  </Link>
)

function linkCopy(link: LinkInfo): { title: string; subtitle: string; action: string } {
  if (link.purpose === 'invite') return { title: `Join ${place()}`, subtitle: 'Choose your name and a password', action: 'Join the team' }
  if (link.purpose === 'reset') return { title: 'Choose a new password', subtitle: `For your account at ${place()}`, action: 'Save and sign in' }
  if (link.needsPassword) return { title: `Welcome to ${place()}`, subtitle: 'Choose a password to finish your account', action: 'Save and sign in' }
  return { title: `Sign in to ${place()}`, subtitle: `Continue as ${link.name}`, action: 'Sign in' }
}

export function LinkPage({ token, passwordMin }: { token: string; passwordMin: number }) {
  useDocumentTitle('Sign in')
  const link = useQuery({
    queryKey: ['link', token],
    queryFn: () => api.post<{ link: LinkInfo }>('/links/inspect', { token }).then((r) => r.link),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (link.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    )
  }
  if (link.isError) {
    return (
      <AuthCard title="This link no longer works" subtitle="One-time links work once and expire after 24 hours">
        <div className="flex flex-col gap-4">
          <Banner kind="warn">{link.error.message}</Banner>
          <Link to="/forgot" className="self-center text-[13px] font-medium text-accent-fg hover:underline">
            Email me a new link
          </Link>
          {backToSignIn}
        </div>
      </AuthCard>
    )
  }

  const info = link.data
  const copy = linkCopy(info)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/links/consume', { token, name: info.needsName ? name : undefined, password: info.needsPassword ? password : undefined })
      // A full load drops anything cached for whoever was signed in here before.
      window.location.replace('/')
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <AuthCard title={copy.title} subtitle={copy.subtitle}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Banner kind="danger">{error}</Banner>}
        {info.needsPassword && <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" readOnly value={info.email} />}</Field>}
        {info.needsName && <Field label="Your name">{(id) => <Input id={id} autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>}
        {info.needsPassword && (
          <Field label="Password" hint={`At least ${passwordMin} characters.`}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" required autoFocus={!info.needsName} minLength={passwordMin} value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          {copy.action}
        </Button>
      </form>
    </AuthCard>
  )
}

export function ForgotPassword() {
  useDocumentTitle('Forgot password')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/password/forgot', { email })
      setSent(true)
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }
  return (
    <AuthCard title="Forgot your password?" subtitle="We email you a link to choose a new one">
      {sent ? (
        <div className="flex flex-col gap-4">
          <Banner kind="ok">If {email} belongs to a teammate here, a link is on its way. It works once, for 24 hours.</Banner>
          {backToSignIn}
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error && <Banner kind="danger">{error}</Banner>}
          <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" size="lg" loading={busy}>
            Email me a link
          </Button>
          {backToSignIn}
        </form>
      )}
    </AuthCard>
  )
}
