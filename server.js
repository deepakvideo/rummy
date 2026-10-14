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

const MAX_PLAYERS_PER_ROOM = 2;
const COUNTDOWN_SECONDS = 15;

app.get("/", (req, res) => {
    res.send("Rummy Game Socket.IO Backend is Running!");
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
        
        // Find or create an open matching room
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

        // Check if player already exists in room
        const existingPlayerIndex = currentRoom.players.findIndex(p => p.id === socket.id);
        if (existingPlayerIndex === -1) {
            const player = {
                id: socket.id,
                name: playerName,
                isHost: currentRoom.players.length === 0
            };
            currentRoom.players.push(player);
        }

        socket.emit("assignedRoom", targetRoomCode);
        io.to(targetRoomCode).emit("roomUpdate", getCleanRoomState(currentRoom));

        console.log(`${playerName} (${socket.id}) joined room ${targetRoomCode}. Total players: ${currentRoom.players.length}`);

        // Start countdown when room is full
        if (
            currentRoom.players.length >= MAX_PLAYERS_PER_ROOM &&
            !currentRoom.countdown &&
            !currentRoom.started
        ) {
            currentRoom.timerVal = COUNTDOWN_SECONDS;

            io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);

            currentRoom.countdown = setInterval(() => {
                currentRoom.timerVal--;

                io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);

                if (currentRoom.timerVal <= 0) {
                    clearInterval(currentRoom.countdown);
                    currentRoom.countdown = null;
                    currentRoom.started = true;

                    console.log(`Countdown finished for room ${targetRoomCode}. Sending gameStartSignal.`);

                    io.to(targetRoomCode).emit(
                        "gameStartSignal",
                        getCleanRoomState(currentRoom)
                    );
                }
            }, 1000);
        }
    });

    // Main unified state synchronization handler
    socket.on("syncGameState", (state) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        rooms[roomCode].gameData = state.gameData || "";
        // Reset or assign flags dynamically based on the current action
        rooms[roomCode].winnerName = state.winnerName || null;
        rooms[roomCode].wrongShowPlayer = state.wrongShowPlayer || null;

        console.log(`Game state synced for room ${roomCode} | Winner: ${state.winnerName} | WrongShow: ${state.wrongShowPlayer}`);

        // Broadcast to all peers in room
        io.to(roomCode).emit("gameStateUpdated", {
            gameData: rooms[roomCode].gameData,
            winnerName: rooms[roomCode].winnerName,
            wrongShowPlayer: rooms[roomCode].wrongShowPlayer
        });
    });

<<<<<<< HEAD
    // Broadcast valid declaration event explicitly
    socket.on("playerDeclared", (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        rooms[roomCode].winnerName = data.winnerName;
        console.log(`Player declared win in room ${roomCode}: ${data.winnerName}`);

        socket.to(roomCode).emit("playerDeclared", data);
=======
// Broadcast declaration to ALL players in the room
    socket.on("playerDeclared", (data) => {
        const roomCode = socket.roomCode;
        if (roomCode) {
            console.log(`Player declared win in room ${roomCode}`);
            io.to(roomCode).emit("playerDeclared", data);
        }
>>>>>>> 442d7c0 (Update server.js with latest changes)
    });

    // Broadcast wrong show / invalid declaration event
    socket.on("playerWrongShow", (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        console.log(`Wrong show declared in room ${roomCode} by ${data.playerName}`);

        socket.to(roomCode).emit("playerWrongShow", data);
    });

    // Handle player dropping out or folding
    socket.on("playerDropped", (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        console.log(`Player dropped in room ${roomCode}`);

        socket.to(roomCode).emit("playerDropped", data);
    });

    socket.on("disconnect", () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        console.log(`Client disconnected: ${socket.id}`);

        room.players = room.players.filter((p) => p.id !== socket.id);

        if (room.players.length < MAX_PLAYERS_PER_ROOM && room.countdown) {
            clearInterval(room.countdown);
            room.countdown = null;
            room.timerVal = COUNTDOWN_SECONDS;
            io.to(roomCode).emit("countdownUpdate", COUNTDOWN_SECONDS);
        }

        if (room.players.length === 0) {
            if (room.countdown) clearInterval(room.countdown);
            delete rooms[roomCode];
            if (activeMatchRoom === roomCode) activeMatchRoom = null;
            console.log(`Room deleted: ${roomCode}`);
            return;
        }

        // Reassign host if needed
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