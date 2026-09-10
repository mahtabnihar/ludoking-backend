const express = require('express');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');

function generateApiToken() {
  return 'gg.net-' + crypto.randomBytes(16).toString('hex');
}

const JWT_SECRET = 'ludo-super-secret-key-123';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // ── FAST DISCONNECT DETECTION ───────────────────────────────────────────────
  // Default Socket.io timeout is 25 s ping interval + 20 s timeout = up to 45 s
  // before a dead connection is detected. Reducing these values means the server
  // fires the 'disconnect' event (and shows the opponent the alert) within ~5 s.
  pingInterval: 5000,   // send a heartbeat every 5 seconds
  pingTimeout:  4000,   // declare the socket dead if no pong in 4 seconds
  // ────────────────────────────────────────────────────────────────────────────
});

const PORT = process.env.PORT || 3000;

// Initialize SQLite database
const db = new sqlite3.Database('./ludo.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    roomId TEXT PRIMARY KEY,
    callbackUrl TEXT,
    state TEXT DEFAULT 'waiting',
    players TEXT,
    lives TEXT,
    activeColor TEXT,
    turnState TEXT,
    rolledValue INTEGER,
    secondsRemaining INTEGER,
    boardState TEXT,
    createdAt INTEGER,
    user_id INTEGER,
    entry_fee INTEGER,
    winning_prize INTEGER,
    waiting_time INTEGER,
    room_type TEXT
  )`);

  db.run(`DELETE FROM rooms`, (err) => {
    if (err) console.error("Error clearing rooms table on startup:", err);
  });
  
  db.run(`ALTER TABLE rooms ADD COLUMN user_id INTEGER`, (err) => {
    // Ignore error if column already exists
  });
  db.run(`ALTER TABLE rooms ADD COLUMN entry_fee INTEGER`, (err) => {
    // Ignore error if column already exists
  });
  db.run(`ALTER TABLE rooms ADD COLUMN winning_prize INTEGER`, (err) => {
    // Ignore error if column already exists
  });
  db.run(`ALTER TABLE rooms ADD COLUMN waiting_time INTEGER`, (err) => {
    // Ignore error if column already exists
  });
  db.run(`ALTER TABLE rooms ADD COLUMN room_type TEXT`, (err) => {
    // Ignore error if column already exists
  });

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    role TEXT DEFAULT 'user',
    api_token TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    cost_per_request INTEGER DEFAULT 1,
    createdAt INTEGER
  )`, (err) => {
    if (!err) {
      db.get(`SELECT * FROM users WHERE username = 'admin'`, (err, row) => {
        if (!row) {
          const salt = bcrypt.genSaltSync(10);
          const hash = bcrypt.hashSync('admin123', salt);
          db.run(`INSERT INTO users (username, password_hash, role, api_token, balance, cost_per_request, createdAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`, ['admin', hash, 'admin', 'admin-token-1234', 999999, 0, Date.now()]);
        }
      });
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS api_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    endpoint TEXT,
    method TEXT,
    cost INTEGER,
    createdAt INTEGER
  )`);

  db.run(`ALTER TABLE users ADD COLUMN enabled INTEGER DEFAULT 1`, (err) => {
    // Ignore error if column already exists
  });
  db.run(`UPDATE users SET enabled = 1 WHERE enabled IS NULL`);
});


// Track active game rooms in memory
const rooms = new Map();

// Helper to save room state to SQLite DB
function saveRoomToDb(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const playersData = room.players.map(p => {
    const avatar = p.avater_url || p.avatar_url || '';
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      uid: p.uid,
      connected: p.connected !== false,
      avater_url: avatar,
      avatar_url: avatar,
      placeholder: !!p.placeholder
    };
  });

  db.run(`INSERT INTO rooms (roomId, callbackUrl, state, players, lives, activeColor, turnState, rolledValue, secondsRemaining, boardState, createdAt, user_id, entry_fee, winning_prize, waiting_time, room_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(roomId) DO UPDATE SET
            user_id = excluded.user_id,
            state = excluded.state,
            players = excluded.players,
            lives = excluded.lives,
            activeColor = excluded.activeColor,
            turnState = excluded.turnState,
            rolledValue = excluded.rolledValue,
            secondsRemaining = excluded.secondsRemaining,
            boardState = excluded.boardState,
            entry_fee = excluded.entry_fee,
            winning_prize = excluded.winning_prize,
            waiting_time = excluded.waiting_time,
            room_type = excluded.room_type`,
    [
      roomId,
      room.callbackUrl || '',
      room.state,
      JSON.stringify(playersData),
      JSON.stringify(room.lives || { red: 5, yellow: 5 }),
      room.activeColor || 'red',
      room.turnState || 'roll',
      room.rolledValue || -1,
      room.secondsRemaining || 10,
      JSON.stringify(room.boardState || null),
      room.createdAt || Date.now(),
      room.userId || null,
      room.entry_fee || 0,
      room.winning_prize || 0,
      room.waiting_time || 60,
      room.room_type || 'private'
    ],
    (err) => {
      if (err) {
        console.error(`Error saving room ${roomId} to DB:`, err);
      }
    }
  );
}

// --- Webhook callbacks ---

function playerPublicInfo(player) {
  if (!player) {
    return { name: '', uid: '', color: '', avater_url: '', avatar_url: '' };
  }
  const avatar = player.avater_url || player.avatar_url || '';
  return {
    name: player.name || '',
    uid: player.uid || '',
    color: player.color || '',
    avater_url: avatar,
    avatar_url: avatar
  };
}

function playersPublicList(room) {
  if (!room || !Array.isArray(room.players)) return [];
  return room.players.filter(Boolean).map(playerPublicInfo);
}

function buildCallbackEnvelope(status, roomId, room, extra = {}) {
  const envelope = {
    status,
    room_id: roomId,
    entry_fee: (room && room.entry_fee) || 0,
    winning_prize: (room && room.winning_prize) || 0,
    room_type: (room && room.room_type) || 'private',
    timestamp: Date.now(),
    players: playersPublicList(room),
    ...extra
  };
  if (status === 'completed') {
    envelope.legacy_status = 'complite';
  } else if (status === 'cancelled') {
    envelope.legacy_status = 'cancled';
  }
  return envelope;
}

function postCallback(callbackUrl, payload, label) {
  if (!callbackUrl) return;

  const body = JSON.stringify(payload);
  let targetUrl = callbackUrl;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'http://' + targetUrl;
  }

  try {
    const parsedUrl = url.parse(targetUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    console.log(`Invoking ${label} callback for room ${payload.room_id} with URL: ${targetUrl}`);

    const req = client.request(options, (res) => {
      console.log(`${label} Callback Response Status: ${res.statusCode}`);
      res.on('data', (d) => {
        process.stdout.write(d);
      });
    });

    req.on('error', (e) => {
      console.error(`${label} Callback error for url ${targetUrl}:`, e);
    });

    req.write(body);
    req.end();
  } catch (err) {
    console.error(`Failed to parse or connect callback URL (${label}):`, err);
  }
}

function invokeLobbyOpenedCallback(callbackUrl, roomId, room) {
  const hostPlayer = (room.players || []).find(p => p && !p.placeholder) || (room.players || [])[0] || null;
  const payload = buildCallbackEnvelope('lobby_opened', roomId, room, {
    waiting_time: room.waiting_time || 60,
    host: playerPublicInfo(hostPlayer)
  });
  postCallback(callbackUrl, payload, 'Lobby Opened');
}

function invokeMatchStartedCallback(callbackUrl, roomId, room) {
  const p1 = playerPublicInfo(room.players[0]);
  const p2 = playerPublicInfo(room.players[1]);
  const payload = buildCallbackEnvelope('started', roomId, room, {
    player1: p1,
    player2: p2
  });
  postCallback(callbackUrl, payload, 'Match Started');
}

function invokeCancelledCallback(callbackUrl, roomId, reason) {
  const room = rooms.get(roomId);
  const payload = buildCallbackEnvelope('cancelled', roomId, room, {
    reason: reason || 'opponent not joined',
    reson: reason === 'opponent not joined' || !reason ? 'oponent not joined' : reason
  });
  postCallback(callbackUrl, payload, 'Cancelled');
}

function invokePlayerLeftCallback(callbackUrl, roomId, room, leftPlayer, stayedPlayer, leaveReason) {
  const payload = buildCallbackEnvelope('player_left', roomId, room, {
    leave_reason: leaveReason || 'disconnect',
    left_player: playerPublicInfo(leftPlayer),
    stayed_player: playerPublicInfo(stayedPlayer)
  });
  postCallback(callbackUrl, payload, 'Player Left');
}

function invokeCompletedCallback(callbackUrl, roomId, room, {
  winnerName,
  winnerUid,
  loserName,
  loserUid,
  endReason
}) {
  let winnerAvatarUrl = '';
  if (room && room.players) {
    const winnerPlayer = room.players.find(p => p.uid === winnerUid);
    if (winnerPlayer) {
      winnerAvatarUrl = winnerPlayer.avater_url || winnerPlayer.avatar_url || '';
    }
  }

  const payload = buildCallbackEnvelope('completed', roomId, room, {
    end_reason: endReason || 'game_won',
    winner_name: winnerName || '',
    winnner_name: winnerName || '',
    winner_uid: winnerUid || '',
    loser_name: loserName || '',
    loser_uid: loserUid || '',
    avater_url: winnerAvatarUrl,
    avatar_url: winnerAvatarUrl
  });
  postCallback(callbackUrl, payload, 'Completed');
}

function resolveLoserFromWinner(room, winnerUid) {
  if (!room || !room.players) {
    return { name: '', uid: '' };
  }
  const loser = room.players.find(p => p.uid !== winnerUid);
  return loser
    ? { name: loser.name || '', uid: loser.uid || '' }
    : { name: '', uid: '' };
}

function settleForfeit(roomId, room, leftPlayer, leaveReason) {
  const opponent = room.players.find(p => p.uid !== leftPlayer.uid);
  const winnerName = opponent ? opponent.name : 'Opponent';
  const winnerUid = opponent ? opponent.uid : '';

  if (room.callbackUrl) {
    invokePlayerLeftCallback(room.callbackUrl, roomId, room, leftPlayer, opponent, leaveReason);
    invokeCompletedCallback(room.callbackUrl, roomId, room, {
      winnerName,
      winnerUid,
      loserName: leftPlayer.name || '',
      loserUid: leftPlayer.uid || '',
      endReason: 'opponent_left'
    });
  }

  return {
    winnerColor: opponent ? opponent.color : (leftPlayer.color === 'red' ? 'yellow' : 'red'),
    winnerName,
    winnerUid
  };
}

function startRoomTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;

  if (room.timer) {
    clearInterval(room.timer);
  }

  room.secondsRemaining = 10;

  // Broadcast initial tick immediately
  io.to(roomId).emit('timerTick', {
    secondsRemaining: room.secondsRemaining,
    activeColor: room.activeColor,
    turnState: room.turnState,
    lives: room.lives
  });

  room.timer = setInterval(() => {
    const r = rooms.get(roomId);
    if (!r || r.state !== 'playing') {
      if (r && r.timer) clearInterval(r.timer);
      return;
    }

    // ── DISCONNECT GUARD ─────────────────────────────────────────────────────
    // If any player is not connected, freeze the timer completely.
    // Auto-roll and auto-move must NEVER fire against an absent player.
    const bothConnected = r.players.length >= 2 && r.players.every(p => p.connected);
    if (!bothConnected) {
      return; // pause – will resume ticking once reconnected
    }
    // ─────────────────────────────────────────────────────────────────────────

    r.secondsRemaining--;

    io.to(roomId).emit('timerTick', {
      secondsRemaining: r.secondsRemaining,
      activeColor: r.activeColor,
      turnState: r.turnState,
      lives: r.lives
    });

    if (r.secondsRemaining <= 0) {
      clearInterval(r.timer);
      r.timer = null;

      // Decrement life of active player
      r.lives[r.activeColor]--;
      console.log(`Room ${roomId}: Player ${r.activeColor} lost a life. Remaining lives: ${r.lives[r.activeColor]}`);

      // Check if lives reached 0 -> Game Over!
      if (r.lives[r.activeColor] <= 0) {
        const winnerColor = r.activeColor === 'red' ? 'yellow' : 'red';
        console.log(`Room ${roomId}: Player ${r.activeColor} out of lives. Winner: ${winnerColor}`);
        r.state = 'finished';

        // Find winner player name and UID
        const winnerPlayer = r.players.find(p => p.color === winnerColor);
        const winnerName = winnerPlayer ? winnerPlayer.name : 'Unknown';
        const winnerUid = winnerPlayer ? winnerPlayer.uid : '';

        const loserColor = r.activeColor;
        const loserPlayer = r.players.find(p => p.color === loserColor);
        const loserName = loserPlayer ? loserPlayer.name : 'Opponent';
        const loserUid = loserPlayer ? loserPlayer.uid : '';

        io.to(roomId).emit('gameOver', {
          reason: 'lives_ended',
          loserColor: loserColor,
          winnerColor: winnerColor,
          winnerName: winnerName,
          winnerUid: winnerUid,
          loserName: loserName,
          loserUid: loserUid
        });

        // Save state to DB
        saveRoomToDb(roomId);

        if (r.callbackUrl) {
          const loser = resolveLoserFromWinner(r, winnerUid);
          invokeCompletedCallback(r.callbackUrl, roomId, r, {
            winnerName,
            winnerUid,
            loserName: loser.name,
            loserUid: loser.uid,
            endReason: 'lives_ended'
          });
        }
        return;
      }

      // Auto Action – safe to execute: both players are confirmed connected above
      if (r.turnState === 'roll') {
        const autoValue = Math.floor(Math.random() * 6) + 1;
        console.log(`Room ${roomId}: Auto rolling dice for ${r.activeColor} with value ${autoValue}`);
        
        io.to(roomId).emit('autoRollDice', {
          value: autoValue,
          rollerColor: r.activeColor
        });

        r.turnState = 'move';
        r.rolledValue = autoValue;
        
        saveRoomToDb(roomId);
        startRoomTimer(roomId);
      } else {
        console.log(`Room ${roomId}: Auto moving piece for ${r.activeColor}`);
        
        const autoMoveColor = r.activeColor;
        const autoMoveSteps = r.rolledValue;

        io.to(roomId).emit('autoMovePiece', {
          color: autoMoveColor,
          steps: autoMoveSteps
        });
        
        // Auto-switch turn after auto-move emission
        r.activeColor = r.activeColor === 'red' ? 'yellow' : 'red';
        r.turnState = 'roll';
        r.rolledValue = -1;
        
        saveRoomToDb(roomId);
        startRoomTimer(roomId);
        io.to(roomId).emit('turnSwitched', { nextColor: r.activeColor });
      }
    }
  }, 1000);
}

// REST API endpoint to create a room
app.post('/api/create-room', (req, res) => {
  const apiToken = req.headers['x-api-token'];
  if (!apiToken) {
    return res.status(401).json({ error: "Missing x-api-token header" });
  }

  db.get(`SELECT * FROM users WHERE api_token = ?`, [apiToken], (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: "Invalid API token" });
    }

    if (user.enabled === 0) {
      return res.status(403).json({ error: "Account is disabled" });
    }

    const { call_back, entry_fee, winning_prize, waiting_time, room_type, uid, playerName, avater_url, avatar_url } = req.body;
    if (!call_back) {
      return res.status(400).json({ error: "Missing 'call_back' parameter" });
    }

    const targetRoomType = room_type || 'private';
    const targetEntryFee = Number(entry_fee) || 0;
    const targetWinningPrize = Number(winning_prize) || 0;
    const targetWaitingTime = Number(waiting_time) || 60;

    if (targetRoomType === 'public') {
      if (!uid) {
        return res.status(400).json({ error: "Missing 'uid' parameter for public room matching" });
      }

      // Find an existing public room with same entry_fee, winning_prize and state 'waiting' with less than 2 players/reserved slots
      let matchedRoomId = null;
      for (const [id, r] of rooms.entries()) {
        if (r.room_type === 'public' &&
            r.state === 'waiting' &&
            r.players.length < 2 &&
            r.entry_fee === targetEntryFee &&
            r.winning_prize === targetWinningPrize) {
          
          // Prevent double matching the same user
          const alreadyInRoom = r.players.some(p => p.uid === uid);
          if (!alreadyInRoom) {
            matchedRoomId = id;
            break;
          }
        }
      }

      if (matchedRoomId) {
        const matchedRoom = rooms.get(matchedRoomId);
        const color = matchedRoom.players.length === 0 ? 'red' : 'yellow';
        matchedRoom.players.push({
          uid: uid,
          name: playerName || '',
          color: color,
          connected: false,
          avater_url: avater_url || avatar_url || '',
          avatar_url: avater_url || avatar_url || '',
          placeholder: true
        });
        saveRoomToDb(matchedRoomId);
        console.log(`Matched user ${uid} to existing public room ID: ${matchedRoomId} (No balance deduction for room match)`);
        return res.status(201).json({ room_id: matchedRoomId });
      }
    }

    // Only deduct balance when a new room is created
    if (user.balance < user.cost_per_request) {
      return res.status(402).json({ error: "Insufficient balance" });
    }

    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [user.cost_per_request, user.id]);
    db.run(`INSERT INTO api_requests (user_id, endpoint, method, cost, createdAt) VALUES (?, ?, ?, ?, ?)`, 
           [user.id, '/api/create-room', 'POST', user.cost_per_request, Date.now()]);

    let roomId;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(roomId));

    const initialPlayers = [];
    if (uid) {
      initialPlayers.push({
        uid: uid,
        name: playerName || '',
        color: 'red',
        connected: false,
        avater_url: avater_url || avatar_url || '',
        avatar_url: avater_url || avatar_url || '',
        placeholder: true
      });
    }

    const room = {
      players: initialPlayers,
      state: 'waiting',
      callbackUrl: call_back,
      userId: user.id,
      entry_fee: targetEntryFee,
      winning_prize: targetWinningPrize,
      waiting_time: targetWaitingTime,
      room_type: targetRoomType,
      createdAt: Date.now()
    };

    // Start lobby timeout timer from the moment of room creation (ONLY for public rooms)
    if (targetRoomType === 'public') {
      const waitTimeSeconds = targetWaitingTime || 60;
      room.lobbyTimer = setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.state === 'waiting') {
          console.log(`Room ${roomId}: Lobby timeout reached. Auto-cancelling match.`);
          r.state = 'cancelled';
          
          io.to(roomId).emit('gameOver', {
            reason: 'lobby_timeout',
            winnerColor: 'none',
            loserColor: 'none',
            winnerName: '',
            winnerUid: ''
          });
          
          saveRoomToDb(roomId);
          
          if (r.callbackUrl) {
            invokeCancelledCallback(r.callbackUrl, roomId, "opponent not joined");
          }
        }
      }, waitTimeSeconds * 1000);
    }

    rooms.set(roomId, room);

    db.run(`INSERT OR REPLACE INTO rooms (roomId, callbackUrl, state, players, lives, createdAt, user_id, entry_fee, winning_prize, waiting_time, room_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [roomId, call_back, 'waiting', JSON.stringify(initialPlayers), JSON.stringify({ red: 5, yellow: 5 }), room.createdAt, user.id, targetEntryFee, targetWinningPrize, targetWaitingTime, targetRoomType],
      (err) => {
        if (err) {
          console.error("Error creating room in DB:", err);
          return res.status(500).json({ error: "Database error" });
        }
        console.log(`Created room ID: ${roomId} with callback: ${call_back}`);
        if (call_back && targetRoomType === 'public') {
          invokeLobbyOpenedCallback(call_back, roomId, room);
        }
        return res.status(201).json({ room_id: roomId });
      }
    );
  });
});



