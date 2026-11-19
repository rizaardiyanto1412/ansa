// Imported before the store, so the store's workspace tag is already on each line this sees.
export const logged: string[] = []

for (const level of ['log', 'error'] as const) {
  const write = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    if (logged.length < 500) logged.push(args.map(String).join(' '))
    write(...args)
  }
}
