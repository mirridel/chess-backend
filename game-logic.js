var io
var gameSocket

const crypto = require("crypto");

var available_rooms = [];

var authorized_users = {};

var rooms = [];

class Player {
    constructor(pid, socket) {
        this.pid = pid;
        this.socket = socket;
    }

    get to_json() {
        return {"pid": this.pid};
    }
}

class Room {
    constructor(host) {
        this.room_id = crypto.randomUUID()
        this.first_player = host;
        this.second_player = null;
    }

    get to_json(){
        return {"room_id": this.room_id,
            "first_player": this.first_player.to_json,
            "second_player": this.second_player.to_json
            }
    }
}

const initializeGame = (sio, socket, db, pid) => {

    io = sio
    gameSocket = socket

    gameSocket.on('hello', hello_handler);

    function hello_handler() {
        gameSocket.emit("hello", "hello in game_engine!")
    }

    authorized_users[socket.id] = pid;

    gameSocket.on("start_quick_game", start_quick_game)
    gameSocket.on("end_quick_game", end_quick_game)

    // Run code when the client disconnects from their socket session. 
    gameSocket.on("disconnect", onDisconnect)

    // Sends new move to the other socket session in the same room. 
    gameSocket.on("new move", newMove)

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
            const query = 'WITH inserted AS (INSERT INTO game_sessions(first_player_id, second_player_id, start_date, start_time, status) ' +
                'VALUES(${first_player_id}, ${second_player_id}, ${start_date}, ${start_time}, ${status}) RETURNING *) ' +
                'SELECT inserted.id, user1.username AS first_player, user2.username AS second_player ' +
                'FROM inserted ' +
                'LEFT JOIN users as user1 ON inserted.first_player_id=user1.id ' +
                'LEFT JOIN users as user2 ON inserted.second_player_id=user2.id ';
            return t.one(query, entity);
        })
            .then(data => {
                // COMMIT
                return data;
            })
            .catch(error => {
                // ROLLBACK\
                console.log(error);
            });
    }

    // Обработчик окончания игры
    function end_game_handler(game_id, result ='', history ='') {
        // Сначала меняем поле 'status' на true в таблице 'game_sessions'
        db.tx(t => {
            return t.query('UPDATE game_sessions SET status = true WHERE id = $1',game_id);
        })
            .then(data => {
                return data;
                // COMMIT
            })
            .catch(error => {
                // ROLLBACK
            });
        // Затем добавляем запись об окончании игры в таблицу 'game_storage'
        return db.tx(t => {
            const now = new Date();
            const entity = {
                'id': -1,
                'game_session_id': parseInt(game_id),
                'end_date': now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate(),
                'end_time': now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds(),
                'result': result,
                'history': history,
            }

            const query = 'WITH inserted AS (INSERT INTO game_storage(game_session_id, end_date, end_time, result, history)' +
                'VALUES(${game_session_id}, ${end_date}, ${end_time}, ${result}, ${history}) RETURNING *) ' +
                'SELECT inserted.id, s.start_date, s.start_time, inserted.end_date, inserted.end_time, inserted.result, inserted.history ' +
                'FROM inserted LEFT JOIN game_sessions as s ON inserted.game_session_id=s.id'

            return t.one(query, entity);
        })
            .then(data => {
                // COMMIT
                return data;
            })
            .catch(error => {
                // ROLLBACK
            });
    }

    /**
     * Начало быстрой игры.
     * КЛИЕНТ
     * Сообщение: start_quick_game
     * Данные: ничего передавать не нужно
     *
     * СЕРВЕР
     * Если пользователь создал комнату:
     * Сообщение: creating_room
     * Данные: {"room_id": <>}
     *
     * Если пользователь присоединился к комнате:
     * Сообщение: joining_room
     * Данные: {"room_id": <>}
     *
     * Если началась игра:
     * Сообщение: start_game
     * {"room_id": <>,"your_username": <>,"opponent_username": <>}
     **/
    function start_quick_game() {
        let room = null;
        // Создаем новую комнату, если нет свободных.
        if (available_rooms.length === 0) {
            // Добавляем первого игрока (хоста) в комнату.
            room = new Room(new Player(authorized_users[socket.id], this));
            this.emit('creating_room', {'room_id': room.room_id});
            this.join(room.room_id);
            // Добавляем комнату в "поиск".
            available_rooms.push(room)
        } else {
            // Находим свободную комнату.
            room = available_rooms[0];
            // Добавляем второго игрока в комнату.
            room.second_player = new Player(authorized_users[socket.id], this);
            this.emit('joining_room', {'room_id': room.room_id});
            this.join(room.room_id)
            // Удаляем комнату из "поиска".
            available_rooms = available_rooms.filter(x => {
                return x.room_id !== room.room_id;
            })
            // Добавляем запись о начале игры в БД. Получаем ID игры.
            const sgh = start_game_handler(room.first_player.pid, room.second_player.pid);
            sgh.then(_data => {
                room.first_player.socket.emit('start_game', {room_id: room.room_id,
                    your_username: _data.first_player,
                    opponent_username: _data.second_player});

                room.second_player.socket.emit('start_game', {room_id: room.room_id,
                    your_username: _data.second_player,
                    opponent_username: _data.first_player});
            });
            // Добавляем комнату в словарь (dict).
            rooms.push({room: room, start_game_handler: sgh});
        }
    }

    function newMove(move) {
        const gameId = move.gameId

        io.to(gameId).emit('opponent move', move);
    }

    /**
     * Конец быстрой игры.
     * КЛИЕНТ
     * Сообщение: end_quick_game
     * Данные: {"room_id": <>,"result": <>,"history": <>}
     * Поле "room_id" обязательное!
     *
     * СЕРВЕР
     * При завершении игры:
     * Сообщение: end_game
     * Данные: {"id": <>,"start_date": <>,"start_time": <>,"end_date": <>,"end_time": <>,"result": <>,"history": <>}
     *
     * При отключении от комнаты:
     * Сообщение: leaving_room
     **/
    function end_quick_game(input_data) {
        const room_id = input_data["room_id"];
        const result = input_data["result"];
        const history = input_data["history"];
        // Находим нужную комнату.
        const finding_room = rooms.filter(x => {
            return x.room.room_id === room_id;
        })[0];
        // Проверяем присутствует ли игрок, который отправил сообщение, в данной комнате.
        if (finding_room.room.first_player.pid === authorized_users[socket.id] ||
            finding_room.room.second_player.pid === authorized_users[socket.id]) {
            // Создаем запись в БД об окончании игры.
            finding_room.start_game_handler.then(_data => {
                end_game_handler(_data.id, result, history).then( _final_data => {
                        finding_room.room.first_player.socket.emit("end_game", JSON.stringify(_final_data));
                        finding_room.room.second_player.socket.emit("end_game", JSON.stringify(_final_data))
                    });
                });
            // Выходим из комнаты и удаляем её.
            try{
                finding_room.room.first_player.socket.leave(finding_room.room.room_id);
                finding_room.room.second_player.socket.leave(finding_room.room.room_id);

                finding_room.room.first_player.socket.emit("leaving_room");
                finding_room.room.second_player.socket.emit("leaving_room")

                rooms = rooms.filter(x => {
                    return x.room.room_id !== finding_room.room.room_id;
                });
            } catch(e){
                console.log('[error]','leave room :', e);
            }
        }
    }

    function onDisconnect() {
        try {
            const pid = authorized_users[this.id];

            const finding_room = rooms.filter(x => {
                return x.room.first_player.pid === pid || x.room.second_player.pid === pid;
            })[0];

            let winner = null;
            if (finding_room.room.first_player.pid === pid) {
                winner = "second_player";
            } else if (finding_room.room.second_player.pid === pid) {
                winner = "first_player";
            }

            end_quick_game({room_id: finding_room.room.room_id, result: {"winner": winner, "reason": "technical"} })
        } catch (e) { }

        try {
            delete authorized_users[this.id];
        } catch (e) { }
    }
}

exports.initializeGame = initializeGame