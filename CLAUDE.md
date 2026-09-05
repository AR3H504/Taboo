# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A real-time, multiplayer Taboo-style word-guessing game. Node/Express serves static
frontend files and Socket.IO carries all game state and events between server and
clients — there is no build step and no client-side framework.

## Commands

```bash
npm install     # install dependencies
node server.js  # run the server (default port 3000, override with PORT env var)
```

There is no test suite, linter, or build step configured (`npm test` is a stub that
exits with an error). There's also no auto-restart — kill and re-run `node server.js`
after editing `server.js`.

## Architecture

**Everything server-side lives in one file: `server.js`.** All game state, all
Socket.IO event handlers, word-matching logic, and round/timer logic are in there —
there is no router/model/controller split. Read the whole file before making changes;
handlers depend heavily on shared closures (`rooms`, `io`) and on each other's
side effects.

**Frontend is three static files in `public/`, no bundler:**
- `index.html` — the full player-facing game UI (lobby, join/create, describer view,
  guesser view, round review, settings) as one large inline-script file.
- `spectate.html` — a read-only spectator dashboard. Joins a room's Socket.IO channel
  via a separate `spectateRoom` event without ever appearing in the player roster.
- `style.css` — shared styles.

Express just does `app.use(express.static('public'))`; all real interaction happens
over Socket.IO events, so cross-reference the `socket.on`/`socket.emit` calls in
`server.js` against the matching calls in `index.html`/`spectate.html` when tracing a
feature end-to-end.

### Room / game state model

All live game state lives in the in-memory `rooms` object (`rooms[roomCode] → room`),
not a database — restarting the server wipes every game. A room holds:

- `players`, `teams.{red,blue}` — roster and per-team score/player lists.
- `describers.{red,blue}` — socket id of each team's current describer.
- `currentTurn`, `currentRound`, `roundActive`, `inReview` — whose turn it is and what
  phase the room is in.
- `words` — the live in-play word list for the current round (words are removed once
  finished).
- `observerWords` — every word shown this round, never removed, each carrying its own
  `status` (`active`/`partial`/`done`). This is the single source of truth for both
  the opposing team's live view and the end-of-round review payload.
- `remainingWords` — a lazily-refilled reveal queue (see `ensureWordSupply`/
  `pullWords`); words are drawn on demand rather than pre-allocated per round, so a
  round never runs dry regardless of how fast a team burns through words.

Word objects handed to a room are always fresh instances (`instantiateWord`) — never
share references from the loaded `wordPacks` pack arrays across rooms/rounds, since
per-round mutable state (`status`, `partialPoints`, `guessedBy`) lives directly on the
word object.

### Guess matching (`socket.on('guess', ...)`)

1. Exact (case-insensitive) match against any word still in `room.words` — full
   points if `active`, remaining points if already `partial`.
2. Otherwise, Levenshtein-distance fuzzy match against words still `active` (not
   `partial` — a partially-matched word can only be completed by an exact guess).
   Tolerance scales with word length (`maxFuzzyDistance`); ties between two equally
   close candidates count as no match rather than guessing wrong.
3. A fuzzy match awards half points and marks the word `partial`; the guesser (or a
   later exact-match guesser) can then finish it for the remainder.

### Word packs

`word-packs/base-words.json` holds `easy`/`medium` arrays of `{ word, points }`.
Loaded once at startup into `wordPacks` and normalized (`normalizeWordList`). Mixed
difficulty draws respect an easy/medium ratio (default 60/40) via `getRandomWords`'s
`enforceRatio` option.

### Anti-cheat / role rules

- Team switching is blocked entirely while a round is active (only allowed between
  rounds) to prevent hopping to the observing team to see words.
- The active describer for the currently-playing team can't change role mid-round.
- Only the current team's assigned describer can start that team's round, and (outside
  of the post-review restart) only once all of that team's non-describer players have
  marked themselves ready.