// --- DASHBOARD API ROUTES ---
function verifyToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(403).json({ error: "No token provided" });
  
  jwt.verify(token.split(' ')[1], JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Unauthorized" });
    req.userId = decoded.id;
    req.userRole = decoded.role;
    next();
  });
}

function verifyAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: "Require Admin Role!" });
  }
  next();
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err || !user) return res.status(404).json({ error: "User not found" });

    if (user.enabled === 0) {
      return res.status(403).json({ error: "Account is disabled. Contact an administrator." });
    }

    const passwordIsValid = bcrypt.compareSync(password, user.password_hash);
    if (!passwordIsValid) return res.status(401).json({ error: "Invalid Password!" });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: 86400 });
    res.status(200).json({ id: user.id, username: user.username, role: user.role, accessToken: token, apiToken: user.api_token });
  });
});

app.get('/api/dashboard/stats', verifyToken, (req, res) => {
  db.get(`SELECT balance, cost_per_request FROM users WHERE id = ?`, [req.userId], (err, user) => {
    if (err || !user) return res.status(500).send("Error");
    
    let query = `SELECT COUNT(*) as count, SUM(cost) as totalCost FROM api_requests WHERE user_id = ?`;
    let params = [req.userId];
    
    if (req.userRole === 'admin') {
      query = `SELECT COUNT(*) as count, SUM(cost) as totalCost FROM api_requests`;
      params = [];
    }

    db.get(query, params, (err, stats) => {
      res.json({
        balance: user.balance,
        cost_per_request: user.cost_per_request,
        total_requests: stats.count || 0,
        total_cost: stats.totalCost || 0
      });
    });
  });
});

