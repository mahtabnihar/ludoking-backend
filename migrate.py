import re

with open('/Users/muntasirarafat/Downloads/gamesclub/Ludo_King_Clone-master/backend/server.js', 'r') as f:
    content = f.read()

# Add imports
imports = """const express = require('express');
const http = require('http');
const https = require('https');
const url = require('url');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');

const JWT_SECRET = 'ludo-super-secret-key-123';
"""
content = re.sub(r"const express = require\('express'\);.*const sqlite3 = require\('sqlite3'\)\.verbose\(\);\n", imports, content, flags=re.DOTALL)

# Add express setup
express_setup = """
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
"""
content = content.replace("const app = express();", "const app = express();\n" + express_setup)

# Update SQLite init
sqlite_init_orig = """db.serialize(() => {
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
    createdAt INTEGER
  )`);
});"""

sqlite_init_new = """db.serialize(() => {
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
    user_id INTEGER
  )`);
  
  db.run(`ALTER TABLE rooms ADD COLUMN user_id INTEGER`, (err) => {
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
});
"""
content = content.replace(sqlite_init_orig, sqlite_init_new)

# Update saveRoomToDb to handle user_id
saveRoomOrig = """db.run(`INSERT INTO rooms (roomId, callbackUrl, state, players, lives, activeColor, turnState, rolledValue, secondsRemaining, boardState, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(roomId) DO UPDATE SET"""

saveRoomNew = """db.run(`INSERT INTO rooms (roomId, callbackUrl, state, players, lives, activeColor, turnState, rolledValue, secondsRemaining, boardState, createdAt, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(roomId) DO UPDATE SET
            user_id = excluded.user_id,"""
content = content.replace(saveRoomOrig, saveRoomNew)

bindParamsOrig = """room.boardState || null),
      room.createdAt || Date.now()
    ],"""
bindParamsNew = """room.boardState || null),
      room.createdAt || Date.now(),
      room.userId || null
    ],"""
content = content.replace(bindParamsOrig, bindParamsNew)

# Update reconstruct room from DB
reconstructOrig = """            boardState: JSON.parse(row.boardState),
            createdAt: row.createdAt
          };"""
reconstructNew = """            boardState: JSON.parse(row.boardState),
            createdAt: row.createdAt,
            userId: row.user_id
          };"""
content = content.replace(reconstructOrig, reconstructNew)

# Update API Create Room
apiCreateRoomOrig = """app.post('/api/create-room', express.json(), (req, res) => {
  const { call_back } = req.body;
  if (!call_back) {
    return res.status(400).json({ error: "Missing 'call_back' parameter" });
  }

  // Generate a unique 6-digit room ID
  let roomId;
  do {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(roomId));

  const room = {
    players: [],
    state: 'waiting',
    callbackUrl: call_back,
    createdAt: Date.now()
  };
  rooms.set(roomId, room);

  // Save to DB immediately
  db.run(`INSERT INTO rooms (roomId, callbackUrl, state, players, lives, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [roomId, call_back, 'waiting', '[]', JSON.stringify({ red: 5, yellow: 5 }), room.createdAt],
    (err) => {
      if (err) {
        console.error("Error creating room in DB:", err);
        return res.status(500).json({ error: "Database error" });
      }
      console.log(`Created room ID: ${roomId} with callback: ${call_back}`);
      return res.status(201).json({
        room_id: roomId
      });
    }
  );
});"""

apiCreateRoomNew = """app.post('/api/create-room', (req, res) => {
  const apiToken = req.headers['x-api-token'];
  if (!apiToken) {
    return res.status(401).json({ error: "Missing x-api-token header" });
  }

  db.get(`SELECT * FROM users WHERE api_token = ?`, [apiToken], (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: "Invalid API token" });
    }

    if (user.balance < user.cost_per_request) {
      return res.status(402).json({ error: "Insufficient balance" });
    }

    const { call_back } = req.body;
    if (!call_back) {
      return res.status(400).json({ error: "Missing 'call_back' parameter" });
    }

    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [user.cost_per_request, user.id]);
    db.run(`INSERT INTO api_requests (user_id, endpoint, method, cost, createdAt) VALUES (?, ?, ?, ?, ?)`, 
           [user.id, '/api/create-room', 'POST', user.cost_per_request, Date.now()]);

    let roomId;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(roomId));

    const room = {
      players: [],
      state: 'waiting',
      callbackUrl: call_back,
      userId: user.id,
      createdAt: Date.now()
    };
    rooms.set(roomId, room);

    db.run(`INSERT INTO rooms (roomId, callbackUrl, state, players, lives, createdAt, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [roomId, call_back, 'waiting', '[]', JSON.stringify({ red: 5, yellow: 5 }), room.createdAt, user.id],
      (err) => {
        if (err) {
          console.error("Error creating room in DB:", err);
          return res.status(500).json({ error: "Database error" });
        }
        console.log(`Created room ID: ${roomId} with callback: ${call_back}`);
        return res.status(201).json({ room_id: roomId });
      }
    );
  });
});
"""
content = content.replace(apiCreateRoomOrig, apiCreateRoomNew)

