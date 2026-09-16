import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { CONTROL_CHANNEL, controlRoute } from '../index.js'

let server
let port
const connection = { requestRejection: req => (req.headers.cookie === 'dsh=ok' ? undefined : 401) }
const dispatch = async (endpoint, payload) => endpoint === 'status'
  ? { ok: true, value: { echoed: payload } }
  : { ok: false, error: { code: 'tailscale-remote/unknown-endpoint', message: endpoint, details: {} } }

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path, headers }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

before(async () => {
  server = createServer((req, res) => { void controlRoute(req, res, connection, dispatch) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})
after(() => new Promise(resolve => server.close(resolve)))

describe('control route', () => {
  it('applies the DSH gate before reading anything', async () => {
    assert.equal((await post(`${CONTROL_CHANNEL}/status`, '{}')).status, 401)
  })
  it('speaks the Connection envelope', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'status', payload: { args: { a: 1 } } })
    const res = await post(`${CONTROL_CHANNEL}/status`, body, { cookie: 'dsh=ok', 'content-type': 'application/json' })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), { type: 'server-response', rpcId: 'r1', result: { ok: true, value: { echoed: { args: { a: 1 } } } } })
  })
  it('rejects a method/endpoint mismatch, bad JSON and nested endpoints', async () => {
    const mismatch = JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'enable', payload: {} })
    assert.equal((await post(`${CONTROL_CHANNEL}/status`, mismatch, { cookie: 'dsh=ok' })).status, 400)
    assert.equal((await post(`${CONTROL_CHANNEL}/status`, '{nope', { cookie: 'dsh=ok' })).status, 400)
    assert.equal((await post(`${CONTROL_CHANNEL}/a/b`, '{}', { cookie: 'dsh=ok' })).status, 404)
  })
})
