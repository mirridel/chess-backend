const express = require('express')
const http = require('http')
const socketio = require('socket.io')
const gameLogic = require('./game-logic')
const app = express()


const server = http.createServer(app)
const io = socketio(server)

io.on('connection', client => {
    gameLogic.initializeGame(io, client)
})

// usually this is where we try to connect to our DB.
server.listen(process.env.PORT || 8000)