# Ludo SaaS API Documentation

This document describes the API endpoints, authentication mechanisms, and WebSocket events available for the Ludo SaaS platform.

## Authentication

All standard API endpoints (except `/api/auth/login`) require authentication. There are two types of authentication:
1. **API Keys** (`x-api-token`): Used by external applications (e.g., your Flutter app) to programmatically create rooms or join games.
2. **Dashboard JWTs** (`Authorization: Bearer <token>`): Used exclusively by the frontend dashboard.

---

## 1. Game Server API (For External Clients)

These endpoints and events are used by the Ludo Game Client to interact with the backend.

### **Create a New Room**
Creates a new Ludo game room and deducts the request cost from your balance.

* **URL:** `/api/create-room`
* **Method:** `POST`
* **Headers:**
  * `Content-Type: application/json`
  * `x-api-token: <Your_API_Key>`
* **Body Parameters:**
  * `call_back` (string, required): The webhook URL that the server will invoke.
  * `entry_fee` (number, optional): The entry fee for the match (default 0).
  * `winning_prize` (number, optional): The winning prize for the match (default 0).
  * `waiting_time` (number, optional): The lobby timeout duration in seconds (default 60).
  * `room_type` (string, optional): Either `"private"` or `"public"` (default `"private"`).
  * `uid` (string, required for public rooms): The unique user ID of the matchmaking player.
  * `playerName` (string, optional): The name of the player (default "Player").
  * `avater_url` (string, optional): The URL to the player's avatar.
* **Public Matchmaking Behavior:**
  If `room_type` is set to `"public"`, the server uses the `uid` to perform a slot reservation. It searches for an existing waiting public room matching the same `entry_fee` and `winning_prize` that has less than 2 players. 
  - If found and the player is not already matched, it reserves a slot for the user's `uid`, setting their name and avatar, and returns the matched room ID.
  - If no suitable room is found, it creates a new room, reserves the first slot for the user's `uid` (with their name and avatar), and returns the new room ID.
  This prevents concurrent players from getting matched into the same over-allocated room code.
* **Success Response:**
  * **Code:** `201 Created`
  * **Content:** `{ "room_id": "123456" }`
* **Error Responses:**
  * `401 Unauthorized`: "Missing x-api-token header" or "Invalid API token"
  * `402 Payment Required`: "Insufficient balance"

### **WebSocket Connection & Joining**
To interact with the real-time game server, clients must connect via Socket.io and emit the `joinRoom` event.

* **Connection URL:** `ws://your-server-ip:3000` (Socket.IO format)
* **Event:** `joinRoom`
* **Payload:**
  ```json
  {
    "roomId": "123456",
    "uid": "unique-user-id-123"
  }
  ```
* **Note:** WebSocket connection and joining is free and does not require an API token. Player configurations (name, avatar, entry fee, etc.) are retrieved from the slot reserved during room creation.

---

## 2. Webhook Callbacks

The backend invokes the `call_back` URL with `POST` requests (`Content-Type: application/json`) as the match lifecycle progresses.

### Event sequence

1. `lobby_opened` — waiting lobby becomes active  
2. then either `cancelled` (no opponent / host left lobby) **or** `started` (both players connected)  
3. if someone leaves mid-match and the 30s forfeit settles: `player_left` then `completed`  
4. otherwise on settle: `completed` only (`end_reason`: `game_won` or `lives_ended`)

### Shared envelope (all events)

| Field | Description |
|---|---|
| `status` | Corrected event name (prefer this) |
| `legacy_status` | Present on `completed` (`"complite"`) and `cancelled` (`"cancled"`) for older receivers |
| `room_id` | Room code |
| `entry_fee` | Entry fee |
| `winning_prize` | Winning prize |
| `room_type` | `"public"` or `"private"` |
| `timestamp` | Unix time in milliseconds |
| `players` | Array of `{ name, uid, color, avater_url, avatar_url }` |

Player objects always include both `avater_url` and `avatar_url` (same value).

### **Lobby Opened**
Triggered when the waiting lobby becomes active:
- **Public:** when a **new** room is created via `/api/create-room` (not when matching into an existing room)
- **Private:** when the first player joins via WebSocket (`joinRoom`) and the lobby timer starts

* **Body:**
  ```json
  {
    "status": "lobby_opened",
    "room_id": "123456",
    "entry_fee": 100,
    "winning_prize": 500,
    "room_type": "private",
    "waiting_time": 60,
    "timestamp": 1710000000000,
    "host": {
      "name": "HostPlayer",
      "uid": "uid-1",
      "color": "red",
      "avater_url": "http://example.com/avatar1.jpg",
      "avatar_url": "http://example.com/avatar1.jpg"
    },
    "players": [
      {
        "name": "HostPlayer",
        "uid": "uid-1",
        "color": "red",
        "avater_url": "http://example.com/avatar1.jpg",
        "avatar_url": "http://example.com/avatar1.jpg"
      }
    ]
  }
  ```

### **Match Started**
Triggered when both players are connected and the game starts.

