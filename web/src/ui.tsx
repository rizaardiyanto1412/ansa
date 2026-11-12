import { STATUS_LABEL } from './lib/format'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Check, CircleAlert, CircleCheck, LoaderCircle, X } from 'lucide-react'
import { colorFor, initials } from './lib/format'

export const cx = clsx

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
}

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover shadow-card',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-sunken shadow-card',
  ghost: 'text-fg-2 hover:bg-hover hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90 shadow-card',
}
const SIZE = { sm: 'h-7 px-2.5 text-[13px] gap-1.5', md: 'h-8 px-3 text-[13px] gap-1.5', lg: 'h-10 px-4 text-sm gap-2' }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:opacity-50',
        BUTTON[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
})

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, active, size = 'md', className, children, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-8',
        active && 'bg-accent-soft text-accent-fg hover:bg-accent-soft hover:text-accent-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

// ---------------------------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------------------------

const CONTROL =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-fg-3 transition-shadow focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:bg-sunken disabled:text-fg-3'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(CONTROL, 'h-9', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(CONTROL, 'min-h-20 py-2 leading-relaxed', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(CONTROL, 'h-9 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8', className)} style={{ backgroundImage: CHEVRON }} {...rest}>
      {children}
    </select>
  )
})
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2371717c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string }) {
  const id = useId()
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-fg">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-[13px] text-danger">{error}</p> : hint ? <p className="text-[13px] text-fg-3">{hint}</p> : null}
    </div>
  )
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </button>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {description && <span className="block text-[13px] text-fg-3">{description}</span>}
      </label>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Small display pieces
// ---------------------------------------------------------------------------------------------

export function Avatar({ name, color, size = 28, className }: { name: string; color?: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)), background: color || colorFor(name) }}
    >
      {initials(name)}
    </span>
  )
}

/**
 * Teammates who have a conversation open. A grey ring means the person is reading.
 * An accent ring with moving dots means the person is writing a reply.
 */
export function PresenceAvatars({ viewers, size = 20, max = 3, className }: { viewers: { userId: number; name: string; color: string; state: 'viewing' | 'replying' }[]; size?: number; max?: number; className?: string }) {
  if (viewers.length === 0) return null
  // People who write come first: they are the ones to know about.
  const sorted = [...viewers].sort((a, b) => Number(b.state === 'replying') - Number(a.state === 'replying'))
  const shown = sorted.slice(0, max)
  const label = sorted.map((v) => `${v.name} is ${v.state === 'replying' ? 'writing a reply' : 'viewing'}`).join('. ')
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1.5 p-[3px]', className)} role="img" aria-label={label}>
      {shown.map((v) => (
        <span key={v.userId} className={cx('presence', v.state === 'replying' && 'presence-replying')} title={`${v.name} is ${v.state === 'replying' ? 'writing a reply' : 'viewing'}`}>
          <Avatar name={v.name} color={v.color} size={size} />
          {v.state === 'replying' && (
            <span className="presence-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          )}
        </span>
      ))}
      {sorted.length > max && <span className="text-xs font-medium text-fg-3">+{sorted.length - max}</span>}
    </span>
  )
}

export const Spinner = ({ className }: { className?: string }) => <LoaderCircle className={cx('size-4 animate-spin text-fg-3', className)} aria-label="Loading" />

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface px-1 font-sans text-[11px] font-medium text-fg-2">{children}</kbd>
)

