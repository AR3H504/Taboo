# Taboo

A real-time, browser-based Taboo game for two teams. One player describes a word without saying it (or the banned words on the card), their team shouts out guesses, and the other team watches the words live so nobody can cheat. Built with Node, Express, and Socket.IO, no build step required.

## Features

- Red vs. blue team play with live score tracking
- Host-controlled room settings (round length, rounds per team, difficulty, word reveal pace) locked once the game starts, so no mid-game rule changes
- Easy/medium/mixed difficulty word pools, plus a rare high-value "extreme" bonus word each round
- Fuzzy guess matching, so close misspellings still count, with partial credit for near matches that get finished off later
- Live opposing-team view so the other side can watch words get revealed and guessed in real time
- Round-by-round review screen with a points breakdown per guesser
- A separate read-only spectator dashboard for anyone who just wants to watch
- Anti-cheat safeguards: no switching teams mid-round, no swapping out the active describer mid-turn

## Getting started

```bash
npm install
node server.js
```

The server runs on port 3000 by default. Set `PORT` to use a different one:

```bash
PORT=8080 node server.js
```

Then open `http://localhost:3000` in a browser. Share the room code with friends so they can join from their own devices on the same network (or over the internet if you deploy it somewhere).

To watch a game without playing, open `http://localhost:3000/spectate.html` and enter the room code.

There's no auto-reload, so restart the server after any code changes.

## How to play

1. One player creates a room and shares the room code.
2. Everyone else joins, picks a team (red or blue), and picks a role.
3. Each team needs a describer. Everyone else on the team guesses.
4. When it's your team's turn, your describer sees the word (and its taboo words) and describes it without saying any of them. Teammates shout out guesses in the room.
5. Correct guesses score points, and points shrink for words that only got a partial (fuzzy) match until someone nails the exact word.
6. Rounds alternate between teams until the game's round limit is reached, then whoever has the higher score wins.

## Project structure

```
server.js           All server-side game logic and Socket.IO events
public/
  index.html         Full player-facing game UI (lobby, describer/guesser views, review, settings)
  spectate.html       Read-only spectator dashboard
  style.css           Shared styles
word-packs/
  base-words.json     Word lists by difficulty
```

Everything on the server lives in `server.js`, and all game state is kept in memory, so restarting the server clears every room. There's no database and no separate build process for the frontend, it's just static HTML/CSS/JS served by Express.

## Tech stack

- Node.js + Express (serves the static frontend)
- Socket.IO (all real-time game state and events)
- Vanilla HTML/CSS/JS on the client, no framework
