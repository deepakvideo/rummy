const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(__dirname));

const rooms = {};
let activeMatchRoom = null;

const MIN_PLAYERS_PER_ROOM = 2;
const MAX_PLAYERS_PER_ROOM = 5;
const COUNTDOWN_SECONDS = 20;

app.get("/", (req, res) => {
    res.send("Rummy Game Socket.IO Backend Running");
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        activeRooms: Object.keys(rooms).length
    });
});

function generateRoomCode() {
    let code;
    do {
        code = Math.random()
            .toString(36)
            .substring(2, 7)
            .toUpperCase();
    } while (rooms[code]);
    return code;
}

function getCleanRoomState(room) {
    return {
        id: room.id,
        started: room.started,
        timerVal: room.timerVal,
        gameData: room.gameData || "",
        players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            isHost: p.isHost
        }))
    };
}

io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on("joinGame", (playerData) => {
        let playerName = playerData && playerData.name ? playerData.name : `Player_${socket.id.substring(0, 4)}`;

        if (
            !activeMatchRoom ||
            !rooms[activeMatchRoom] ||
            rooms[activeMatchRoom].players.length >= MAX_PLAYERS_PER_ROOM ||
            rooms[activeMatchRoom].started
        ) {
            activeMatchRoom = generateRoomCode();
        }

        let targetRoomCode = activeMatchRoom;
        let currentRoom = rooms[targetRoomCode];

        if (!currentRoom) {
            rooms[targetRoomCode] = {
                id: targetRoomCode,
                players: [],
                started: false,
                countdown: null,
                timerVal: COUNTDOWN_SECONDS,
                gameData: ""
            };
            currentRoom = rooms[targetRoomCode];
        }

        socket.join(targetRoomCode);
        socket.roomCode = targetRoomCode;

        const existingPlayerIndex = currentRoom.players.findIndex(p => p.id === socket.id);
        if (existingPlayerIndex === -1) {
            currentRoom.players.push({
                id: socket.id,
                name: playerName,
                isHost: currentRoom.players.length === 0
            });
        }

        if (currentRoom.players.length >= MAX_PLAYERS_PER_ROOM) {
            activeMatchRoom = null;
        }

        socket.emit("assignedRoom", targetRoomCode);
        io.to(targetRoomCode).emit("roomUpdate", getCleanRoomState(currentRoom));

        console.log(`${playerName} joined room ${targetRoomCode}. Total: ${currentRoom.players.length}`);

        if (
            currentRoom.players.length >= MIN_PLAYERS_PER_ROOM &&
            !currentRoom.countdown &&
            !currentRoom.started
        ) {
            currentRoom.timerVal = COUNTDOWN_SECONDS;
            io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);

            currentRoom.countdown = setInterval(() => {
                currentRoom.timerVal--;
                io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);

                if (currentRoom.timerVal <= 0 || currentRoom.players.length >= MAX_PLAYERS_PER_ROOM) {
                    if (currentRoom.countdown) {
                        clearInterval(currentRoom.countdown);
                        currentRoom.countdown = null;
                    }

                    if (!currentRoom.started) {
                        currentRoom.started = true;
                        console.log(`Room ${targetRoomCode} starting game.`);
                        io.to(targetRoomCode).emit("gameStartSignal", getCleanRoomState(currentRoom));
                    }
                }
            }, 1000);
        }
    });

    // RELAY GAME STATE: Broadcasts moves and card updates to opponents in the room
    socket.on("syncGameState", (state) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        rooms[roomCode].gameData = state.gameData || "";
        rooms[roomCode].winnerName = state.winnerName || null;
        rooms[roomCode].wrongShowPlayer = state.wrongShowPlayer || null;

        socket.to(roomCode).emit("gameStateUpdated", {
            gameData: rooms[roomCode].gameData,
            winnerName: rooms[roomCode].winnerName,
            wrongShowPlayer: rooms[roomCode].wrongShowPlayer
        });
    });

    socket.on("playerDeclared", (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;
        rooms[roomCode].winnerName = data.winnerName;
        socket.to(roomCode).emit("playerDeclared", data);
    });

    socket.on("playerWrongShow", (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;
        socket.to(roomCode).emit("playerWrongShow", data);
    });

    socket.on("playerDropped", (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;
        socket.to(roomCode).emit("playerDropped", data);
    });

    socket.on("disconnect", () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        room.players = room.players.filter((p) => p.id !== socket.id);

        if (room.players.length < MIN_PLAYERS_PER_ROOM && room.countdown && !room.started) {
            clearInterval(room.countdown);
            room.countdown = null;
            room.timerVal = COUNTDOWN_SECONDS;
            io.to(roomCode).emit("countdownUpdate", COUNTDOWN_SECONDS);
        }

        if (room.players.length === 0) {
            if (room.countdown) clearInterval(room.countdown);
            delete rooms[roomCode];
            if (activeMatchRoom === roomCode) activeMatchRoom = null;
            return;
        }

        if (!room.players.some((p) => p.isHost)) {
            room.players[0].isHost = true;
        }

        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Multiplayer server running on port ${PORT}`);
});