app.get('/api/dashboard/chart-data', verifyToken, (req, res) => {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  
  let reqQuery = `SELECT date(createdAt / 1000.0, 'unixepoch') as day, COUNT(*) as count FROM api_requests WHERE createdAt >= ? AND user_id = ? GROUP BY day`;
  let reqParams = [sevenDaysAgo, req.userId];
  
  let roomQuery = `SELECT date(createdAt / 1000.0, 'unixepoch') as day, COUNT(*) as count FROM rooms WHERE createdAt >= ? AND user_id = ? GROUP BY day`;
  let roomParams = [sevenDaysAgo, req.userId];

  if (req.userRole === 'admin') {
    reqQuery = `SELECT date(createdAt / 1000.0, 'unixepoch') as day, COUNT(*) as count FROM api_requests WHERE createdAt >= ? GROUP BY day`;
    reqParams = [sevenDaysAgo];
    
    roomQuery = `SELECT date(createdAt / 1000.0, 'unixepoch') as day, COUNT(*) as count FROM rooms WHERE createdAt >= ? GROUP BY day`;
    roomParams = [sevenDaysAgo];
  }

  db.all(reqQuery, reqParams, (err, reqData) => {
    if (err) return res.status(500).json({error: err.message});
    db.all(roomQuery, roomParams, (err, roomData) => {
      if (err) return res.status(500).json({error: err.message});
      res.json({ requests: reqData, rooms: roomData });
    });
  });
});

