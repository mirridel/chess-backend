const express = require('express')
const http = require('http')
const socketio = require('socket.io')
const gameLogic = require('./game-logic')
const crypto = require("crypto");
const app = express()

const server = http.createServer(app)
const io = socketio(server)
const PORT = 8000

const pgp = require('pg-promise')(/* options */)
db = pgp('postgres://postgres:19092001@localhost/Chess')

function password_hashing(input_data) {
    const secret = "novosibirsk";
    const hasher = crypto.createHmac("sha256", secret);
    return hasher.update(input_data).digest("hex");
}

io.on('connection', client => {
    /**
     * РЕГИСТРАЦИЯ
     * Входные данные (input_data):
     * {'username': <username>, 'password': <password>, 'secret_question': <secret_question>, 'answer': <answer>}
     * Ответ (успех):
     * {'id': <id>}
     * Ответ (ошибка):
     * {'id': -1}
     */
    client.on('reg', registration_handler);

    function registration_handler(input_data) {
        try {
            if (input_data['username'] !== '' && input_data['username'] !== null &&
                input_data['password'] !== '' && input_data['password'] !== null &&
                input_data['secret_question'] !== '' && input_data['secret_question'] !== null &&
                input_data['answer'] !== '' && input_data['answer'] !== null) {
                db.tx(t => {
                    input_data['hashed_password'] = password_hashing(input_data['password']);
                    const query = 'INSERT INTO users(username, password, secret_question, answer)' +
                        'VALUES(${username}, ${hashed_password}, ${secret_question}, ${answer}) RETURNING id'
                    return t.one(query, input_data);
                })
                    .then(data => {
                        // COMMIT
                        client.emit("reg", {"id": data.id})
                    })
                    .catch(error => {
                        // ROLLBACK
                        client.emit("reg", {"id": -1})
                    });
            }
        } catch (e) {
            // console.error(e)
        }
    }

    /**
     * АВТОРИЗАЦИЯ
     * Входные данные (input_data):
     * {'username': <username>, 'password': <password>}
     * Ответ (успех):
     * {'id': <id>, 'username': <username>}
     * Ответ (ошибка):
     * {'id': -1}
     */
    client.on('auth', authorization_handler);

    function authorization_handler(input_data) {
        try {
            if (input_data['username'] !== '' && input_data['username'] !== null &&
                input_data['password'] !== '' && input_data['password'] !== null) {
                db.tx(t => {
                    input_data['hashed_password'] = password_hashing(input_data['password']);
                    const query = 'SELECT * FROM users WHERE username = ${username} AND password = ${hashed_password}';
                    return t.one(query, input_data);
                })
                    .then(data => {
                        // COMMIT
                        client.emit("auth", {"id": data.id, "username": data.username})
                        gameLogic.initializeGame(io, client, db)
                    })
                    .catch(error => {
                        // ROLLBACK
                        client.emit("auth", {"id": -1})
                    });
            }
        } catch (e) { }
    }

    client.on('get_secret_question', get_secret_question_handler);

    function get_secret_question_handler(input_data) {
        try {
            db.tx(t => {
                const query = 'SELECT * FROM users WHERE username = ${username}';
                return t.one(query, input_data);
            })
                .then(data => {
                    // COMMIT
                    client.emit("get_secret_question", {"username": data.username, "secret_question": data.secret_question})
                })
                .catch(error => {
                    // ROLLBACK
                    console.log(error)
                    client.emit("get_secret_question", "error")
                });
        } catch (e) { }
    }

    client.on('change_password', change_password_handler);

    function change_password_handler(input_data) {
        try {
            db.tx(t => {
                input_data['hashed_password'] = password_hashing(input_data['password']);
                const query = 'UPDATE users SET password = ${hashed_password}  WHERE username = ${username} AND answer = ${answer} RETURNING id';
                return t.one(query, input_data);
            })
                .then(data => {
                    // COMMIT
                    client.emit("change_password", {"id": data.id})
                })
                .catch(error => {
                    // ROLLBACK
                    client.emit("change_password", {"id": -1})
                    console.error(error)
                });
        } catch (e) { }
    }

})

server.listen(PORT)

console.log('There server runs: ' + JSON.stringify(server.address()));