dashboard_routes = """
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

app.get('/api/dashboard/rooms', verifyToken, (req, res) => {
  let query = `SELECT * FROM rooms WHERE user_id = ? ORDER BY createdAt DESC LIMIT 50`;
  let params = [req.userId];
  
  if (req.userRole === 'admin') {
    query = `SELECT * FROM rooms ORDER BY createdAt DESC LIMIT 50`;
    params = [];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({error: err});
    res.json(rows);
  });
});

app.get('/api/dashboard/requests', verifyToken, (req, res) => {
  let query = `SELECT * FROM api_requests WHERE user_id = ? ORDER BY createdAt DESC LIMIT 50`;
  let params = [req.userId];
  
  if (req.userRole === 'admin') {
    query = `SELECT * FROM api_requests ORDER BY createdAt DESC LIMIT 50`;
    params = [];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({error: err});
    res.json(rows);
  });
});


// Admin ONLY Routes
app.get('/api/admin/users', [verifyToken, verifyAdmin], (req, res) => {
  db.all(`SELECT id, username, role, api_token, balance, cost_per_request, createdAt FROM users`, [], (err, rows) => {
    res.json(rows);
  });
});

app.post('/api/admin/users', [verifyToken, verifyAdmin], (req, res) => {
  const { username, password, balance, cost_per_request } = req.body;
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);
  const apiToken = 'user-' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  
  db.run(`INSERT INTO users (username, password_hash, role, api_token, balance, cost_per_request, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [username, hash, 'user', apiToken, balance || 0, cost_per_request || 1, Date.now()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "User created successfully!", id: this.lastID });
    });
});

app.put('/api/admin/users/:id', [verifyToken, verifyAdmin], (req, res) => {
  const { balance, cost_per_request } = req.body;
  db.run(`UPDATE users SET balance = ?, cost_per_request = ? WHERE id = ?`, 
    [balance, cost_per_request, req.params.id], 
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "User updated successfully!" });
    });
});
// --- END DASHBOARD API ROUTES ---

// Socket server integration
"""
content = content.replace("// Socket server integration\n", dashboard_routes)

joinRoomOrig = """socket.on('joinRoom', ({ roomId, playerName, uid }) => {
    console.log(`Player ${playerName} trying to join room: ${roomId} with UID: ${uid}`);
    
    // First check if room is in SQLite (in case server restarted or cold room)"""

joinRoomNew = """socket.on('joinRoom', ({ roomId, playerName, uid, apiToken }) => {
    console.log(`Player ${playerName} trying to join room: ${roomId} with UID: ${uid}`);
    
    if (!apiToken) {
      socket.emit('errorMsg', 'Missing API Token. Update your game client to pass x-api-token');
      return;
    }

    db.get(`SELECT * FROM users WHERE api_token = ?`, [apiToken], (err, user) => {
      if (err || !user) {
        socket.emit('errorMsg', 'Invalid API Token!');
        return;
      }
      
      if (user.balance < user.cost_per_request) {
        socket.emit('errorMsg', 'Insufficient balance to join game!');
        return;
      }

      // Deduct balance and log
      db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [user.cost_per_request, user.id]);
      db.run(`INSERT INTO api_requests (user_id, endpoint, method, cost, createdAt) VALUES (?, ?, ?, ?, ?)`, 
             [user.id, 'socket:joinRoom', 'WS', user.cost_per_request, Date.now()]);

    // First check if room is in SQLite (in case server restarted or cold room)"""
content = content.replace(joinRoomOrig, joinRoomNew)

joinRoomCloseOrig = """        startRoomTimer(roomId);
      }
    });
  });

  // Sync dice rolling"""
joinRoomCloseNew = """        startRoomTimer(roomId);
      }
    });
    }); // Close db.get user validation
  });

  // Sync dice rolling"""
content = content.replace(joinRoomCloseOrig, joinRoomCloseNew)

with open('/Users/muntasirarafat/Downloads/gamesclub/Ludo_King_Clone-master/backend/server.js', 'w') as f:
    f.write(content)

print("Migration complete!")