app.get('/api/dashboard/rooms', verifyToken, (req, res) => {
  let query = `SELECT rooms.*, users.username as owner_username
               FROM rooms
               LEFT JOIN users ON rooms.user_id = users.id
               WHERE rooms.user_id = ?
               ORDER BY rooms.createdAt DESC LIMIT 100`;
  let params = [req.userId];

  if (req.userRole === 'admin') {
    query = `SELECT rooms.*, users.username as owner_username
             FROM rooms
             LEFT JOIN users ON rooms.user_id = users.id
             ORDER BY rooms.createdAt DESC LIMIT 100`;
    params = [];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({error: err});
    res.json(rows);
  });
});

app.get('/api/dashboard/rooms/:roomId', verifyToken, (req, res) => {
  const roomId = req.params.roomId;
  let query = `SELECT rooms.*, users.username as owner_username
               FROM rooms
               LEFT JOIN users ON rooms.user_id = users.id
               WHERE rooms.roomId = ?`;
  let params = [roomId];

  if (req.userRole !== 'admin') {
    query += ` AND rooms.user_id = ?`;
    params.push(req.userId);
  }

  db.get(query, params, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Room not found or unauthorized" });

    const live = rooms.get(roomId);
    res.json({
      ...row,
      live: live ? {
        state: live.state,
        playerCount: (live.players || []).length,
        connectedCount: (live.players || []).filter(p => p && p.connected && !p.placeholder).length,
        activeColor: live.activeColor || null,
        secondsRemaining: live.secondsRemaining ?? null
      } : null
    });
  });
});

function cleanupRoomTimers(room) {
  if (!room) return;
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  if (room.lobbyTimer) {
    clearTimeout(room.lobbyTimer);
    room.lobbyTimer = null;
  }
  if (Array.isArray(room.players)) {
    room.players.forEach((p) => {
      if (p && p.forfeitTimer) {
        clearTimeout(p.forfeitTimer);
        p.forfeitTimer = null;
      }
    });
  }
}

app.post('/api/dashboard/rooms/:roomId/force-end', verifyToken, (req, res) => {
  const roomId = req.params.roomId;
  const reason = (req.body && req.body.reason) || 'operator force-ended';

  let query = `SELECT * FROM rooms WHERE roomId = ?`;
  let params = [roomId];

  if (req.userRole !== 'admin') {
    query += ` AND user_id = ?`;
    params.push(req.userId);
  }

  db.get(query, params, (err, row) => {
    if (err || !row) return res.status(404).json({ error: "Room not found or unauthorized" });

    let room = rooms.get(roomId);
    if (!room) {
      // Reconstruct minimal room for webhook from DB row
      let players = [];
      try { players = JSON.parse(row.players || '[]'); } catch (_) { players = []; }
      room = {
        players,
        state: row.state,
        callbackUrl: row.callbackUrl,
        entry_fee: row.entry_fee,
        winning_prize: row.winning_prize,
        room_type: row.room_type,
        waiting_time: row.waiting_time
      };
      rooms.set(roomId, room);
    }

    cleanupRoomTimers(room);

    const previousState = room.state;
    room.state = 'cancelled';
    saveRoomToDb(roomId);

    if (room.callbackUrl) {
      invokeCancelledCallback(room.callbackUrl, roomId, reason);
    }

    io.to(roomId).emit('errorMsg', `Match ended by operator: ${reason}`);
    io.to(roomId).emit('gameOver', {
      reason: 'operator_force_end',
      message: reason
    });

    // Keep cancelled room in DB for audit; drop from memory after notifying
    setTimeout(() => {
      rooms.delete(roomId);
    }, 500);

    res.json({
      message: "Room force-ended",
      roomId,
      previousState,
      webhookSent: Boolean(room.callbackUrl)
    });
  });
});

app.delete('/api/dashboard/rooms/:roomId', verifyToken, (req, res) => {
  const roomId = req.params.roomId;
  let query = `SELECT * FROM rooms WHERE roomId = ?`;
  let params = [roomId];
  
  if (req.userRole !== 'admin') {
    query += ` AND user_id = ?`;
    params.push(req.userId);
  }

  db.get(query, params, (err, row) => {
    if (err || !row) return res.status(404).json({ error: "Room not found or unauthorized" });

    const live = rooms.get(roomId);
    cleanupRoomTimers(live);
    
    db.run(`DELETE FROM rooms WHERE roomId = ?`, [roomId], (err) => {
      if (err) return res.status(500).json({ error: "Database error" });
      rooms.delete(roomId);
      res.json({ message: "Room deleted successfully" });
    });
  });
});

