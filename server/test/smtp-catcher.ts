// By hand: npx tsx server/test/smtp-catcher.ts 2525 prints each message it accepts.
import net from 'node:net'
import { simpleParser } from 'mailparser'

export interface CaughtMail {
  to: string
  subject: string
  text: string
}

export async function startSmtpCatcher(port = 0): Promise<{ port: number; inbox: CaughtMail[]; close: () => Promise<void> }> {
  const inbox: CaughtMail[] = []
  const server = net.createServer((socket) => {
    let buffer = ''
    let inData = false
    socket.setEncoding('utf8')
    socket.write('220 catcher ESMTP\r\n')
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          const raw = buffer.slice(0, end).replace(/^\.\./gm, '.')
          buffer = buffer.slice(end + 5)
          inData = false
          void simpleParser(raw).then((mail) => {
            const to = [mail.to ?? []].flat()[0]?.value[0]?.address ?? ''
            inbox.push({ to, subject: mail.subject ?? '', text: mail.text ?? '' })
            socket.write('250 kept\r\n')
          })
          continue
        }
        const line = buffer.indexOf('\r\n')
        if (line < 0) return
        const command = buffer.slice(0, line).toUpperCase()
        buffer = buffer.slice(line + 2)
        if (command.startsWith('EHLO') || command.startsWith('HELO')) socket.write('250 catcher\r\n')
        else if (command.startsWith('DATA')) {
          inData = true
          socket.write('354 go ahead\r\n')
        } else if (command.startsWith('QUIT')) socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    inbox,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const catcher = await startSmtpCatcher(Number(process.argv[2]) || 2525)
  console.log(`Catching mail on 127.0.0.1:${catcher.port}`)
  let seen = 0
  setInterval(() => {
    for (const mail of catcher.inbox.slice(seen)) console.log(`\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`)
    seen = catcher.inbox.length
  }, 200)
}
