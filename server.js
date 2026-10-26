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

function getNextActivePlayer(room) {
    if (!room.players || room.players.length === 0) {
        return 0;
    }

    let next = room.currentTurnIndex;
    let count = 0;

    do {
        next = (next + 1) % room.players.length;
        count++;

        if (!room.players[next].dropped) {
            return next;
        }
    } while (count < room.players.length);

    return room.currentTurnIndex;
}

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
            isHost: p.isHost,
            dropped: !!p.dropped
        }))
    };
}

io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on("joinGame", (playerData) => {
        let playerName = playerData && playerData.name ? playerData.name : `Player_${socket.id.substring(0, 4)}`;

        let targetRoomCode = null;

        if (activeMatchRoom && rooms[activeMatchRoom] && !rooms[activeMatchRoom].started && rooms[activeMatchRoom].players.length < MAX_PLAYERS_PER_ROOM) {
            targetRoomCode = activeMatchRoom;
        } else {
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
                hasDrawnThisTurn: false,
                winnerName: null,
                wrongShowPlayer: null,
                droppedPlayer: null
            };
            rooms[targetRoomCode] = currentRoom;
        }

        if (currentRoom.players.length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit("roomFull");
            return;
        }

        socket.join(targetRoomCode);
        socket.roomCode = targetRoomCode;

        const existingPlayerIndex = currentRoom.players.findIndex(p => p.id === socket.id);
        if (existingPlayerIndex === -1) {
            const player = {
                id: socket.id,
                name: playerName,
                isHost: currentRoom.players.length === 0,
                dropped: false
            };
            currentRoom.players.push(player);
        } else {
            currentRoom.players[existingPlayerIndex].id = socket.id;
        }

        if (currentRoom.players.length >= MAX_PLAYERS_PER_ROOM) {
            activeMatchRoom = null;
        }

        socket.emit("assignedRoom", targetRoomCode);
        
        if (currentRoom.started) {
            socket.emit("gameStateUpdated", {
                gameData: currentRoom.gameData || "",
                winnerName: currentRoom.winnerName || null,
                wrongShowPlayer: currentRoom.wrongShowPlayer || null,
                droppedPlayer: currentRoom.droppedPlayer || null
            });

            const currentPlayer = currentRoom.players[currentRoom.currentTurnIndex];
            if (currentPlayer) {
                socket.emit("turnChanged", {
                    playerId: currentPlayer.id,
                    playerName: currentPlayer.name,
                    currentTurnIndex: currentRoom.currentTurnIndex
                });
            }
        }

        io.to(targetRoomCode).emit("roomUpdate", getCleanRoomState(currentRoom));
        console.log(`${playerName} (${socket.id}) joined room ${targetRoomCode}. Total: ${currentRoom.players.length}`);

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
                        
                        currentRoom.currentTurnIndex = currentRoom.players.findIndex(p => !p.dropped);
                        if (currentRoom.currentTurnIndex === -1) {
                            currentRoom.currentTurnIndex = 0;
                        }
                        
                        currentRoom.hasDrawnThisTurn = false;

                        console.log(`Room ${targetRoomCode} started with ${currentRoom.players.length} players.`);

                        io.to(targetRoomCode).emit("gameStartSignal", getCleanRoomState(currentRoom));
                        
                        const activeTurnPlayer = currentRoom.players[currentRoom.currentTurnIndex];
                        if (activeTurnPlayer) {
                            io.to(targetRoomCode).emit("turnChanged", {
                                playerId: activeTurnPlayer.id,
                                playerName: activeTurnPlayer.name,
                                currentTurnIndex: currentRoom.currentTurnIndex
                            });
                        }
                    }
                }
            }, 1000);
        }
    });

    socket.on("playerDraw", () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        if (!room.started) return;

        const turnPlayer = room.players[room.currentTurnIndex];

        if (!turnPlayer || turnPlayer.id !== socket.id) {
            socket.emit("drawRejected", { message: "Not your turn!" });
            return;
        }

        if (turnPlayer.dropped) {
            socket.emit("drawRejected", { message: "You have dropped out of the game!" });
            return;
        }

        if (room.hasDrawnThisTurn) {
            socket.emit("drawRejected", { message: "You already drew a card this turn!" });
            return;
        }

        room.hasDrawnThisTurn = true;
        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
        socket.emit("drawApproved");
    });

    socket.on("playerDiscard", () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        if (!room.started) return;

        const turnPlayer = room.players[room.currentTurnIndex];

        if (!turnPlayer || turnPlayer.id !== socket.id) {
            socket.emit("discardRejected", { message: "Not your turn!" });
            return;
        }

        if (turnPlayer.dropped) {
            socket.emit("discardRejected", { message: "You have dropped out of the game!" });
            return;
        }

        if (!room.hasDrawnThisTurn) {
            socket.emit("discardRejected", { message: "Draw a card first before discarding!" });
            return;
        }

        room.hasDrawnThisTurn = false;
        room.currentTurnIndex = getNextActivePlayer(room);

        const nextPlayer = room.players[room.currentTurnIndex];

        socket.emit("discardApproved");

        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
        if (nextPlayer) {
            io.to(roomCode).emit("turnChanged", {
                playerId: nextPlayer.id,
                playerName: nextPlayer.name,
                currentTurnIndex: room.currentTurnIndex
            });
        }
    });

    socket.on("syncGameState", (state) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        if (!room.started) return;

        const turnPlayer = room.players[room.currentTurnIndex];
        if (turnPlayer && turnPlayer.id !== socket.id) {
            return;
        }

        room.gameData = state.gameData || "";

        socket.to(roomCode).emit("gameStateUpdated", {
            gameData: room.gameData,
            winnerName: room.winnerName,
            wrongShowPlayer: room.wrongShowPlayer,
            droppedPlayer: room.droppedPlayer
        });
    });

    socket.on("playerDeclared", () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        if (!room.started || room.winnerName) return;

        const turnPlayer = room.players[room.currentTurnIndex];
        if (!turnPlayer || turnPlayer.id !== socket.id || turnPlayer.dropped) return;

        room.winnerName = turnPlayer.name;
        room.hasDrawnThisTurn = false;

        io.to(roomCode).emit("playerDeclared", { winnerName: turnPlayer.name });
        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
    });

    socket.on("playerWrongShow", (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        const player = room.players.find(p => p.id === socket.id);

        if (!player || player.dropped) return;

        socket.to(roomCode).emit("playerWrongShow", data);
    });

    socket.on("playerDropped", (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        const player = room.players.find(p => p.id === socket.id);

        if (!player || player.dropped) return;

        player.dropped = true;

        if (room.players[room.currentTurnIndex]?.id === socket.id) {
            room.hasDrawnThisTurn = false;
            room.currentTurnIndex = getNextActivePlayer(room);

            const nextPlayer = room.players[room.currentTurnIndex];
            if (nextPlayer) {
                io.to(roomCode).emit("turnChanged", {
                    playerId: nextPlayer.id,
                    playerName: nextPlayer.name,
                    currentTurnIndex: room.currentTurnIndex
                });
            }
        }

        io.to(roomCode).emit("playerDropped", data);

        const activePlayers = room.players.filter(p => !p.dropped);
        if (room.started && activePlayers.length === 1 && !room.winnerName) {
            room.winnerName = activePlayers[0].name;
            io.to(roomCode).emit("playerDeclared", {
                winnerName: activePlayers[0].name
            });
        }
        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
    });

    socket.on("disconnect", () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        console.log(`Client disconnected: ${socket.id}`);

        const removedIndex = room.players.findIndex(p => p.id === socket.id);
        if (removedIndex === -1) return;

        const wasCurrentTurn = removedIndex === room.currentTurnIndex;
        room.players.splice(removedIndex, 1);

        if (room.started) {
            if (room.players.length > 0) {
                if (room.currentTurnIndex >= room.players.length) {
                    room.currentTurnIndex = 0;
                }
                
                if (wasCurrentTurn) {
                    room.hasDrawnThisTurn = false;
                    room.currentTurnIndex = getNextActivePlayer(room);
                    const nextPlayer = room.players[room.currentTurnIndex];
                    if (nextPlayer) {
                        io.to(roomCode).emit("turnChanged", {
                            playerId: nextPlayer.id,
                            playerName: nextPlayer.name,
                            currentTurnIndex: room.currentTurnIndex
                        });
                    }
                }
            }
        }

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

        const activePlayers = room.players.filter(p => !p.dropped);
        if (room.started && activePlayers.length === 1 && !room.winnerName) {
            room.winnerName = activePlayers[0].name;
            io.to(roomCode).emit("playerDeclared", {
                winnerName: activePlayers[0].name
            });
        }

        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Multiplayer authoritative server running on port ${PORT}`);
});
