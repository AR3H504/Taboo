const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = process.env.PORT || 3000;

// Function to calculate Levenshtein distance between two strings
function getLevenshteinDistance(str1, str2) {
    const matrix = Array(str2.length + 1).fill().map(() => Array(str1.length + 1).fill(0));

    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= str2.length; j++) {
        for (let i = 1; i <= str1.length; i++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1, // deletion
                matrix[j - 1][i] + 1, // insertion
                matrix[j - 1][i - 1] + cost // substitution
            );
        }
    }
    return matrix[str2.length][str1.length];
}

// Load word packs
let wordPacks = {};
try {
    const baseWords = JSON.parse(fs.readFileSync(path.join(__dirname, 'word-packs', 'base-words.json'), 'utf8'));
    wordPacks = baseWords;
} catch (err) {
    console.error('Error loading word packs:', err);
    wordPacks = { easy: [], medium: [] };
}

// Ensure words are normalized objects with difficulty tag
function normalizeWordList(list, difficulty) {
    if (!Array.isArray(list)) return [];
    return list.map(w => {
        if (!w) return null;
        if (typeof w === 'string') {
            return { word: w, points: difficulty === 'easy' ? 6 : 15, difficulty };
        }
        // If object, ensure keys exist
        const obj = { ...w };
        if (!obj.word && obj.name) obj.word = obj.name;
        if (!obj.points) obj.points = (difficulty === 'easy' ? 6 : 15);
        obj.difficulty = difficulty;
        return obj;
    }).filter(Boolean);
}

wordPacks.easy = normalizeWordList(wordPacks.easy || [], 'easy');
wordPacks.medium = normalizeWordList(wordPacks.medium || [], 'medium');
// The 'extreme' tier is never part of the normal easy/medium/mixed draw -
// exactly one is added on top of a round's usual words (see startRound),
// regardless of the room's difficulty setting.
wordPacks.extreme = normalizeWordList(wordPacks.extreme || [], 'extreme');
// Serve static files from the 'public' directory
app.use(express.static('public'));

let rooms = {};

// Shared shape for the 'updateGameState' broadcast, used everywhere a room's
// state changes (join, settings, ready, round transitions, disconnect) so
// every emit site stays in sync on fields like hostId/gameStarted instead of
// drifting across the many call sites that need to send this.
function buildGameState(room) {
    return {
        describers: { ...room.describers },
        currentTurn: room.currentTurn,
        currentRound: room.currentRound,
        roundActive: !!room.roundActive,
        settings: room.settings,
        hostId: room.hostId,
        // The game is considered "started" once the first round has begun -
        // settings are only editable before this point (see updateGameSettings).
        gameStarted: room.currentRound > 0,
        players: room.players.map(p => ({ ...p })),
        teams: {
            red: { score: room.teams.red.score },
            blue: { score: room.teams.blue.score }
        }
    };
}

// Every word handed out to a room must be its own object instance. The pack
// arrays in wordPacks are loaded once at startup and reused for every game;
// if a room mutated those shared objects directly (tracking partial-match
// state, completion, etc.) then a word drawn again later - in this room's
// next round, or in any other room - would start out already carrying stale
// state from the last time it was used, silently corrupting scoring.
function instantiateWord(w) {
    return {
        word: w.word,
        difficulty: w.difficulty,
        originalPoints: w.points,
        points: w.points,
        status: 'active', // 'active' | 'partial' | 'done'
        partialPoints: 0,
        guessedBy: null
    };
}

function getRandomWords(n, difficulty = 'mixed', options = {}) {
    // options: { enforceRatio: bool, easyRatio: 0..1 }
    const easy = wordPacks.easy || [];
    const medium = wordPacks.medium || [];

    if (difficulty === 'easy') {
        const shuffled = [...easy].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, n).map(instantiateWord);
    }
    if (difficulty === 'medium') {
        const shuffled = [...medium].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, n).map(instantiateWord);
    }

    // Mixed difficulty
    if (options.enforceRatio) {
        const easyRatio = (typeof options.easyRatio === 'number') ? options.easyRatio : 0.6;
        const numEasy = Math.max(0, Math.min(n, Math.round(n * easyRatio)));
        const numMedium = Math.max(0, n - numEasy);
        const shuffledEasy = [...easy].sort(() => 0.5 - Math.random());
        const shuffledMedium = [...medium].sort(() => 0.5 - Math.random());
        const pickEasy = shuffledEasy.slice(0, numEasy);
        const pickMedium = shuffledMedium.slice(0, numMedium);
        const combined = pickEasy.concat(pickMedium).sort(() => 0.5 - Math.random());
        return combined.slice(0, n).map(instantiateWord);
    }

    // Default: pool all words and randomize
    const pool = [...easy, ...medium];
    if (pool.length === 0) {
        console.error('No words available for mixed difficulty');
        return [];
    }
    const shuffled = pool.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, n).map(instantiateWord);
}