* **Body:**
  ```json
  {
    "status": "started",
    "room_id": "123456",
    "entry_fee": 100,
    "winning_prize": 500,
    "room_type": "public",
    "timestamp": 1710000000000,
    "players": [
      {
        "name": "HostPlayer",
        "uid": "uid-1",
        "color": "red",
        "avater_url": "http://example.com/avatar1.jpg",
        "avatar_url": "http://example.com/avatar1.jpg"
      },
      {
        "name": "GuestPlayer",
        "uid": "uid-2",
        "color": "yellow",
        "avater_url": "http://example.com/avatar2.jpg",
        "avatar_url": "http://example.com/avatar2.jpg"
      }
    ],
    "player1": {
      "name": "HostPlayer",
      "uid": "uid-1",
      "color": "red",
      "avater_url": "http://example.com/avatar1.jpg",
      "avatar_url": "http://example.com/avatar1.jpg"
    },
    "player2": {
      "name": "GuestPlayer",
      "uid": "uid-2",
      "color": "yellow",
      "avater_url": "http://example.com/avatar2.jpg",
      "avatar_url": "http://example.com/avatar2.jpg"
    }
  }
  ```

### **Match Cancelled (Lobby Timeout / Lobby Abandoned)**
Triggered when:
- no opponent joins within the lobby waiting time (`reason: "opponent not joined"`), or
- the last player closes/leaves the waiting lobby (`reason: "player left lobby"`)

* **Body:**
  ```json
  {
    "status": "cancelled",
    "legacy_status": "cancled",
    "reason": "opponent not joined",
    "reson": "oponent not joined",
    "room_id": "123456",
    "entry_fee": 100,
    "winning_prize": 500,
    "room_type": "public",
    "timestamp": 1710000000000,
    "players": []
  }
  ```

For lobby abandon, `reason` / `reson` are `"player left lobby"` and `players` still includes the departing host at send time.

### **Player Left (Mid-Match)**
Triggered after the 30-second forfeit grace period when a player quit or disconnected and did not return. Immediately followed by a `completed` callback with `end_reason: "opponent_left"`.

* **Body:**
  ```json
  {
    "status": "player_left",
    "room_id": "123456",
    "entry_fee": 100,
    "winning_prize": 500,
    "room_type": "public",
    "timestamp": 1710000000000,
    "leave_reason": "quit",
    "left_player": {
      "name": "Leaver",
      "uid": "uid-1",
      "color": "red",
      "avater_url": "http://example.com/avatar1.jpg",
      "avatar_url": "http://example.com/avatar1.jpg"
    },
    "stayed_player": {
      "name": "Stayer",
      "uid": "uid-2",
      "color": "yellow",
      "avater_url": "http://example.com/avatar2.jpg",
      "avatar_url": "http://example.com/avatar2.jpg"
    },
    "players": []
  }
  ```

`leave_reason` is `"quit"` (explicit `quitGame`) or `"disconnect"` (socket disconnect).

### **Match Completed**
Triggered when a game finishes. Prefer `status: "completed"`; `legacy_status: "complite"` is kept for older receivers.

* **Body:**
  ```json
  {
    "status": "completed",
    "legacy_status": "complite",
    "end_reason": "opponent_left",
    "winner_name": "Stayer",
    "winnner_name": "Stayer",
    "winner_uid": "uid-2",
    "loser_name": "Leaver",
    "loser_uid": "uid-1",
    "room_id": "123456",
    "entry_fee": 100,
    "winning_prize": 500,
    "room_type": "public",
    "avater_url": "http://example.com/avatar2.jpg",
    "avatar_url": "http://example.com/avatar2.jpg",
    "timestamp": 1710000000000,
    "players": []
  }
  ```

`end_reason` values:
- `game_won` — normal win signaled by the client
- `opponent_left` — after `player_left` (forfeit)
- `lives_ended` — active player ran out of turn-timer lives

### Compatibility aliases

Prefer corrected fields. Until you migrate, these aliases remain:

| Prefer | Alias |
|---|---|
| `status: "completed"` | `legacy_status: "complite"` |
| `status: "cancelled"` | `legacy_status: "cancled"` |
| `winner_name` | `winnner_name` |
| `reason` | `reson` |
| `avatar_url` | `avater_url` |

---

## 3. Dashboard API (For Internal Admin/User Management)

These endpoints are used by the web dashboard and require a JWT token obtained via Login.

### **Authentication**
* **URL:** `/api/auth/login`
* **Method:** `POST`
* **Body:** `{ "username": "admin", "password": "password" }`
* **Response:** `{ "accessToken": "jwt...", "apiToken": "user-xxx...", "role": "admin" }`

### **Stats & Logs**
* **GET `/api/dashboard/stats`**: Returns the user's available balance, cost per request, total API requests made, and total cost spent.
* **GET `/api/dashboard/rooms`**: Returns a list of the 50 most recent rooms created by the user's API key.
* **GET `/api/dashboard/requests`**: Returns a log of the 50 most recent API/WebSocket requests billed to the user.

*(All dashboard endpoints require the header `Authorization: Bearer <accessToken>`)*

### **Admin Management**
*(Requires `role: admin`)*
* **GET `/api/admin/users`**: Retrieve a list of all users, their balances, and their API keys.
* **POST `/api/admin/users`**: Create a new user account and auto-generate an API key.
  * **Body:** `{ "username": "...", "password": "...", "balance": 100, "cost_per_request": 1 }`
* **PUT `/api/admin/users/:id`**: Update a user's billing settings.
  * **Body:** `{ "balance": 500, "cost_per_request": 2 }`
