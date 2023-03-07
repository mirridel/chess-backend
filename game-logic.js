var io
var gameSocket
var gamesInSession = []

const crypto = require("crypto");

var available_rooms = [];

var rooms = {};

class Player {
    constructor(pid, socket) {
        this.pid = pid;
        this.socket = socket;
    }
}

class Room {
    constructor(host) {
        this.room_id = crypto.randomUUID()
        this.first_player = host;
        this.second_player = null;
        this.game_id = null;
    }

    get to_json(){
        return {"room_id": this.room_id,
            "first_player": this.first_player.pid,
            "second_player": this.second_player.pid,
            "game_id": this.game_id}
    }
}

const initializeGame = (sio, socket, db, pid) => {

    io = sio
    gameSocket = socket

    gameSocket.on('hello', hello_handler);

    function hello_handler() {
        gameSocket.emit("hello", "hello in game_engine!")
    }

    console.log("Were there! 1")

    // Не торт
    // pushes this socket to an array which stores all the active sockets.
    gamesInSession.push(gameSocket)

    // Run code when the client disconnects from their socket session. 
    gameSocket.on("disconnect", onDisconnect)

    gameSocket.on("quick_game", quick_game)

    // Sends new move to the other socket session in the same room. 
    gameSocket.on("new move", newMove)

    // User creates new game room after clicking 'submit' on the frontend
    gameSocket.on("createNewGame", createNewGame)

    // User joins gameRoom after going to a URL with '/game/:gameId' 
    gameSocket.on("playerJoinGame", playerJoinsGame)

    gameSocket.on('request username', requestUserName)

    gameSocket.on('recieved userName', recievedUserName)

    gameSocket.on('get_user_information', get_user_information_handler)

    // Обработчик окончания игры
    function end_game_handler(start_game_handler, result ='', history ='') {
        start_game_handler.then(_data => {
            // Сначала меняем поле 'status' на true в таблице 'game_sessions'
            db.tx(t => {
                return t.query('UPDATE game_sessions SET status = true WHERE id = $1', parseInt(_data['id']));
            })
                .then(data => {
                    // COMMIT
                })
                .catch(error => {
                    // ROLLBACK
                });
            // Затем добавляем запись об окончании игры в таблицу 'game_storage'
            db.tx(t => {
                const now = new Date();
                const entity = {
                    'id': -1,
                    'game_session_id': parseInt(_data['id']),
                    'end_date': now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate(),
                    'end_time': now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds(),
                    'result': result,
                    'history': history,
                }
                const query = 'INSERT INTO game_storage(game_session_id, end_date, end_time, result, history)' +
                    'VALUES(${game_session_id}, ${end_date}, ${end_time}, ${result}, ${history}) RETURNING id';
                return t.one(query, entity);
            })
                .then(data => {
                    // COMMIT
                })
                .catch(error => {
                    // ROLLBACK
                });
        })
            .catch(error => {
                console.error(error)
            })
    }

    // Функция для получения информации об игроке.
    function get_user_information_handler(input_data) {
        return db.tx(t => {
            const entity = {'id': input_data['id']}
            const query = 'SELECT id, username FROM users WHERE id = ${id}';
            return t.one(query, entity);
        })
            .then(data => {
                // COMMIT
                gameSocket.emit("get_user_information", {"id": data.id, "username": data.username})
            })
            .catch(error => {
                // ROLLBACK
                gameSocket.emit("get_user_information", {"id": -1})
            });
    }

    // Обработчик начала игры.
    function start_game_handler(first_player_id, second_player_id) {
        return db.tx(t => {
            const now = new Date();
            const entity = {
                'id': -1,
                'first_player_id': first_player_id,
                'second_player_id': second_player_id,
                'start_date': now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate(),
                'start_time': now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds(),
                'status': false
            }
            const query = 'INSERT INTO game_sessions(first_player_id, second_player_id, start_date, start_time, status)' +
                'VALUES(${first_player_id}, ${second_player_id}, ${start_date}, ${start_time}, ${status}) RETURNING id';
            return t.one(query, entity);
        })
            .then(data => {
                return data;
                // COMMIT
            })
            .catch(error => {
                console.log(error)
                // ROLLBACK
            });
    }

    // Нужно передать id пользователя, который был получен при авторизации.
    // Так делать нельзя, но мы говнокодим.
    function quick_game(input_data) {
        let room = null;
        // Создаем новую комнату, если нет свободных.
        if (available_rooms.length === 0) {
            // Добавляем первого игрока (хоста) в комнату.
            room = new Room(new Player(input_data['id'], this));
            this.emit('creating_room', {gameId: room.room_id});
            this.join(room.room_id);
            // Добавляем комнату в "поиск".
            available_rooms.push(room)
        } else {
            // Находим свободную комнату.
            room = available_rooms[0];
            // Добавляем второго игрока в комнату.
            room.second_player = new Player(input_data['id'], this);
            this.emit('joining_room', {gameId: room.room_id});
            this.join(room.room_id)
            // Удаляем комнату из "поиска".
            available_rooms = available_rooms.filter(x => {
                return x.room_id !== room.room_id;
            })
            // Добавляем запись о начале игры в БД. Получаем ID игры.
            start_game_handler(room.first_player.pid, room.second_player.pid).then(_data => {
                room.game_id = _data.id;
                room.first_player.socket.emit('start_game', room.to_json);
                room.second_player.socket.emit('start_game', room.to_json);
            });
            // добавляем комнату в словарь (dict).
            rooms[room.room_id] = room;
        }
    }
}


function playerJoinsGame(idData) {
    // A reference to the player's Socket.IO socket object
    var sock = this

    // Look up the room ID in the Socket.IO manager object.
    var room = io.sockets.adapter.rooms[idData.gameId]
    // console.log(room)

    // If the room exists...
    if (room === undefined) {
        this.emit('status', "This game session does not exist.");
        return
    }
    if (room.length < 2) {
        // attach the socket id to the data object.
        idData.mySocketId = sock.id;

        // Join the room
        sock.join(idData.gameId);

        console.log(room.length)

        if (room.length === 2) {
            io.sockets.in(idData.gameId).emit('start game', idData.userName)
        }

        // Emit an event notifying the clients that the player has joined the room.
        io.sockets.in(idData.gameId).emit('playerJoinedRoom', idData);

    } else {
        // Otherwise, send an error message back to the player.
        this.emit('status', "There are already 2 people playing in this room.");
    }
}

function createNewGame(gameId) {
    console.log({gameId: gameId, mySocketId: this.id})
    // Return the Room ID (gameId) and the socket ID (mySocketId) to the browser client
    this.emit('createNewGame', {gameId: gameId, mySocketId: this.id});

    // Join the Room and wait for the other player
    this.join(gameId)
}


function newMove(move) {
    const gameId = move.gameId

    io.to(gameId).emit('opponent move', move);
}


function onDisconnect() {
    var i = gamesInSession.indexOf(gameSocket);
    gamesInSession.splice(i, 1);
}


function requestUserName(gameId) {
    io.to(gameId).emit('give userName', this.id);
}


function recievedUserName(data) {
    data.socketId = this.id
    io.to(data.gameId).emit('get Opponent UserName', data);
}


exports.initializeGame = initializeGame