// Draws the round's one "extreme" bonus word, tracking which ones this room
// has already used so a game doesn't repeat one before the whole pool (39
// words) has been through - only relevant once a game runs that long, since
// it recycles (clearing the used-set) rather than getting stuck with none
// left to draw.
function getExtremeBonusWord(room) {
    const pack = wordPacks.extreme || [];
    if (pack.length === 0) return null;
    if (!room.usedExtremeWords) room.usedExtremeWords = new Set();

    let pool = pack.filter(w => !room.usedExtremeWords.has(w.word.toLowerCase()));
    if (pool.length === 0) {
        room.usedExtremeWords.clear();
        pool = pack;
    }

    const chosen = pool[Math.floor(Math.random() * pool.length)];
    room.usedExtremeWords.add(chosen.word.toLowerCase());
    return instantiateWord(chosen);
}

// Top up the room's reveal queue so it never just runs dry mid-round. A
// round's total word count can't be predicted up front - a slow team might
// only get through a handful, a fast one (especially with the burst-refill
// below) can blow through dozens - so words are drawn lazily instead of
// pre-allocating one fixed batch at round start.
function ensureWordSupply(room, minCount) {
    if (!room.remainingWords) room.remainingWords = [];
    if (room.remainingWords.length >= minCount) return;

    const shownTexts = new Set((room.observerWords || []).map(w => w.word.toLowerCase()));
    const need = Math.max(minCount - room.remainingWords.length, 20); // draw generously so this isn't hit every guess
    const difficulty = (room.settings && room.settings.difficulty) || 'mixed';

    let fresh = getRandomWords(need * 3, difficulty, { enforceRatio: true, easyRatio: 0.6 })
        .filter(w => !shownTexts.has(w.word.toLowerCase()));
    if (fresh.length === 0) {
        // The whole pack has already been shown this round - allow repeats
        // rather than letting the round stall out with no words left at all.
        fresh = getRandomWords(need, difficulty, { enforceRatio: true, easyRatio: 0.6 });
    }
    room.remainingWords.push(...fresh.slice(0, need));
}

// Pull up to `count` words off the room's reveal queue, topping it up first.
function pullWords(room, count) {
    ensureWordSupply(room, count);
    if (!room.remainingWords || room.remainingWords.length === 0) return [];
    return room.remainingWords.splice(0, count);
}

// Add already-pulled words into the room's live word state (no emits - callers
// decide what to broadcast and when).
function addWordsToRoom(room, words) {
    for (const w of words) {
        room.words.push(w);
        room.observerWords.push(w);
    }
}

// Fuzzy-match tolerance scales with word length so short words ("poe" vs a
// 4-letter target) aren't absurdly forgiving while long words still allow a
// couple of typos. Returns null (no fuzzy leniency) for very short words.
function maxFuzzyDistance(word) {
    if (word.length <= 3) return 0; // exact only
    if (word.length <= 5) return 1;
    if (word.length <= 8) return 2;
    return 3;
}

