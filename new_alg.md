# Auto Rule 1–6 — Dynamic Fair Match Algorithm

Currently, Auto Rule 1–6 generates completely random rolls. We want to introduce a **smart and controlled algorithm** that keeps every match competitive, exciting, and fair for both players.

### 1. Dynamic Catch-Up

The system should continuously compare both players':

- Score
- Token positions
- Tokens outside/home
- Overall advantage

If one player is significantly ahead, the losing player should get a **better chance of useful rolls**.

For example:

- Small difference → Normal randomness
- Medium difference → Slight advantage
- Large difference (10–20+ turns) → Stronger comeback opportunity
- When the match becomes balanced → Return to normal randomness

### 2. Six / Token Entry Balance

If both players are waiting for a 6 and one player gets a 6, brings a token out, and starts getting ahead, the other player should get a **higher chance of getting a 6 or useful roll**.

### 3. Prevent 3+ Consecutive Sixes

The system should prevent **3 or more consecutive 6s** from happening continuously.

For example:

> 6 → 6 → 6 ❌

After 2 consecutive 6s, the probability of another 6 should be heavily reduced. The third number should be random.

### 4. Protect Capture Opportunities

If a player has a realistic opportunity to **eat/capture an opponent's token or catch up to it**, the system should not unfairly prevent that opportunity.

For example:

> Player A is 1–3 moves away from Player B's token.

The algorithm should continue generating **fair/random rolls** so Player A has a genuine chance to reach and capture the opponent's token.

The system should **not intentionally generate a bad roll just because the player is about to capture an opponent**.

### 5. Control Long Good Streaks

If one player continuously receives very good turns, the system should slightly increase the opponent's chance of getting useful turns.

### 6. Keep It Random

The algorithm should **never directly decide the winner**.

It should only adjust probabilities based on the current match situation while preserving genuine gameplay opportunities.

**Main Goal:**

> Detect the match situation → adjust roll probabilities → give the losing player a comeback opportunity → protect genuine capture opportunities → prevent excessive lucky streaks → return to normal randomness when the match is balanced.

The final match should feel **random, fair, competitive, and fun for both players.**