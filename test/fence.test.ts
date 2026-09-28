import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRequest, isLoopbackRemoteAddress } from '../src/panel/fence.js'

const PORT = 3456
const base = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3456' } }

test('only loopback peers pass', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isLoopbackRemoteAddress(address), true, address)
  }
  for (const address of [undefined, '192.168.1.2', '::ffff:10.0.0.1', '10.0.0.1', '::2']) {
    assert.equal(isLoopbackRemoteAddress(address), false, String(address))
  }
})

test('reads need a loopback Host on our port and no cross-site fetch', () => {
  assert.deepEqual(checkRequest(base, PORT, 'read'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { host: 'localhost:3456', 'sec-fetch-site': 'none' } }, PORT, 'read'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { host: 'evil.example:3456' } }, PORT, 'read'), { ok: false, reason: 'host' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:9999' } }, PORT, 'read'), { ok: false, reason: 'host' })
  assert.deepEqual(checkRequest({ ...base, remoteAddress: '192.168.1.2' }, PORT, 'read'), { ok: false, reason: 'peer' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', 'sec-fetch-site': 'cross-site' } }, PORT, 'read'), { ok: false, reason: 'fetch-site' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', 'sec-fetch-site': 'same-site' } }, PORT, 'read'), { ok: false, reason: 'fetch-site' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'http://evil.example' } }, PORT, 'read'), { ok: false, reason: 'origin' })
})

test('mutations need our exact Origin and a JSON body', () => {
  const ok = { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456', 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' }
  assert.deepEqual(checkRequest({ ...base, headers: ok }, PORT, 'mutate'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, host: 'localhost:3456', origin: 'http://localhost:3456' } }, PORT, 'mutate'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, origin: undefined } }, PORT, 'mutate'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, origin: 'http://evil.example' } }, PORT, 'mutate'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, 'content-type': 'text/plain' } }, PORT, 'mutate'), { ok: false, reason: 'content-type' })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, 'sec-fetch-site': 'same-site' } }, PORT, 'mutate'), { ok: false, reason: 'fetch-site' })
})

test('WebSocket upgrades need our Origin but no content type', () => {
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456' } }, PORT, 'upgrade'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'null' } }, PORT, 'upgrade'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456' } }, PORT, 'upgrade'), { ok: false, reason: 'origin' })
})

test('Origin is bound to the validated Host, not any allowed authority', () => {
  // Host/Origin mismatch: different names for same port
  assert.deepEqual(checkRequest({ ...base, headers: { host: 'localhost:3456', origin: 'http://127.0.0.1:3456', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, PORT, 'mutate'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'http://localhost:3456', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, PORT, 'mutate'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: 'localhost:3456', origin: 'http://127.0.0.1:3456' } }, PORT, 'upgrade'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'http://localhost:3456' } }, PORT, 'upgrade'), { ok: false, reason: 'origin' })
  // Same IP but different port
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, PORT, 'mutate'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:5173' } }, PORT, 'upgrade'), { ok: false, reason: 'origin' })
})

test('IPv6 loopback address is rejected as a Host header', () => {
  assert.deepEqual(checkRequest({ ...base, headers: { host: '[::1]:3456' } }, PORT, 'read'), { ok: false, reason: 'host' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '[::1]:3456', origin: 'http://[::1]:3456' } }, PORT, 'mutate'), { ok: false, reason: 'host' })
})
