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
    const currentTurnPlayer = room.players[room.currentTurnIndex] || null;
    return {
        id: room.id,
        started: room.started,
        timerVal: room.timerVal,
        gameData: room.gameData || "",
        currentTurnIndex: room.currentTurnIndex,
        hasDrawnThisTurn: room.hasDrawnThisTurn,
        currentTurnPlayerId: currentTurnPlayer ? currentTurnPlayer.id : null,
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

        // Matchmaking room allocation: Find an existing open room that hasn't started and has space (< 5 players)
        let targetRoomCode = null;

        if (activeMatchRoom && rooms[activeMatchRoom] && !rooms[activeMatchRoom].started && rooms[activeMatchRoom].players.length < MAX_PLAYERS_PER_ROOM) {
            targetRoomCode = activeMatchRoom;
        } else {
            // Search all rooms for any available waiting table
            let openRoomCode = Object.keys(rooms).find(code => 
                !rooms[code].started && rooms[code].players.length < MAX_PLAYERS_PER_ROOM
            );

            if (openRoomCode) {
                targetRoomCode = openRoomCode;
                activeMatchRoom = openRoomCode;
            } else {
                targetRoomCode = generateRoomCode();
                activeMatchRoom = targetRoomCode;
            }
        }

        let currentRoom = rooms[targetRoomCode];

        if (!currentRoom) {
            currentRoom = {
                id: targetRoomCode,
                players: [],
                started: false,
                countdown: null,
                timerVal: COUNTDOWN_SECONDS,
                gameData: "",
                currentTurnIndex: 0,
                hasDrawnThisTurn: false
            };
            rooms[targetRoomCode] = currentRoom;
        }

        socket.join(targetRoomCode);
        socket.roomCode = targetRoomCode;

        // Prevent duplicate player entries
        const existingPlayerIndex = currentRoom.players.findIndex(p => p.id === socket.id);
        if (existingPlayerIndex === -1) {
            const player = {
                id: socket.id,
                name: playerName,
                isHost: currentRoom.players.length === 0
            };
            currentRoom.players.push(player);
        } else {
            currentRoom.players[existingPlayerIndex].id = socket.id;
        }

        // If room reaches 5 players, clear activeMatchRoom so the next player creates a new table
        if (currentRoom.players.length >= MAX_PLAYERS_PER_ROOM) {
            activeMatchRoom = null;
        }

        socket.emit("assignedRoom", targetRoomCode);
        io.to(targetRoomCode).emit("roomUpdate", getCleanRoomState(currentRoom));

        console.log(`${playerName} (${socket.id}) joined room ${targetRoomCode}. Total: ${currentRoom.players.length}`);

        // Start countdown when at least 2 players join and countdown isn't running yet
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
                        currentRoom.currentTurnIndex = 0;
                        currentRoom.hasDrawnThisTurn = false;

                        console.log(`Room ${targetRoomCode} started with ${currentRoom.players.length} players.`);

                        io.to(targetRoomCode).emit("gameStartSignal", getCleanRoomState(currentRoom));
                        
                        io.to(targetRoomCode).emit("turnChanged", {
                            playerId: currentRoom.players[0].id,
                            playerName: currentRoom.players[0].name
                        });
                    }
                }
            }, 1000);
        }
    });

   // SERVER VALIDATION: Player requests card draw
    socket.on("playerDraw", () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        const turnPlayer = room.players[room.currentTurnIndex];

        if (!turnPlayer || turnPlayer.id !== socket.id) {
            socket.emit("drawRejected", { message: "Not your turn!" });
            return;
        }

        if (room.hasDrawnThisTurn) {
            socket.emit("drawRejected", { message: "You already drew a card this turn!" });
            return;
        }

        room.hasDrawnThisTurn = true;
        
        // Broadcast updated room state so all clients know a card was drawn this turn
        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
        socket.emit("drawApproved");
    });

    // SERVER VALIDATION: Player requests card discard / turn end
    socket.on("playerDiscard", () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        const turnPlayer = room.players[room.currentTurnIndex];

        if (!turnPlayer || turnPlayer.id !== socket.id) {
            socket.emit("discardRejected", { message: "Not your turn!" });
            return;
        }

        if (!room.hasDrawnThisTurn) {
            socket.emit("discardRejected", { message: "Draw a card first before discarding!" });
            return;
        }

        // Reset turn flags and rotate turn to next player
        room.hasDrawnThisTurn = false;
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;

        const nextPlayer = room.players[room.currentTurnIndex];

        socket.emit("discardApproved");

        // Broadcast updated room state and turn change
        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
        io.to(roomCode).emit("turnChanged", {
            playerId: nextPlayer.id,
            playerName: nextPlayer.name,
            currentTurnIndex: room.currentTurnIndex
        });
    });
    // PROTECTED STATE SYNC: Only turn player can sync state mid-turn
  socket.on("syncGameState", (state) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        const turnPlayer = room.players[room.currentTurnIndex];

        // Allow sync if it's the turn player OR if a player is dropping/wrong showing
        room.gameData = state.gameData || "";
        room.winnerName = state.winnerName || null;
        room.wrongShowPlayer = state.wrongShowPlayer || null;
        room.droppedPlayer = state.droppedPlayer || null; // <-- ADD THIS

        socket.to(roomCode).emit("gameStateUpdated", {
            gameData: room.gameData,
            winnerName: room.winnerName,
            wrongShowPlayer: room.wrongShowPlayer,
            droppedPlayer: room.droppedPlayer // <-- ADD THIS
        });
    });

    // Game End & Drop Handlers
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
        console.log(`Client disconnected: ${socket.id}`);

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
            console.log(`Room deleted: ${roomCode}`);
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
    console.log(`Multiplayer authoritative server running on port ${PORT}`);
});
