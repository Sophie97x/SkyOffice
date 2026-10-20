import http from 'http'
import { timingSafeEqual } from 'crypto'
import express from 'express'
import cors from 'cors'
import { Server, LobbyRoom } from 'colyseus'
import { monitor } from '@colyseus/monitor'
import { RoomType } from '../types/Rooms'

// import socialRoutes from "@colyseus/social/express"

import { SkyOffice } from './rooms/SkyOffice'

const port = Number(process.env.PORT || 2567)
const app = express()

app.use(cors())
app.use(express.json())
// app.use(express.static('dist'))

const server = http.createServer(app)
const gameServer = new Server({
  server,
})

// register room handlers
gameServer.define(RoomType.LOBBY, LobbyRoom)
gameServer.define(RoomType.PUBLIC, SkyOffice, {
  name: 'Public Lobby',
  description: 'For making friends and familiarizing yourself with the controls',
  password: null,
  autoDispose: false,
})
gameServer.define(RoomType.CUSTOM, SkyOffice).enableRealtimeListing()

/**
 * Register @colyseus/social routes
 *
 * - uncomment if you want to use default authentication (https://docs.colyseus.io/server/authentication/)
 * - also uncomment the import statement
 */
// app.use("/", socialRoutes);

// Register the monitor only when both credentials are explicitly configured.
// Deploy behind an HTTPS reverse proxy; Basic credentials are only base64 encoded.
const monitorUsername = process.env.MONITOR_USERNAME
const monitorPassword = process.env.MONITOR_PASSWORD
// Compare raw credential bytes without storing a fast password hash. Padding keeps
// timingSafeEqual inputs equal-sized; the length check rejects padded/truncated values.
function equalCredential(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8')
  const actualBytes = Buffer.from(actual, 'utf8')
  const padded = Buffer.alloc(expectedBytes.length)
  actualBytes.copy(padded)
  const bytesMatch = timingSafeEqual(expectedBytes, padded)
  return bytesMatch && actualBytes.length === expectedBytes.length
}
if (monitorUsername && monitorPassword) {

  app.use('/colyseus', (req, res, next) => {
    const authorization = req.headers.authorization || ''
    const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)
    let supplied = ''
    if (match) {
      try {
        supplied = Buffer.from(match[1], 'base64').toString('utf8')
      } catch {
        supplied = ''
      }
    }
    const separator = supplied.indexOf(':')
    const username = separator < 0 ? '' : supplied.slice(0, separator)
    const password = separator < 0 ? '' : supplied.slice(separator + 1)
    const usernameMatches = equalCredential(monitorUsername, username)
    const passwordMatches = equalCredential(monitorPassword, password)

    if (separator < 0 || !usernameMatches || !passwordMatches) {
      res.setHeader('WWW-Authenticate', 'Basic realm="SkyOffice monitor"')
      res.sendStatus(401)
      return
    }
    next()
  }, monitor())
} else {
  console.warn('Colyseus monitor disabled because credentials are not configured.')
}

gameServer.listen(port)
console.log(`Listening on ws://localhost:${port}`)