app.get('/api/dashboard/requests', verifyToken, (req, res) => {
  let query = `SELECT api_requests.*, users.username as owner_username
               FROM api_requests
               LEFT JOIN users ON api_requests.user_id = users.id
               WHERE api_requests.user_id = ?
               ORDER BY api_requests.createdAt DESC LIMIT 100`;
  let params = [req.userId];

  if (req.userRole === 'admin') {
    query = `SELECT api_requests.*, users.username as owner_username
             FROM api_requests
             LEFT JOIN users ON api_requests.user_id = users.id
             ORDER BY api_requests.createdAt DESC LIMIT 100`;
    params = [];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({error: err});
    res.json(rows);
  });
});

// Account (self-service)
app.get('/api/account/me', verifyToken, (req, res) => {
  db.get(
    `SELECT id, username, role, api_token, balance, cost_per_request, enabled, createdAt FROM users WHERE id = ?`,
    [req.userId],
    (err, user) => {
      if (err || !user) return res.status(404).json({ error: "User not found" });
      res.json(user);
    }
  );
});

app.post('/api/account/change-password', verifyToken, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "Provide currentPassword and newPassword (min 6 chars)" });
  }

  db.get(`SELECT * FROM users WHERE id = ?`, [req.userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: "User not found" });
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    const hash = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(10));
    db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, req.userId], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ message: "Password updated" });
    });
  });
});

app.post('/api/account/regenerate-key', verifyToken, (req, res) => {
  const apiToken = generateApiToken();
  db.run(`UPDATE users SET api_token = ? WHERE id = ?`, [apiToken, req.userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "API key regenerated", apiToken });
  });
});

// Admin ONLY Routes
app.get('/api/admin/users', [verifyToken, verifyAdmin], (req, res) => {
  db.all(
    `SELECT id, username, role, api_token, balance, cost_per_request, enabled, createdAt FROM users ORDER BY id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.post('/api/admin/users', [verifyToken, verifyAdmin], (req, res) => {
  const { username, password, balance, cost_per_request } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);
  const apiToken = generateApiToken();

  db.run(
    `INSERT INTO users (username, password_hash, role, api_token, balance, cost_per_request, enabled, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [username, hash, 'user', apiToken, balance || 0, cost_per_request || 1, 1, Date.now()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "User created successfully!", id: this.lastID, apiToken });
    }
  );
});

app.put('/api/admin/users/:id', [verifyToken, verifyAdmin], (req, res) => {
  const { balance, cost_per_request } = req.body;
  if (balance === undefined || cost_per_request === undefined) {
    return res.status(400).json({ error: "balance and cost_per_request are required" });
  }
  db.run(`UPDATE users SET balance = ?, cost_per_request = ? WHERE id = ?`,
    [balance, cost_per_request, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "User updated successfully!" });
    });
});

app.post('/api/admin/users/:id/top-up', [verifyToken, verifyAdmin], (req, res) => {
  const amount = Number(req.body && req.body.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: "amount must be a non-zero number" });
  }

  db.get(`SELECT id, balance FROM users WHERE id = ?`, [req.params.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: "User not found" });
    const newBalance = Math.max(0, Number(user.balance) + amount);
    db.run(`UPDATE users SET balance = ? WHERE id = ?`, [newBalance, user.id], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ message: "Balance updated", balance: newBalance, amount });
    });
  });
});

app.post('/api/admin/users/:id/regenerate-key', [verifyToken, verifyAdmin], (req, res) => {
  const apiToken = generateApiToken();
  db.run(`UPDATE users SET api_token = ? WHERE id = ?`, [apiToken, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "User not found" });
    res.json({ message: "API key regenerated", apiToken });
  });
});

app.post('/api/admin/users/:id/reset-password', [verifyToken, verifyAdmin], (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "newPassword is required (min 6 chars)" });
  }
  const hash = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(10));
  db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "User not found" });
    res.json({ message: "Password reset successfully" });
  });
});

app.patch('/api/admin/users/:id/status', [verifyToken, verifyAdmin], (req, res) => {
  const enabled = req.body && req.body.enabled;
  if (enabled !== 0 && enabled !== 1 && enabled !== true && enabled !== false) {
    return res.status(400).json({ error: "enabled must be true/false or 1/0" });
  }
  const value = (enabled === true || enabled === 1) ? 1 : 0;

  if (Number(req.params.id) === Number(req.userId) && value === 0) {
    return res.status(400).json({ error: "You cannot disable your own account" });
  }

  db.run(`UPDATE users SET enabled = ? WHERE id = ?`, [value, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "User not found" });
    res.json({ message: value ? "User enabled" : "User disabled", enabled: value });
  });
});

app.delete('/api/admin/users/:id', [verifyToken, verifyAdmin], (req, res) => {
  const userId = req.params.id;
  if (Number(userId) === Number(req.userId)) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }
  db.run(`DELETE FROM users WHERE id = ?`, [userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "User deleted successfully!" });
  });
});
// --- END DASHBOARD API ROUTES ---