io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        rooms[roomCode] = {
            players: [],
            words: getRandomWords(9, 'mixed'),
            describers: { red: null, blue: null },
            hostId: socket.id,
            currentTurn: 'red',
            teams: {
                red: { players: [], score: 0 },
                blue: { players: [], score: 0 }
            },
            roundActive: false,
            inReview: false,
            settings: {
                roundDuration: 90,
                // roundsPerTeam: number of rounds each team will play (so total rounds = roundsPerTeam * 2)
                roundsPerTeam: 12,
                startingWords: 9,
                wordRevealInterval: 15,
                difficulty: 'mixed'  // can be 'easy', 'medium', or 'mixed'
            },
            currentRound: 0,
            wordTimer: null
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log(`Room created: ${roomCode}`);
    });

    

    // When a player joins
    socket.on('joinRoom', (roomCode, name, team, role) => {
        if (!rooms[roomCode]) {
            socket.emit('joinFailed', { reason: 'Room does not exist', field: 'room' });
            return;
        }

        // Prevent duplicate player names (case-insensitive) (allow same socket to change team/role)
        const nameTaken = rooms[roomCode].players.some(p => (p.name || '').toLowerCase() === (name || '').toLowerCase() && p.id !== socket.id);
        if (nameTaken) {
            socket.emit('error', 'That name is already taken in this room');
            return;
        }

        // When socket id already present, allow update (existing connection)
        const existingPlayer = rooms[roomCode].players.find(p => p.id === socket.id);
        if (existingPlayer) {
            // Switching teams mid-round is a cheating vector (e.g. hop to the
            // observing team to see the words, then hop back as a guesser),
            // so it's blocked for anyone while a round is active - freely
            // allowed between rounds. Role changes on your current team are
            // still restricted separately for the active describer below.
            if (rooms[roomCode].roundActive && existingPlayer.team !== team) {
                console.log(`Blocked team switch mid-round: ${existingPlayer.name} (${socket.id}) tried to switch from ${existingPlayer.team} to ${team}`);
                socket.emit('error', "You can't switch teams while a round is active - wait until it ends");
                return;
            }

            // Disallow the active describer from changing role while their team is currently playing
            const playingTeam = rooms[roomCode].currentTurn;
            if (rooms[roomCode].roundActive && existingPlayer.role === 'describer' && existingPlayer.team === playingTeam && existingPlayer.role !== role) {
                console.log(`Blocked describer role switch mid-round: ${existingPlayer.name} (${socket.id}) tried to change to ${role}`);
                socket.emit('error', 'The describer cannot change role while a round is active');
                return;
            }

            // If nothing changed, just return current state
            if (existingPlayer.team === team && existingPlayer.role === role && existingPlayer.name === name) {
                // re-emit state so client stays in sync
                io.to(roomCode).emit('updateGameState', buildGameState(rooms[roomCode]));
                return;
            }

            // Check describer availability when switching into describer role
            if (role === 'describer') {
                const existingDescriber = rooms[roomCode].describers[team];
                if (existingDescriber && existingDescriber !== socket.id) {
                    socket.emit('error', 'Describer role for that team is already taken');
                    return;
                }
            }

            // Remove player from previous team list if changing team
            if (existingPlayer.team !== team) {
                rooms[roomCode].teams[existingPlayer.team].players = rooms[roomCode].teams[existingPlayer.team].players.filter(p => p.id !== socket.id);
                // If they were describer for old team, clear it
                if (rooms[roomCode].describers[existingPlayer.team] === socket.id) {
                    rooms[roomCode].describers[existingPlayer.team] = null;
                }
                // Add to new team's players list (we'll update the existingPlayer below)
                rooms[roomCode].teams[team].players.push(existingPlayer);
            }

            // Update describer slots
            if (existingPlayer.role === 'describer' && role !== 'describer') {
                // leaving describer role for their team
                if (rooms[roomCode].describers[existingPlayer.team] === socket.id) {
                    rooms[roomCode].describers[existingPlayer.team] = null;
                }
            }
            if (role === 'describer') {
                rooms[roomCode].describers[team] = socket.id;
            }

            // Apply updates to the existing player object
            existingPlayer.team = team;
            existingPlayer.role = role;
            existingPlayer.name = name;
            existingPlayer.ready = false; // reset ready on role/team change

            // If the round is active, ensure the switching player receives the correct UI update
            if (rooms[roomCode].roundActive) {
                try {
                    const playingTeam = rooms[roomCode].currentTurn;
                    const words = rooms[roomCode].words || [];
                    // If they are now the describer, send describerWords
                    if (existingPlayer.role === 'describer') {
                        io.to(existingPlayer.id).emit('describerWords', words);
                    } else if (existingPlayer.team === playingTeam) {
                        // Guesser on the playing team
                        io.to(existingPlayer.id).emit('setAsGuesser');
                    } else {
                        // Observer on the non-playing team
                        io.to(existingPlayer.id).emit('observerWords', words);
                    }
                } catch (err) {
                    console.error('Failed to send mid-round UI events to switching player:', err);
                }
            }

            socket.join(roomCode);

            // Emit updated state
            io.to(roomCode).emit('playerList', rooms[roomCode].players);
            io.to(roomCode).emit('updateGameState', buildGameState(rooms[roomCode]));
            return;
        }

        // Check if describer role is available for that team
        if (role === 'describer' && rooms[roomCode].describers[team]) {
            socket.emit('joinFailed', { reason: 'Describer role for that team is already taken', field: 'role' });
            return;
        }
        
        console.log(`Player ${name} joining room ${roomCode} on team ${team} as ${role}`);
        
        // Initialize player
        const newPlayer = { 
            id: socket.id, 
            name,
            team,
            role,
            score: 0,
            ready: false
        };

        // Set as describer for the team if that's their role
        if (role === 'describer') {
            rooms[roomCode].describers[team] = socket.id;
        }
        
        // Add to room's player list and team
        rooms[roomCode].players.push(newPlayer);
        rooms[roomCode].teams[team].players.push(newPlayer);
        
        socket.join(roomCode);
        
        // Send initial game state to all players
        io.to(roomCode).emit('updateGameState', buildGameState(rooms[roomCode]));
        io.to(socket.id).emit('joinSuccess');
        
        // If a round is active, send the appropriate UI state to the new player
        if (rooms[roomCode].roundActive) {
            const playingTeam = rooms[roomCode].currentTurn;
            const words = rooms[roomCode].words || [];
            if (newPlayer.role === 'describer' && newPlayer.team === playingTeam) {
                // Joining as the describer of the playing team
                io.to(newPlayer.id).emit('describerWords', words);
            } else if (newPlayer.team === playingTeam && newPlayer.role !== 'describer') {
                // Joining as a guesser on the playing team
                io.to(newPlayer.id).emit('setAsGuesser');
            } else {
                // Joining as an observer (other team)
                io.to(newPlayer.id).emit('observerWords', words);
            }
            // Also send the round timer
            const timeLeft = rooms[roomCode].roundEndTime ? Math.max(0, Math.ceil((rooms[roomCode].roundEndTime - Date.now()) / 1000)) : 0;
            if (timeLeft > 0) {
                io.to(newPlayer.id).emit('roundStarted', timeLeft);
            }
        }
        
        // Log room state after player joins
        console.log('Room state after join:', {
            roomCode,
            players: rooms[roomCode].players
        });
        
        // Emit updated player list to all clients in the room
        io.to(roomCode).emit('playerList', rooms[roomCode].players);
        
        // Also send an initial score update
        io.to(roomCode).emit('updateScores', rooms[roomCode].players);
        
        console.log(`${name} joined room: ${roomCode} with initial score: 0`);
    });

    // Handle game settings update
    socket.on('updateGameSettings', (roomCode, settings) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Only the player who created the room may change its settings.
        if (room.hostId !== socket.id) {
            socket.emit('error', 'Only the room host can change the game settings');
            return;
        }

        // Settings are only editable in the lobby, before the first round has
        // started - once the game is underway they're locked for its duration
        // so a mid-game change can't retroactively alter rounds already played.
        if (room.currentRound > 0) {
            socket.emit('error', 'Settings are locked once the game has started');
            return;
        }

        // Validate and update settings
        const newSettings = {
            roundDuration: Math.min(Math.max(settings.roundDuration, 30), 300),
            // roundsPerTeam: each team gets this many rounds
            roundsPerTeam: Math.min(Math.max(settings.roundsPerTeam, 1), 10),
            startingWords: Math.min(Math.max(settings.startingWords, 1), 10),
            wordRevealInterval: Math.min(Math.max(settings.wordRevealInterval, 5), 60)
        };

        room.settings = newSettings;

        // First emit the settings update
        io.to(roomCode).emit('gameSettings', newSettings);

        // Then emit a full game state update to refresh the round display
        io.to(roomCode).emit('updateGameState', buildGameState(room));
    });

    socket.on('startRound', (roomCode, duration = 60) => {
        if (!rooms[roomCode]) return;
        // Only the describer of the current team may start the round
        const team = rooms[roomCode].currentTurn;
        const teamDescriberId = rooms[roomCode].describers[team];
        if (teamDescriberId !== socket.id) {
            socket.emit('error', 'Only the current team\'s describer can start the round');
            return;
        }

        // Check if we've played all rounds (roundsPerTeam * 2 total rounds)
        const totalRounds = (rooms[roomCode].settings.roundsPerTeam || 1) * 2;
        if (rooms[roomCode].currentRound >= totalRounds) {
            socket.emit('error', 'All rounds have been played. Game is over!');
            return;
        }

        // Ensure members of the current team (excluding describer) are ready
        // If we're coming from a review state, allow describer to start without readiness
        if (!rooms[roomCode].inReview) {
            const teamPlayers = rooms[roomCode].players.filter(p => p.team === team && p.id !== teamDescriberId);
            const allReady = teamPlayers.length === 0 ? true : teamPlayers.every(p => p.ready);
            if (!allReady) {
                socket.emit('notAllReady');
                return;
            }
        } else {
            // clear review flag when starting the new round
            rooms[roomCode].inReview = false;
        }

        // Get settings for this round
        const settings = rooms[roomCode].settings;
        console.log(`Starting round in room ${roomCode} with ${settings.roundDuration} second duration`);

    // Start the round with initial words. The reveal queue (remainingWords)
    // starts empty on purpose - it's topped up lazily by ensureWordSupply()
    // as words are actually needed (both the timer below and the burst-refill
    // in the guess handler pull through it), so a round never runs dry no
    // matter how many words end up getting shown over its lifetime.
    const initialWords = getRandomWords(settings.startingWords, settings.difficulty, { enforceRatio: true, easyRatio: 0.6 });
    // Exactly one high-value "extreme" bonus word per round, on top of the
    // normal words above - regardless of the room's difficulty setting. It's
    // only ever drawn here (never by the mid-round refill in ensureWordSupply,
    // which draws exclusively from the easy/medium pool), so this is the one
    // and only place an extreme word can enter a round.
    const bonusWord = getExtremeBonusWord(rooms[roomCode]);
    if (bonusWord) initialWords.push(bonusWord);
    // observerWords accumulates every word shown this round (active, partial,
    // and done - words are only ever removed from `words`, never from this),
    // so it doubles as both the "shown this round" history and the live
    // opposing-team view - the single source of truth for round review too.
    rooms[roomCode].observerWords = [...initialWords];
    rooms[roomCode].words = initialWords;
    rooms[roomCode].remainingWords = [];
    rooms[roomCode].roundActive = true;
    rooms[roomCode].currentRound++;

        // Get the other team
        const otherTeam = team === 'red' ? 'blue' : 'red';
        
        // Handle word visibility for each player
        rooms[roomCode].players.forEach(player => {
            if (player.team === team) {
                // Current team's describer gets initial words
                if (player.id === teamDescriberId) {
                    console.log('Sending words to current describer:', player.name);
                    io.to(player.id).emit('describerWords', initialWords);
                } else {
                    // Current team's guessers get setAsGuesser
                    console.log('Setting as guesser:', player.name);
                    io.to(player.id).emit('setAsGuesser');
                }
            } else {
                // Other team sees words but can't guess — send as observerWords to avoid
                // triggering describer UI logic on the client (which cleared guesses)
                console.log('Sending observer words to other team player:', player.name);
                io.to(player.id).emit('observerWords', initialWords);
            }
        });

        // Also emit a room-level observerWordsRoom event so clients can update reliably
        try {
            io.to(roomCode).emit('observerWordsRoom', { team, words: rooms[roomCode].words });
        } catch (err) {
            console.error('Failed to emit observerWordsRoom:', err);
        }

        // Signal round start with duration from settings
        const roundDuration = settings.roundDuration;
        io.to(roomCode).emit('roundStarted', roundDuration);

        // Reset ready flags for next round
        rooms[roomCode].players.forEach(p => p.ready = false);

        // Setup progressive word reveal timer (the queue is topped up lazily
        // by pullWords/ensureWordSupply, so this never runs out of words to draw)
        {
            if (rooms[roomCode].wordTimer) clearInterval(rooms[roomCode].wordTimer);
            rooms[roomCode].wordTimer = setInterval(() => {
                const [newWord] = pullWords(rooms[roomCode], 1);
                if (rooms[roomCode].roundActive && newWord) {
                    addWordsToRoom(rooms[roomCode], [newWord]);

                    // Send new word to current describer and other team
                    const otherTeam = team === 'red' ? 'blue' : 'red';
                    
                    // Send word updates to players
                    rooms[roomCode].players.forEach(player => {
                        if (player.id === teamDescriberId) {
                            // Current team's describer gets just the new word
                            console.log('Sending new word to current describer:', player.name);
                            io.to(player.id).emit('newWord', newWord);
                        }
                        else if (player.team === otherTeam) {
                            // Other team players get the current in-play word list, same as the describer sees
                            console.log('Sending observer word list to other team player:', player.name);
                            io.to(player.id).emit('observerWords', rooms[roomCode].words);
                        }
                    });

                    // Also send a room-level update for observers
                    try {
                        io.to(roomCode).emit('observerWordsRoom', { team, words: rooms[roomCode].words });
                    } catch (err) {
                        console.error('Failed to emit observerWordsRoom (timer):', err);
                    }
                }
            }, settings.wordRevealInterval * 1000);
        }

        // Start the round timer and store end time
        rooms[roomCode].roundEndTime = Date.now() + (roundDuration * 1000);
        let timeLeft = roundDuration;
        const timer = setInterval(() => {
            timeLeft--;
            io.to(roomCode).emit('roundTimeUpdate', timeLeft);

            if (timeLeft <= 0) {
                clearInterval(timer);
                if (rooms[roomCode].wordTimer) {
                    clearInterval(rooms[roomCode].wordTimer);
                    rooms[roomCode].wordTimer = null;
                }
                // End the round
                    rooms[roomCode].roundActive = false;
                    // Enter review phase for the team that just played
                    rooms[roomCode].inReview = true;
                try {
                    io.to(roomCode).emit('roundEnded');
                    // Emit review payload for clients to display review UI.
                    // Each word carries its own status/points/guessedBy, so
                    // the client can render word state and a per-guesser
                    // points breakdown from one list.
                    io.to(roomCode).emit('roundReview', {
                        team,
                        roundNumber: rooms[roomCode].currentRound,
                        words: rooms[roomCode].observerWords || []
                    });

                    // Check if this was the last round
                    const totalRounds = (rooms[roomCode].settings.roundsPerTeam || 1) * 2;
                    if (rooms[roomCode].currentRound >= totalRounds) {
                        // Calculate final game results
                        const redTeam = rooms[roomCode].teams.red;
                        const blueTeam = rooms[roomCode].teams.blue;
                        const winner = redTeam.score > blueTeam.score ? 'red' :
                                   blueTeam.score > redTeam.score ? 'blue' : 'tie';

                        // Get player scores sorted by score (highest first)
                        const redPlayers = rooms[roomCode].players
                            .filter(p => p.team === 'red')
                            .sort((a, b) => b.score - a.score);
                        const bluePlayers = rooms[roomCode].players
                            .filter(p => p.team === 'blue')
                            .sort((a, b) => b.score - a.score);

                        // Emit game over with final scores
                        io.to(roomCode).emit('gameOver', {
                            winner,
                            redTeam: {
                                score: redTeam.score,
                                players: redPlayers
                            },
                            blueTeam: {
                                score: blueTeam.score,
                                players: bluePlayers
                            }
                        });
                    } else {
                        // Switch turn to the other team (now they can start the next round from review)
                        rooms[roomCode].currentTurn = team === 'red' ? 'blue' : 'red';

                        // Rotate describer for the team that will play next (advance by one each time the opponent finishes)
                        try {
                            const nextTeam = rooms[roomCode].currentTurn;
                            const teamPlayers = (rooms[roomCode].teams[nextTeam] && rooms[roomCode].teams[nextTeam].players) || [];
                            if (teamPlayers.length > 0) {
                                const currentDescriberId = rooms[roomCode].describers[nextTeam];
                                // find index of current describer in that team's players
                                let idx = teamPlayers.findIndex(p => p.id === currentDescriberId);
                                if (idx === -1) idx = -1; // start before first
                                const nextIdx = (idx + 1) % teamPlayers.length;
                                const newDescriber = teamPlayers[nextIdx];

                                // Clear any old describer for that team
                                if (rooms[roomCode].describers[nextTeam] && rooms[roomCode].describers[nextTeam] !== newDescriber.id) {
                                    const prev = rooms[roomCode].players.find(p => p.id === rooms[roomCode].describers[nextTeam]);
                                    if (prev) prev.role = 'guesser';
                                }

                                // Assign new describer
                                rooms[roomCode].describers[nextTeam] = newDescriber.id;

                                // Update roles within players list for that team
                                rooms[roomCode].players.forEach(p => {
                                    if (p.team === nextTeam) {
                                        p.role = (p.id === newDescriber.id) ? 'describer' : 'guesser';
                                        p.ready = false; // reset ready when roles change
                                    }
                                });
                            }
                        } catch (rotErr) {
                            console.error('Failed to rotate describer:', rotErr);
                        }
                    }
                } catch (err) {
                    console.error('Failed to emit roundReview:', err);
                }

                        // Reset ready flags for next round
                        rooms[roomCode].players.forEach(p => { p.ready = false; });

                            // Broadcast updated game state with new turn
                            io.to(roomCode).emit('updateGameState', buildGameState(rooms[roomCode]));
            }
        }, 1000);
    });

    socket.on('guess', (roomCode, guess) => {
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        if (player.role === 'describer') return; // describers can't guess

        const normalizedGuess = (typeof guess === 'string' ? guess : String(guess)).trim().toLowerCase();
        if (!normalizedGuess) return;

        console.log(`Guess "${normalizedGuess}" in room ${roomCode} from ${player.name}`);

        // A word already fully completed this round (still sitting in
        // observerWords with status 'done') just gets a quiet ack, no re-announce.
        const alreadyDone = room.observerWords.find(w => w.status === 'done' && w.word.toLowerCase() === normalizedGuess);
        if (alreadyDone) {
            socket.emit('alreadyGuessed', normalizedGuess);
            return;
        }

        // Live "X guessed Y" bubble for teammates watching.
        socket.to(roomCode).emit('announceGuess', normalizedGuess, { id: player.id, name: player.name });

        function awardPoints(amount) {
            player.score = (player.score || 0) + amount;
            const playerEntry = room.players.find(p => p.id === player.id);
            if (playerEntry) playerEntry.score = player.score;
            if (player.team && room.teams[player.team]) {
                room.teams[player.team].score += amount;
            }
        }

        function finishWord(wordObj) {
            wordObj.status = 'done';
            wordObj.points = wordObj.originalPoints;
            wordObj.guessedBy = player.name;
            const idx = room.words.indexOf(wordObj);
            if (idx !== -1) room.words.splice(idx, 1);
            // wordObj stays in room.observerWords (same reference, status now
            // 'done') - that's what round review and the opposing team's
            // progress view both read from, so no separate tracking needed here.

            // The team burned through every word currently in play - don't make
            // them wait out the rest of the normal reveal interval for the next
            // one. Drop in up to 5 more right away; the regular timer keeps
            // ticking on its own schedule alongside this.
            if (room.words.length === 0) {
                addWordsToRoom(room, pullWords(room, 5));
            }
        }

        function broadcastRoundState() {
            const currentDescriberId = room.describers[room.currentTurn];
            if (currentDescriberId) {
                io.to(currentDescriberId).emit('describerWords', room.words);
            }
            // Observers see the same live in-play list the describer does
            // (not the full round history) - a word disappears from their
            // view the moment it's actually finished, same as the describer's.
            io.to(roomCode).emit('observerWordsRoom', { team: room.currentTurn, words: room.words });
            io.to(roomCode).emit('updateGameState', buildGameState(room));
        }

        // 1) Exact text match against anything still in play (active or partial).
        const exactWord = room.words.find(w => w.word.toLowerCase() === normalizedGuess);
        if (exactWord) {
            if (exactWord.status === 'partial') {
                const remaining = exactWord.originalPoints - exactWord.partialPoints;
                finishWord(exactWord);
                awardPoints(remaining);
                io.to(roomCode).emit('correctGuess', {
                    word: exactWord.word,
                    isCompletingPartial: true,
                    points: remaining,
                    basePoints: exactWord.originalPoints,
                    partialPoints: exactWord.partialPoints,
                    // Only carried on a full completion, never on the partial-match
                    // guess below - that's what lets the client give a completed
                    // extreme word its own look without it bleeding into the
                    // "partial" styling of an in-progress fuzzy match.
                    difficulty: exactWord.difficulty
                }, player);
            } else {
                finishWord(exactWord);
                awardPoints(exactWord.originalPoints);
                io.to(roomCode).emit('correctGuess', {
                    word: exactWord.word,
                    points: exactWord.originalPoints,
                    difficulty: exactWord.difficulty
                }, player);
            }
            broadcastRoundState();
            return;
        }

        // 2) No exact match: try a fuzzy match against words that are still fully
        // 'active' (a word that already has partial credit can only be finished
        // by typing it exactly - see above - so it doesn't collect credit twice).
        // Skip if two candidates are equally close: an ambiguous match is worse
        // than no match at all.
        let best = null;
        let bestDistance = Infinity;
        let ambiguous = false;
        for (const w of room.words) {
            if (w.status !== 'active') continue;
            const maxDist = maxFuzzyDistance(w.word);
            if (maxDist === 0) continue; // word too short to allow any typo leniency
            const distance = getLevenshteinDistance(w.word.toLowerCase(), normalizedGuess);
            if (distance > maxDist) continue;
            if (distance < bestDistance) {
                best = w;
                bestDistance = distance;
                ambiguous = false;
            } else if (distance === bestDistance) {
                ambiguous = true;
            }
        }

        if (best && !ambiguous) {
            best.status = 'partial';
            best.partialPoints = Math.floor(best.originalPoints / 2);
            best.points = best.partialPoints;
            best.guessedBy = player.name;
            awardPoints(best.partialPoints);

            io.to(roomCode).emit('correctGuess', {
                word: normalizedGuess,
                isPartialMatch: true,
                points: best.partialPoints,
                basePoints: best.originalPoints
            }, player);
            broadcastRoundState();
            return;
        }

        io.to(roomCode).emit('wrongGuess', guess, player);
    });

    // Ready / not-ready handler for players
    socket.on('setReady', (roomCode, isReady) => {
        if (!rooms[roomCode]) return;
        const player = rooms[roomCode].players.find(p => p.id === socket.id);
        if (!player) return;
        player.ready = !!isReady;

        // Emit initial game state
        io.to(roomCode).emit('updateGameState', buildGameState(rooms[roomCode]));

        // For each team, check if team members (excluding that team's describer) are ready and notify that team's describer
        ['red','blue'].forEach(team => {
            const describerId = rooms[roomCode].describers[team];
            const teamPlayers = rooms[roomCode].players.filter(p => p.team === team && p.id !== describerId);
            const allTeamReady = teamPlayers.length === 0 ? true : teamPlayers.every(p => p.ready);
            if (describerId) {
                io.to(describerId).emit('teamReadyStatus', { team, allReady: allTeamReady });
            }
        });
    });

    // Silent spectator: joins the room's socket.io channel (so it gets every
    // broadcast a real player would - observerWordsRoom, roundReview,
    // updateGameState, guesses, timer ticks, gameOver) without ever being
    // added to rooms[roomCode].players, so nothing about a spectator is ever
    // visible to the actual players (no roster entry, no join notification).
    // Entirely separate code path from joinRoom - doesn't touch it.
    socket.on('spectateRoom', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) {
            socket.emit('spectateFailed', 'Room does not exist');
            return;
        }
        socket.join(roomCode);
        // New joiners only get broadcasts from this point forward, so send
        // a full snapshot of where things stand right now too - including a
        // computed time-remaining, since roundTimeUpdate ticks were already
        // missed if a round is already in progress.
        const timeLeft = room.roundActive && room.roundEndTime
            ? Math.max(0, Math.ceil((room.roundEndTime - Date.now()) / 1000))
            : null;
        socket.emit('spectateJoined', {
            roomCode,
            currentTurn: room.currentTurn,
            currentRound: room.currentRound,
            roundActive: !!room.roundActive,
            timeLeft,
            settings: room.settings,
            teams: {
                red: { score: room.teams.red.score },
                blue: { score: room.teams.blue.score }
            },
            words: room.words || [],
            players: room.players.map(p => ({ name: p.name, team: p.team, role: p.role, score: p.score }))
        });
    });

    socket.on('disconnect', () => {
        console.log('user disconnected:', socket.id);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const wasHost = room.hostId === socket.id;
            const player = room.players.find(p => p.id === socket.id);
            if (!player && !wasHost) continue;

            if (player) {
                // If they were describer, clear describer slot
                if (room.describers[player.team] === player.id) {
                    room.describers[player.team] = null;
                    // Tell room that describer left
                    io.to(roomCode).emit('describerLeft', { team: player.team });
                }

                // Remove from team players list and players array
                room.teams[player.team].players = room.teams[player.team].players.filter(p => p.id !== player.id);
                room.players = room.players.filter(p => p.id !== player.id);
            }

            // If the room's creator disconnected, hand the host role to
            // whoever's left rather than leaving it stuck on a socket id
            // that can never reconnect (a refresh gets a brand-new socket
            // id, so the original host has no way to reclaim it either).
            if (wasHost) {
                room.hostId = room.players.length > 0 ? room.players[0].id : null;
            }

            // Emit updated lists
            io.to(roomCode).emit('playerList', room.players);
            io.to(roomCode).emit('updateGameState', buildGameState(room));
        }
    });
});



server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
