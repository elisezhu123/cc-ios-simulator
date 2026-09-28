// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/stream-routes.ts (transport fence)
/**
 * Transport fence for the panel server, ported from dsh-ios
 * src/stream-routes.ts (isLoopbackRemoteAddress & co): a loopback peer, a
 * loopback Host naming OUR port (DNS rebinding), and — for anything that
 * changes state or opens the control socket — our exact Origin, plus a JSON
 * content type on POSTs (which forces a CORS preflight on foreign pages).
 * @module ios-simulator/panel/fence
 */

export type FenceKind = 'read' | 'mutate' | 'upgrade'

export interface FenceRequest {
  remoteAddress: string | undefined
  headers: Readonly<Record<string, string | string[] | undefined>>
}

export type FenceVerdict =
  | { ok: true }
  | { ok: false; reason: 'peer' | 'host' | 'origin' | 'fetch-site' | 'content-type' }

function isIpv4LoopbackAddress(address: string): boolean {
  const parts = address.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Trust the transport peer, never caller-controlled host data. Node may expose
 * an IPv4 peer directly or as an IPv4-mapped IPv6 address (also in the compact
 * hexadecimal form).
 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0] ?? ''
  if (normalized === '::1' || isIpv4LoopbackAddress(normalized)) return true
  if (!normalized.startsWith('::ffff:')) return false
  const mapped = normalized.slice('::ffff:'.length)
  if (isIpv4LoopbackAddress(mapped)) return true
  const hexadecimal = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/u.exec(mapped)
  return hexadecimal !== null && (Number.parseInt(hexadecimal[1] ?? '0', 16) >>> 8) === 127
}

function header(request: FenceRequest, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** The loopback authorities this panel answers to on `port`. */
export function allowedAuthorities(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`]
}

export function checkRequest(request: FenceRequest, port: number, kind: FenceKind): FenceVerdict {
  if (!isLoopbackRemoteAddress(request.remoteAddress)) return { ok: false, reason: 'peer' }
  const authorities = allowedAuthorities(port)
  const host = header(request, 'host')?.toLowerCase()
  if (host === undefined || !authorities.includes(host)) return { ok: false, reason: 'host' }
  const site = header(request, 'sec-fetch-site')
  const origin = header(request, 'origin')
  const originOk = origin !== undefined && origin.toLowerCase() === `http://${host}`
  if (kind === 'read') {
    // `none` is a user-initiated navigation (typing the URL, preview_start).
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'fetch-site' }
    if (origin !== undefined && !originOk) return { ok: false, reason: 'origin' }
    return { ok: true }
  }
  if (!originOk) return { ok: false, reason: 'origin' }
  if (site !== undefined && site !== 'same-origin') return { ok: false, reason: 'fetch-site' }
  if (kind === 'mutate') {
    const type = header(request, 'content-type')
    if (type === undefined || !/^application\/json\s*(;|$)/iu.test(type)) return { ok: false, reason: 'content-type' }
  }
  return { ok: true }
}