export function TagChip({ name, color, onRemove }: { name: string; color: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex h-5 max-w-40 items-center gap-1 rounded-md bg-sunken pr-1.5 pl-1.5 text-xs font-medium text-fg-2">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove tag ${name}`} className="-mr-0.5 rounded text-fg-3 hover:text-fg">
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-ok-soft text-ok',
  waiting: 'bg-accent-soft text-accent-fg',
  pending: 'bg-warn-soft text-warn',
  closed: 'bg-sunken text-fg-2',
  spam: 'bg-danger-soft text-danger',
}
export const StatusBadge = ({ status, className }: { status: string; className?: string }) => (
  <span className={cx('inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap', STATUS_STYLE[status], className)}>{STATUS_LABEL[status] ?? status}</span>
)

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-sunken text-fg-3 [&>svg]:size-5">{icon}</div>}
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-fg-3">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Banner({ kind = 'info', children, action }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const style = { info: 'bg-accent-soft text-accent-fg', warn: 'bg-warn-soft text-warn', danger: 'bg-danger-soft text-danger', ok: 'bg-ok-soft text-ok' }[kind]
  const Icon = kind === 'ok' ? CircleCheck : CircleAlert
  return (
    <div role={kind === 'danger' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]', style)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Popover and menu
// ---------------------------------------------------------------------------------------------

interface PopoverProps {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' | 'dialog'; ref: (el: HTMLElement | null) => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  width?: number
  open?: boolean
  onOpenChange?: (open: boolean) => void
  role?: 'menu' | 'dialog'
}

export function Popover({ trigger, children, align = 'start', side = 'bottom', width, open: controlled, onOpenChange, role = 'menu' }: PopoverProps) {
  const [inner, setInner] = useState(false)
  const open = controlled ?? inner
  const setOpen = useCallback(
    (value: boolean) => {
      setInner(value)
      onOpenChange?.(value)
    },
    [onOpenChange],
  )
  const anchor = useRef<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return setPos(null)
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const p = panel.current?.getBoundingClientRect()
      if (!a || !p) return
      const gap = 6
      let top = side === 'bottom' ? a.bottom + gap : a.top - p.height - gap
      if (side === 'bottom' && top + p.height > window.innerHeight - 8 && a.top - p.height - gap > 8) top = a.top - p.height - gap
      if (side === 'top' && top < 8) top = a.bottom + gap
      let left = align === 'start' ? a.left : a.right - p.width
      left = Math.min(Math.max(8, left), window.innerWidth - p.width - 8)
      setPos({ top: Math.max(8, top), left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, align, side])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        anchor.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, setOpen])

  return (
    <>
      {trigger({ onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-haspopup': role, ref: (el) => (anchor.current = el) })}
      {open &&
        createPortal(
          <div
            ref={panel}
            role={role}
            className="animate-pop fixed z-50 max-h-[min(420px,calc(100vh-16px))] overflow-y-auto rounded-xl bg-surface p-1 shadow-pop"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, minWidth: 180, visibility: pos ? 'visible' : 'hidden' }}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  )
}

export function MenuItem({
  icon,
  children,
  onSelect,
  danger,
  checked,
  hint,
  disabled,
}: {
  icon?: ReactNode
  children: ReactNode
  onSelect: () => void
  danger?: boolean
  checked?: boolean
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cx(
        'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-fg hover:bg-hover [&>svg]:text-fg-3',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
      {checked && <Check className="!text-accent-fg" aria-label="Selected" />}
    </button>
  )
}

export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-fg-3">{children}</div>
export const MenuDivider = () => <div className="my-1 h-px bg-line" role="separator" />

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, [contenteditable=true]')
    ;(first ?? panel.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable=true]')].filter(
          (el) => !el.hasAttribute('disabled'),
        )
        if (items.length === 0) return
        const firstItem = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          firstItem.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  if (!open) return null
  return createPortal(
    <div className="animate-fade fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="animate-pop w-full rounded-2xl bg-surface shadow-pop outline-none" style={{ maxWidth: width }}>
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {title}
            </h2>
            {description && <p className="mt-1 text-sm text-fg-3">{description}</p>}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose} className="-mt-1 -mr-1">
            <X className="size-4" />
          </IconButton>
        </div>
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && <div className="flex justify-end gap-2 px-5 pb-5">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------------------------
// Toasts and confirm dialogs
// ---------------------------------------------------------------------------------------------

interface Toast {
  id: number
  message: string
  kind: 'ok' | 'error'
  action?: { label: string; run: () => void }
}
interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel: string
  danger?: boolean
}
interface Feedback {
  toast: (message: string, options?: { kind?: 'ok' | 'error'; action?: Toast['action'] }) => void
  confirm: (options: ConfirmOptions) => Promise<boolean>
}
const FeedbackContext = createContext<Feedback>({ toast: () => {}, confirm: async () => false })
export const useFeedback = () => useContext(FeedbackContext)

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)
  const nextId = useRef(1)

  const toast = useCallback<Feedback['toast']>((message, options) => {
    const id = nextId.current++
    setToasts((list) => [...list.slice(-2), { id, message, kind: options?.kind ?? 'ok', action: options?.action }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), options?.kind === 'error' ? 7000 : 4000)
  }, [])
  const confirm = useCallback<Feedback['confirm']>((options) => new Promise((resolve) => setPending({ ...options, resolve })), [])
  const answer = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      <Modal
        open={!!pending}
        onClose={() => answer(false)}
        title={pending?.title ?? ''}
        description={pending?.body}
        width={420}
        footer={
          <>
            <Button onClick={() => answer(false)}>Cancel</Button>
            <Button variant={pending?.danger ? 'danger' : 'primary'} onClick={() => answer(true)} autoFocus>
              {pending?.confirmLabel}
            </Button>
          </>
        }
      />
      {createPortal(
        <div className="safe-shift pointer-events-none fixed inset-x-0 top-16 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className="animate-toast pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl bg-fg py-2.5 pr-3 pl-3.5 text-[13px] font-medium text-surface shadow-pop">
              {t.kind === 'error' ? <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden /> : <CircleCheck className="size-4 shrink-0 text-ok" aria-hidden />}
              <span>{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  className="ml-1 rounded px-1.5 py-0.5 font-semibold underline underline-offset-2"
                  onClick={() => {
                    t.action!.run()
                    setToasts((list) => list.filter((x) => x.id !== t.id))
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </FeedbackContext.Provider>
  )
}

/** Page heading used by Customers, Reports and Settings. */
export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-fg-3">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-line bg-surface shadow-card', className)}>{children}</div>
}
