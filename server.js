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
const COUNTDOWN_SECONDS = 20;

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
            isHost: p.isHost,
            hand: p.hand || []
        }))
    };
}

io.on("connection", (socket) => {

    console.log(`Client connected: ${socket.id}`);

    socket.on("joinGame", ({ requestedRoom, playerName }) => {

        let targetRoomCode = requestedRoom
            ? requestedRoom.toUpperCase()
            : "";

        // Auto matchmaking
        if (!targetRoomCode) {

            if (
                !activeMatchRoom ||
                !rooms[activeMatchRoom] ||
                rooms[activeMatchRoom].players.length >= MAX_PLAYERS_PER_ROOM ||
                rooms[activeMatchRoom].started
            ) {
                activeMatchRoom = generateRoomCode();
            }

            targetRoomCode = activeMatchRoom;
        }

        let currentRoom = rooms[targetRoomCode];

        // Prevent joining active/full rooms
        if (
            currentRoom &&
            (
                currentRoom.players.length >= MAX_PLAYERS_PER_ROOM ||
                currentRoom.started
            )
        ) {

            socket.emit(
                "errorMsg",
                "Room full or game already started. New room created."
            );

            targetRoomCode = generateRoomCode();
            currentRoom = null;
        }

        // Create room
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

        const player = {
            id: socket.id,
            name:
                playerName ||
                `Player ${currentRoom.players.length + 1}`,
            hand: [],
            isHost: currentRoom.players.length === 0
        };

        currentRoom.players.push(player);

        socket.emit("assignedRoom", targetRoomCode);

        // Send current state immediately
        socket.emit(
            "roomUpdate",
            getCleanRoomState(currentRoom)
        );

        socket.emit(
            "countdownUpdate",
            currentRoom.timerVal
        );

        // Start countdown when room is full
        if (
            currentRoom.players.length >= MAX_PLAYERS_PER_ROOM &&
            !currentRoom.countdown &&
            !currentRoom.started
        ) {

            currentRoom.timerVal = COUNTDOWN_SECONDS;

            io.to(targetRoomCode).emit(
                "countdownUpdate",
                currentRoom.timerVal
            );

            currentRoom.countdown = setInterval(() => {

                currentRoom.timerVal--;

                io.to(targetRoomCode).emit(
                    "countdownUpdate",
                    currentRoom.timerVal
                );

if (currentRoom.timerVal <= 0) {

    clearInterval(currentRoom.countdown);

    currentRoom.countdown = null;
    currentRoom.started = true;

    // TEMP DEBUG DATA
  currentRoom.gameData = "";

    console.log(
        "GAME DATA BEFORE START =",
        currentRoom.gameData
    );

    io.to(targetRoomCode).emit(
        "gameStartSignal",
        getCleanRoomState(currentRoom)
    );
}

            }, 1000);
        }

        io.to(targetRoomCode).emit(
            "roomUpdate",
            getCleanRoomState(currentRoom)
        );

        console.log(
            `${player.name} joined room ${targetRoomCode}`
        );
    });


socket.on("syncGameState", (state) => {

    const roomCode = socket.roomCode;

    if (!roomCode || !rooms[roomCode]) {
        return;
    }

    rooms[roomCode].gameData = state.gameData;

    console.log(
        `Game state synced for room ${roomCode}`
    );

    io.to(roomCode).emit(
        "gameStartSignal",
        getCleanRoomState(
            rooms[roomCode]
        )
    );
});

socket.on("initialGameState", (data) => {

    const roomCode = socket.roomCode;

    if (!roomCode || !rooms[roomCode]) {
        return;
    }

    rooms[roomCode].gameData = data.gameData;

    io.to(roomCode).emit(
        "gameStartSignal",
        getCleanRoomState(
            rooms[roomCode]
        )
    );

    console.log(
        "Initial game state stored"
    );
});
    // Optional request for latest state
    socket.on("requestGameState", () => {

    const roomCode = socket.roomCode;

    if (
        roomCode &&
        rooms[roomCode]
    ) {

        socket.emit(
            "gameStateUpdated",
            {
                gameData: rooms[roomCode].gameData
            }
        );
    }
});

    socket.on("disconnect", () => {

        const roomCode = socket.roomCode;

        if (
            !roomCode ||
            !rooms[roomCode]
        ) {
            return;
        }

        const room = rooms[roomCode];

        console.log(
            `Client disconnected: ${socket.id}`
        );

        room.players = room.players.filter(
            (p) => p.id !== socket.id
        );

        // Stop countdown if room no longer full
        if (
            room.players.length < MAX_PLAYERS_PER_ROOM &&
            room.countdown
        ) {
            clearInterval(room.countdown);

            room.countdown = null;
            room.timerVal = COUNTDOWN_SECONDS;

            io.to(roomCode).emit(
                "countdownUpdate",
                COUNTDOWN_SECONDS
            );
        }

        // Delete empty room
        if (room.players.length === 0) {

            if (room.countdown) {
                clearInterval(room.countdown);
            }

            delete rooms[roomCode];

            if (activeMatchRoom === roomCode) {
                activeMatchRoom = null;
            }

            console.log(`Room deleted: ${roomCode}`);

            return;
        }

        // Ensure one host exists
        if (!room.players.some((p) => p.isHost)) {
            room.players[0].isHost = true;
        }

        io.to(roomCode).emit(
            "roomUpdate",
            getCleanRoomState(room)
        );
    });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(
        `Multiplayer server running on port ${PORT}`
    );
});