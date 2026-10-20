const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { Client } = require('colyseus.js')

const root = path.resolve(__dirname, '..')
const serverDir = path.join(root, 'server')
const tsNode = path.join(root, 'node_modules', '.bin', 'ts-node')
const RoomType = { LOBBY: 'lobby', PUBLIC: 'skyoffice', CUSTOM: 'custom' }
const Message = { UPDATE_PLAYER_NAME: 1, ADD_CHAT_MESSAGE: 10, SEND_ROOM_DATA: 11 }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`)
    try {
      await fetch(`${baseUrl}/colyseus`)
      return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('server did not start within 10 seconds')
}

async function startServer(credentials) {
  const port = await freePort()
  const child = spawn(tsNode, ['--project', 'tsconfig.server.json', 'index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), MONITOR_USERNAME: credentials?.username || '', MONITOR_PASSWORD: credentials?.password || '' },
    stdio: 'inherit',
  })
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitForServer(baseUrl, child)
    return { child, baseUrl, port }
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

async function checkMonitorDisabled() {
  const server = await startServer()
  try {
    const response = await fetch(`${server.baseUrl}/colyseus`)
    if (response.status !== 404) throw new Error(`monitor without credentials returned ${response.status}, expected 404`)
    console.log('PASS monitor disabled without credentials: HTTP 404')
  } finally { await stopServer(server.child) }
}

async function checkAuthenticatedLifecycle() {
  const creds = { username: 'smoke-user', password: 'smoke-secret' }
  const server = await startServer(creds)
  try {
    const url = `${server.baseUrl}/colyseus`
    const noAuth = await fetch(url)
    const badAuth = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from('smoke-user:wrong').toString('base64')}` } })
    const goodAuth = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}` } })
    if (noAuth.status !== 401 || badAuth.status !== 401 || goodAuth.status !== 200) {
      throw new Error(`monitor statuses were unauth=${noAuth.status}, bad=${badAuth.status}, good=${goodAuth.status}; expected 401/401/200`)
    }
    for (const value of ['smoke-user:smoke-secre', 'smoke-user:smoke-secret-extra', 'smoke-user:smoke-secret\0', 'smoke-user\0:smoke-secret']) {
      const denied = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(value).toString('base64')}` } })
      if (denied.status !== 401) throw new Error('monitor accepted altered credential bytes')
    }
    console.log('PASS monitor auth: missing 401, incorrect 401, correct 200')

    const client = new Client(`ws://127.0.0.1:${server.port}`)
    const lobby = await client.joinOrCreate(RoomType.LOBBY)
    const publicRoom = await client.joinOrCreate(RoomType.PUBLIC)
    let roomData
    publicRoom.onMessage(Message.SEND_ROOM_DATA, data => { roomData = data })
    await new Promise(resolve => setTimeout(resolve, 150))
    if (roomData?.name !== 'Public Lobby') throw new Error('public room data message missing')
    publicRoom.send(Message.UPDATE_PLAYER_NAME, { name: 'Lifecycle Check' })
    publicRoom.send(Message.ADD_CHAT_MESSAGE, { content: 'hello lifecycle' })
    await new Promise(resolve => setTimeout(resolve, 150))
    if (publicRoom.state.players.get(publicRoom.sessionId)?.name !== 'Lifecycle Check') throw new Error('player update missing')
    if (publicRoom.state.chatMessages.length !== 1 || publicRoom.state.chatMessages[0].content !== 'hello lifecycle') throw new Error('chat message missing')
    const custom = await client.create(RoomType.CUSTOM, { name: 'Protected', description: 'test', password: 'room-secret', autoDispose: true })
    let rejected = false
    try { await client.joinById(custom.roomId, { password: 'wrong' }) } catch { rejected = true }
    if (!rejected) throw new Error('incorrect room password accepted')
    const accepted = await client.joinById(custom.roomId, { password: 'room-secret' })
    await accepted.leave()
    await custom.leave()
    await publicRoom.leave()
    await lobby.leave()
    console.log('PASS lifecycle: lobby/public/custom join, room/player/chat messages and state, wrong password rejected, correct password accepted, disconnect')
  } finally { await stopServer(server.child) }
}

;(async () => {
  await checkMonitorDisabled()
  await checkAuthenticatedLifecycle()
})().catch(() => { console.error('Security smoke test failed; inspect the last lifecycle step locally.'); process.exitCode = 1 })