// Socket server integration
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle player joining a room
  socket.on('joinRoom', ({ roomId, uid }) => {
    console.log(`Player trying to join room: ${roomId} with UID: ${uid}`);
    
    // First check if room is in SQLite (in case server restarted or cold room)
    db.get(`SELECT * FROM rooms WHERE roomId = ?`, [roomId], (err, row) => {
      if (err) {
        console.error("DB error in joinRoom:", err);
        socket.emit('errorMsg', 'Internal server error occurred.');
        return;
      }

      let room = rooms.get(roomId);
      if (!room && !row) {
        console.log(`Join attempt failed: Room ${roomId} does not exist.`);
        socket.emit('errorMsg', 'Room does not exist!');
        return;
      }

      if (row && !room) {
        // Reconstruct room from DB row
        room = {
          players: JSON.parse(row.players),
          state: row.state,
          callbackUrl: row.callbackUrl,
          lives: JSON.parse(row.lives),
          activeColor: row.activeColor,
          turnState: row.turnState,
          rolledValue: row.rolledValue,
          secondsRemaining: row.secondsRemaining,
          boardState: JSON.parse(row.boardState),
          createdAt: row.createdAt,
          userId: row.user_id,
          entry_fee: row.entry_fee || 0,
          winning_prize: row.winning_prize || 0,
          waiting_time: row.waiting_time || 60,
          room_type: row.room_type || 'private'
        };
        room.colorMap = {};
        if (Array.isArray(room.players)) {
          room.players.forEach(p => {
            if (p.uid && p.color) {
              room.colorMap[p.uid] = p.color;
            }
          });
        }
        rooms.set(roomId, room);
      }

      // For public rooms, only allow matched/pre-reserved players to join
      if (room.room_type === 'public' && room.state === 'waiting') {
        const isReserved = room.players.some(p => p.uid === uid);
        if (!isReserved) {
          socket.emit('errorMsg', 'You are not matched/authorized to join this public room.');
          return;
        }
      }

      // Try to locate re-connecting player by UID (Only for in-progress games)
      const existingPlayer = room.players.find(p => p.uid === uid);
      if (existingPlayer && room.state === 'playing') {
        console.log(`Player ${existingPlayer.name || 'Unknown'} reconnected to room ${roomId} with UID ${uid}`);
        
        if (existingPlayer.forfeitTimer) {
          clearTimeout(existingPlayer.forfeitTimer);
          existingPlayer.forfeitTimer = null;
        }
        
        existingPlayer.id = socket.id;
        existingPlayer.connected = true;
        room.colorMap = room.colorMap || {};
        room.colorMap[existingPlayer.uid] = existingPlayer.color;
        
        socket.join(roomId);
        socket.emit('colorAssigned', {
          ...playerPublicInfo(existingPlayer),
          secondsRemaining: room.secondsRemaining
        });
        
        saveRoomToDb(roomId);

        // Notify the other opponent that player reconnected
        socket.to(roomId).emit('opponentReconnected', {
          playerName: existingPlayer.name,
          color: existingPlayer.color,
          ...playerPublicInfo(existingPlayer)
        });

        // Fetch opponent info
        const opponent = room.players.find(p => p.uid !== uid);
        const opponentInfo = playerPublicInfo(opponent);

        // Emit gameResumed carrying state coordinates
        socket.emit('gameResumed', {
          roomId,
          myColor: existingPlayer.color,
          opponentName: opponentInfo.name,
          opponentUid: opponentInfo.uid,
          opponentAvater_url: opponentInfo.avater_url,
          opponentAvatarUrl: opponentInfo.avatar_url,
          player1: playerPublicInfo(room.players[0]),
          player2: playerPublicInfo(room.players[1]),
          players: playersPublicList(room),
          boardState: room.boardState,
          lives: room.lives,
          activeColor: room.activeColor,
          turnState: room.turnState,
          rolledValue: room.rolledValue,
          secondsRemaining: room.secondsRemaining
        });

        // Resume countdown timer if both players are back.
        // Delay by 2 seconds so the reconnecting client has time to fully
        // restore its board state before the first timer tick arrives.
        if (room.players.every(p => p.connected)) {
          console.log(`Both players active in room ${roomId}. Resuming timer in 2 seconds...`);
          setTimeout(() => {
            const r = rooms.get(roomId);
            if (r && r.state === 'playing' && r.players.every(p => p.connected)) {
              startRoomTimer(roomId);
            }
          }, 2000);
        }
        return;
      }

      // Check full capacity (if not in wait state)
      if (room.state === 'playing' || (room.state !== 'waiting' && room.players.length >= 2)) {
        socket.emit('errorMsg', 'Room is currently in progress or full!');
        return;
      }

      // Check if player is already in room or has a pre-reserved slot
      let player = room.players.find(p => p.uid === uid);
      if (player) {
        // Activate pre-reserved slot
        player.id = socket.id;
        player.connected = true;
        delete player.placeholder;
        console.log(`Activated reserved slot for player ${player.name || 'Unknown'} in room ${roomId}`);
      } else {
        // Fallback for private rooms / direct socket joins without pre-reservation
        if (room.players.length >= 2) {
          socket.emit('errorMsg', 'Room is full! Maximum 2 players allowed.');
          return;
        }
        const color = room.players.length === 0 ? 'red' : 'yellow';
        player = {
          id: socket.id,
          name: 'Player',
          uid: uid,
          color: color,
          connected: true,
          avater_url: '',
          avatar_url: ''
        };
        room.players.push(player);
        console.log(`Added new player ${player.name} to room ${roomId}`);
      }

      // For private rooms, start the lobby waiting timer when the first player actually joins the socket lobby
      if (room.room_type !== 'public' && !room.lobbyTimer) {
        const waitTimeSeconds = room.waiting_time || 60;
        room.lobbyTimerStartedAt = Date.now();
        console.log(`Room ${roomId} (Private): Player socket joined. Starting ${waitTimeSeconds}-second lobby wait timer...`);
        room.lobbyTimer = setTimeout(() => {
          const r = rooms.get(roomId);
          if (r && r.state === 'waiting' && r.players.filter(p => p.connected && !p.placeholder).length === 1) {
            console.log(`Room ${roomId}: No opponent joined within ${waitTimeSeconds} seconds. Match cancelled.`);
            r.state = 'cancelled';
            
            io.to(roomId).emit('gameOver', {
              reason: 'lobby_timeout',
              winnerColor: 'none',
              loserColor: 'none',
              winnerName: '',
              winnerUid: ''
            });
            
            saveRoomToDb(roomId);
            
            if (r.callbackUrl) {
              invokeCancelledCallback(r.callbackUrl, roomId, "opponent not joined");
            }
          }
        }, waitTimeSeconds * 1000);

        if (room.callbackUrl) {
          invokeLobbyOpenedCallback(room.callbackUrl, roomId, room);
        }
      }

      socket.join(roomId);

      let remainingSeconds = room.waiting_time || 60;
      if (room.room_type === 'public') {
        const elapsedSeconds = Math.floor((Date.now() - room.createdAt) / 1000);
        remainingSeconds = Math.max(0, (room.waiting_time || 60) - elapsedSeconds);
      } else if (room.lobbyTimerStartedAt) {
        const elapsedSeconds = Math.floor((Date.now() - room.lobbyTimerStartedAt) / 1000);
        remainingSeconds = Math.max(0, (room.waiting_time || 60) - elapsedSeconds);
      }

      socket.emit('colorAssigned', {
        ...playerPublicInfo(player),
        secondsRemaining: remainingSeconds
      });
      
      io.to(roomId).emit('roomUpdate', { players: playersPublicList(room) });

      if (row && row.callbackUrl) {
        room.callbackUrl = row.callbackUrl;
      }

      saveRoomToDb(roomId);

      // Check if both players are connected and slot placeholders are activated to start the game
      const connectedPlayers = room.players.filter(p => p.connected && !p.placeholder);
      if (connectedPlayers.length === 2) {
        // Clear lobby join timeout
        if (room.lobbyTimer) {
          clearTimeout(room.lobbyTimer);
          room.lobbyTimer = null;
        }

        room.state = 'playing';
        room.lives = { red: 5, yellow: 5 };
        room.activeColor = 'red';
        room.turnState = 'roll';
        room.secondsRemaining = 10;

        // Build uid→color map for authoritative turn validation
        room.colorMap = {};
        connectedPlayers.forEach(p => {
          room.colorMap[p.uid] = p.color;
        });
        
        saveRoomToDb(roomId);

        console.log(`Room ${roomId} is full and both players are connected. Starting game!`);
        const p1 = playerPublicInfo(room.players[0]);
        const p2 = playerPublicInfo(room.players[1]);
        io.to(roomId).emit('gameStart', {
          roomId: roomId,
          player1: { ...p1, name: p1.name || 'Player 1' },
          player2: { ...p2, name: p2.name || 'Player 2' },
          players: playersPublicList(room),
          startingTurn: 'red'
        });

        if (room.callbackUrl) {
          invokeMatchStartedCallback(room.callbackUrl, roomId, room);
        }

        startRoomTimer(roomId);
      }
    });
  });

  // Sync dice rolling (server-authoritative dice generation)
  socket.on('rollDice', ({ roomId, rollerColor, uid }) => {
    const room = rooms.get(roomId);
    if (room && room.state === 'playing') {
      // ── UID-BASED TURN GUARD ─────────────────────────────────────────────────
      // Accept the roll only from the player whose color matches activeColor.
      // We use uid (sent by client) to look up their authoritative color.
      if (room.colorMap && uid) {
        const emitterColor = room.colorMap[uid];
        if (emitterColor !== room.activeColor) {
          console.warn(`Room ${roomId}: Ignoring rollDice from uid=${uid} (color=${emitterColor}), activeColor=${room.activeColor}`);
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────────
      const autoValue = Math.floor(Math.random() * 6) + 1;
      const activeColor = room.activeColor;
      console.log(`Room ${roomId}: ${activeColor} rolled ${autoValue} (server generated)`);

      room.turnState = 'move';
      room.rolledValue = autoValue;
      saveRoomToDb(roomId);
      startRoomTimer(roomId);

      io.to(roomId).emit('diceRolled', { value: autoValue, rollerColor: activeColor });
    }
  });

  // Sync piece movement
  socket.on('movePiece', ({ roomId, color, pieceIndex, steps, uid }) => {
    const room = rooms.get(roomId);
    if (room && room.state === 'playing') {
      // ── UID-BASED TURN GUARD ─────────────────────────────────────────────────
      if (room.colorMap && uid) {
        const emitterColor = room.colorMap[uid];
        if (emitterColor !== room.activeColor) {
          console.warn(`Room ${roomId}: Ignoring movePiece from uid=${uid} (color=${emitterColor}), activeColor=${room.activeColor}`);
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────────
      // Use the server's authoritative activeColor instead of the client's `color`
      const authorColor = room.activeColor;
      console.log(`Room ${roomId}: ${authorColor} moved piece ${pieceIndex} by ${steps} steps`);
      socket.to(roomId).emit('pieceMoved', { color: authorColor, pieceIndex, steps });

      if (room.timer) {
        clearInterval(room.timer);
        room.timer = null;
      }
      room.rolledValue = -1;
      saveRoomToDb(roomId);

      // Safety grace timer: if client does not send switchTurn or extraChance within 6 seconds,
      // the server automatically switches turn to the opponent to prevent room freezing.
      if (room.moveGraceTimer) {
        clearTimeout(room.moveGraceTimer);
      }
      room.moveGraceTimer = setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.state === 'playing' && !r.timer) {
          console.log(`Room ${roomId}: Safety timeout after movePiece - auto-switching turn from ${r.activeColor}`);
          r.activeColor = r.activeColor === 'red' ? 'yellow' : 'red';
          r.turnState = 'roll';
          r.rolledValue = -1;
          saveRoomToDb(roomId);
          startRoomTimer(roomId);
          io.to(roomId).emit('turnSwitched', { nextColor: r.activeColor });
        }
      }, 6000);
    }
  });

  // Handle extra chance (dice 6, kill opponent piece, or home arrival)
  socket.on('extraChance', ({ roomId, color, uid }) => {
    const room = rooms.get(roomId);
    if (room && room.state === 'playing') {
      if (room.moveGraceTimer) {
        clearTimeout(room.moveGraceTimer);
        room.moveGraceTimer = null;
      }
      // ── UID-BASED TURN GUARD ─────────────────────────────────────────────────
      if (room.colorMap && uid) {
        const emitterColor = room.colorMap[uid];
        if (emitterColor !== room.activeColor) {
          console.warn(`Room ${roomId}: Ignoring extraChance from uid=${uid} (color=${emitterColor}), activeColor=${room.activeColor}`);
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────────
      const authorColor = room.activeColor; // extra chance stays with same player
      console.log(`Room ${roomId}: ${authorColor} earned extra chance`);
      room.turnState = 'roll';
      room.rolledValue = -1;
      saveRoomToDb(roomId);
      startRoomTimer(roomId);
      io.to(roomId).emit('extraChanceGranted', { activeColor: authorColor });
    }
  });

  // Sync turn switching
  socket.on('switchTurn', ({ roomId, nextColor, uid }) => {
    const room = rooms.get(roomId);
    if (room && room.state === 'playing') {
      if (room.moveGraceTimer) {
        clearTimeout(room.moveGraceTimer);
        room.moveGraceTimer = null;
      }
      // ── UID-BASED TURN GUARD ─────────────────────────────────────────────────
      // The player emitting switchTurn must be the currently active player,
      // and nextColor must be the OPPONENT's color (not their own).
      if (room.colorMap && uid) {
        const emitterColor = room.colorMap[uid];
        const expectedNextColor = emitterColor === 'red' ? 'yellow' : 'red';
        if (emitterColor !== room.activeColor) {
          console.warn(`Room ${roomId}: Ignoring switchTurn from uid=${uid} (color=${emitterColor}), activeColor=${room.activeColor}`);
          return;
        }
        if (nextColor !== expectedNextColor) {
          console.warn(`Room ${roomId}: Ignoring bad switchTurn nextColor=${nextColor} from ${emitterColor} — forcing ${expectedNextColor}`);
          nextColor = expectedNextColor; // correct it server-side
        }
      }
      // ─────────────────────────────────────────────────────────────────────────
      console.log(`Room ${roomId}: Turn switched to ${nextColor}`);
      room.activeColor = nextColor;
      room.turnState = 'roll';
      room.rolledValue = -1;
      saveRoomToDb(roomId);
      startRoomTimer(roomId);
      io.to(roomId).emit('turnSwitched', { nextColor });
    }
  });

  // Sync board state coordinates reports
  socket.on('syncBoardState', ({ roomId, boardState }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.boardState = boardState;
      saveRoomToDb(roomId);
    }
  });

  // Standard victory signal from client
  socket.on('gameWon', ({ roomId, winnerColor, winnerName, winnerUid }) => {
    const room = rooms.get(roomId);
    if (room && room.state !== 'finished') {
      room.state = 'finished';
      
      if (room.timer) {
        clearInterval(room.timer);
        room.timer = null;
      }

      saveRoomToDb(roomId);

      const loserColor = winnerColor === 'red' ? 'yellow' : 'red';
      const loserPlayer = room.players.find(p => p.color === loserColor);
      const loserName = loserPlayer ? loserPlayer.name : 'Opponent';
      const loserUid = loserPlayer ? loserPlayer.uid : '';

      io.to(roomId).emit('gameOver', {
        reason: 'game_won',
        winnerColor: winnerColor,
        loserColor: loserColor,
        winnerName: winnerName,
        winnerUid: winnerUid,
        loserName: loserName,
        loserUid: loserUid
      });

      if (room.callbackUrl) {
        const loser = resolveLoserFromWinner(room, winnerUid);
        invokeCompletedCallback(room.callbackUrl, roomId, room, {
          winnerName,
          winnerUid,
          loserName: loser.name,
          loserUid: loser.uid,
          endReason: 'game_won'
        });
      }
    }
  });

  // Handle in-game live chat
  socket.on('chatMessage', ({ roomId, message, senderColor }) => {
    console.log(`Room ${roomId}: ${senderColor} sent message: ${message}`);
    socket.to(roomId).emit('chatReceived', { message, senderColor });
  });

  // Handle network latency ping
  socket.on('latencyPing', () => {
    socket.emit('latencyPong');
  });

  // Handle explicit quit from a player (starts 30-second forfeit grace period!)
  socket.on('quitGame', ({ roomId, uid }) => {
    const room = rooms.get(roomId);
    if (room && room.state === 'playing') {
      const leavingPlayer = room.players.find(p => p.uid === uid);
      if (leavingPlayer) {
        console.log(`Room ${roomId}: Player ${leavingPlayer.name} explicitly quit the game.`);
        
        leavingPlayer.connected = false;
        leavingPlayer.leaveReason = 'quit';

        // Clear room timer
        if (room.timer) {
          clearInterval(room.timer);
          room.timer = null;
        }

        // Notify opponent that player is not online
        socket.to(roomId).emit('opponentDisconnected', {
          playerName: leavingPlayer.name,
          color: leavingPlayer.color
        });

        // Start 30 seconds forfeit timer
        if (leavingPlayer.forfeitTimer) {
          clearTimeout(leavingPlayer.forfeitTimer);
        }
        
        leavingPlayer.forfeitTimer = setTimeout(() => {
          const r = rooms.get(roomId);
          if (r && r.state === 'playing') {
            const pCurrent = r.players.find(p => p.uid === leavingPlayer.uid);
            if (pCurrent && !pCurrent.connected) {
              console.log(`Room ${roomId}: Player ${pCurrent.name} failed to return within 30 seconds after quit. Opponent wins!`);
              r.state = 'finished';

              const settle = settleForfeit(roomId, r, pCurrent, pCurrent.leaveReason || 'quit');

              io.to(roomId).emit('gameOver', {
                reason: 'opponent_left',
                loserColor: leavingPlayer.color,
                winnerColor: settle.winnerColor,
                winnerName: settle.winnerName,
                winnerUid: settle.winnerUid,
                loserName: pCurrent ? pCurrent.name : 'Opponent',
                loserUid: pCurrent ? pCurrent.uid : ''
              });

              saveRoomToDb(roomId);
            }
          }
        }, 30000); // 30 seconds forfeit grace period
      }
    }
  });

  // Handle player disconnecting (start 30-second forfeit timer)
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    for (const [roomId, room] of rooms.entries()) {
      const player = room.players.find(p => p.id === socket.id);
      
      if (player) {
        player.connected = false;
        console.log(`Player ${player.name} (${player.color}) disconnected from room ${roomId}`);
        
        if (room.state === 'playing') {
          if (room.timer) {
            clearInterval(room.timer);
            room.timer = null;
          }

          if (!player.leaveReason) {
            player.leaveReason = 'disconnect';
          }
          
          socket.to(roomId).emit('opponentDisconnected', {
            playerName: player.name,
            color: player.color
          });

          // Start 30 seconds forfeit timer
          if (player.forfeitTimer) {
            clearTimeout(player.forfeitTimer);
          }
          player.forfeitTimer = setTimeout(() => {
            const r = rooms.get(roomId);
            if (r && r.state === 'playing') {
              const pCurrent = r.players.find(p => p.uid === player.uid);
              if (pCurrent && !pCurrent.connected) {
                console.log(`Room ${roomId}: Player ${pCurrent.name} failed to reconnect within 30 seconds. Opponent wins!`);
                r.state = 'finished';

                const settle = settleForfeit(roomId, r, pCurrent, pCurrent.leaveReason || 'disconnect');

                io.to(roomId).emit('gameOver', {
                  reason: 'opponent_left',
                  loserColor: player.color,
                  winnerColor: settle.winnerColor,
                  winnerName: settle.winnerName,
                  winnerUid: settle.winnerUid,
                  loserName: pCurrent ? pCurrent.name : 'Opponent',
                  loserUid: pCurrent ? pCurrent.uid : ''
                });

                saveRoomToDb(roomId);
              }
            }
          }, 30000); // 30 seconds forfeit
        }
        
        if (room.state === 'waiting') {
          const remainingPlayers = room.players.filter(p => p.id !== socket.id);
          const remainingConnected = remainingPlayers.filter(p => p && !p.placeholder);

          if (remainingConnected.length === 0) {
            // Last real player closed the lobby — notify operator webhook, then drop from memory
            cleanupRoomTimers(room);
            room.state = 'cancelled';
            player.leaveReason = player.leaveReason || 'disconnect';

            if (room.callbackUrl) {
              invokeCancelledCallback(room.callbackUrl, roomId, 'player left lobby');
            }

            saveRoomToDb(roomId);
            console.log(`Room ${roomId} cancelled: player left lobby while waiting (webhook ${room.callbackUrl ? 'sent' : 'skipped'}).`);

            setTimeout(() => {
              rooms.delete(roomId);
            }, 500);
          } else {
            room.players = remainingPlayers;
            room.players[0].color = 'red';
            
            if (!room.lobbyTimer) {
              const waitTimeSeconds = room.waiting_time || 60;
              room.lobbyTimer = setTimeout(() => {
                const r = rooms.get(roomId);
                if (r && r.state === 'waiting' && r.players.filter(p => p.connected && !p.placeholder).length === 1) {
                  r.state = 'cancelled';
                  io.to(roomId).emit('gameOver', {
                    reason: 'lobby_timeout',
                    winnerColor: 'none',
                    loserColor: 'none',
                    winnerName: '',
                    winnerUid: ''
                  });
                  saveRoomToDb(roomId);
                  if (r.callbackUrl) {
                    invokeCancelledCallback(r.callbackUrl, roomId, "opponent not joined");
                  }
                }
              }, waitTimeSeconds * 1000);
            }
            
            io.to(roomId).emit('roomUpdate', { players: playersPublicList(room) });
            saveRoomToDb(roomId);
          }
        }

        saveRoomToDb(roomId);
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Ludo online backend listening on port ${PORT}`);
});
