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
// Serve static files from the 'public' directory
app.use(express.static('public'));

let rooms = {};

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

// Pull up to `count` words off the room's reveal queue.
function pullWords(room, count) {
    if (!room.remainingWords || room.remainingWords.length === 0) return [];
    return room.remainingWords.splice(0, count);
}

// Add already-pulled words into the room's live word state (no emits - callers
// decide what to broadcast and when).
function addWordsToRoom(room, words) {
    for (const w of words) {
        room.words.push(w);
        room.observerWords.push(w);
        if (!room.shownWords) room.shownWords = [];
        room.shownWords.push(w);
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
            currentTurn: 'red',
            teams: {
                red: { players: [], score: 0 },
                blue: { players: [], score: 0 }
            },
            roundActive: false,
            inReview: false,
            // Per-round tracking
            shownWords: [],
            guessedWords: [],
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
            // Disallow describers from changing role or switching teams while their team is currently playing
            const playingTeam = rooms[roomCode].currentTurn;
            if (rooms[roomCode].roundActive && existingPlayer.role === 'describer' && existingPlayer.team === playingTeam && (existingPlayer.team !== team || existingPlayer.role !== role)) {
                console.log(`Blocked describer switch attempt mid-round (playing team): ${existingPlayer.name} (${socket.id}) tried to change to ${team}/${role}`);
                socket.emit('error', 'Describers on the playing team cannot change role or switch teams while a round is active');
                return;
            }

            // If player previously switched mid-round, prevent switching back until round end
            if (rooms[roomCode].roundActive && existingPlayer.switchedFrom && team === existingPlayer.switchedFrom) {
                console.log(`Blocked switch-back mid-round: ${existingPlayer.name} (${socket.id}) attempted to switch back to ${team}`);
                socket.emit('error', 'You cannot switch back to your previous team until the round ends');
                return;
            }
            // If nothing changed, just return current state
            if (existingPlayer.team === team && existingPlayer.role === role && existingPlayer.name === name) {
                // re-emit state so client stays in sync
                io.to(roomCode).emit('updateGameState', {
                    describers: {...rooms[roomCode].describers},
                    currentTurn: rooms[roomCode].currentTurn,
                    currentRound: rooms[roomCode].currentRound,
                    roundActive: !!rooms[roomCode].roundActive,
                    settings: rooms[roomCode].settings,
                    players: rooms[roomCode].players.map(p => ({...p})),
                    teams: {
                        red: { score: rooms[roomCode].teams.red.score },
                        blue: { score: rooms[roomCode].teams.blue.score }
                    }
                });
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
                // If this change happens during an active round and the player was a guesser, mark that they switched
                // If they switched away from the playing team during an active round, record switchedFrom so they can't switch back
                if (rooms[roomCode].roundActive && existingPlayer.role !== 'describer' && existingPlayer.team === playingTeam) {
                    existingPlayer.switchedFrom = existingPlayer.team;
                    console.log(`Player ${existingPlayer.name} (${existingPlayer.id}) switched teams mid-round from ${existingPlayer.switchedFrom} -> ${team}`);
                }
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
            io.to(roomCode).emit('updateGameState', {
                describers: {...rooms[roomCode].describers},
                currentTurn: rooms[roomCode].currentTurn,
                currentRound: rooms[roomCode].currentRound,
                roundActive: !!rooms[roomCode].roundActive,
                settings: rooms[roomCode].settings,
                players: rooms[roomCode].players.map(p => ({...p})),
                teams: {
                    red: { score: rooms[roomCode].teams.red.score },
                    blue: { score: rooms[roomCode].teams.blue.score }
                }
            });
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
        const gameState = {
            describers: {...rooms[roomCode].describers},
            currentTurn: rooms[roomCode].currentTurn,
            currentRound: rooms[roomCode].currentRound,
            roundActive: !!rooms[roomCode].roundActive,
            settings: rooms[roomCode].settings,
            players: rooms[roomCode].players.map(p => ({...p})),
            teams: {
                red: { score: rooms[roomCode].teams.red.score },
                blue: { score: rooms[roomCode].teams.blue.score }
            }
        };
        io.to(roomCode).emit('updateGameState', gameState);
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
        if (!rooms[roomCode]) return;
        
        // Validate and update settings
        const newSettings = {
            roundDuration: Math.min(Math.max(settings.roundDuration, 30), 300),
            // roundsPerTeam: each team gets this many rounds
            roundsPerTeam: Math.min(Math.max(settings.roundsPerTeam, 1), 10),
            startingWords: Math.min(Math.max(settings.startingWords, 1), 10),
            wordRevealInterval: Math.min(Math.max(settings.wordRevealInterval, 5), 60)
        };
        
        rooms[roomCode].settings = newSettings;
        
        // First emit the settings update
        io.to(roomCode).emit('gameSettings', newSettings);
        
        // Then emit a full game state update to refresh the round display
    io.to(roomCode).emit('updateGameState', {
        describers: {...rooms[roomCode].describers},
        currentTurn: rooms[roomCode].currentTurn,
        currentRound: rooms[roomCode].currentRound,
        roundActive: !!rooms[roomCode].roundActive,
        settings: newSettings,
        players: rooms[roomCode].players.map(p => ({...p})),
        teams: {
            red: { score: rooms[roomCode].teams.red.score },
            blue: { score: rooms[roomCode].teams.blue.score }
        }
    });
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

    // Start the round with initial words
    const allWords = getRandomWords(settings.startingWords + 5, settings.difficulty, { enforceRatio: true, easyRatio: 0.6 }); // Get more words than we initially show with 60/40 easy/medium for starting pool
    const initialWords = allWords.slice(0, settings.startingWords);
    // Track words that have actually been shown to the describer (for review)
    rooms[roomCode].shownWords = [...initialWords];
    rooms[roomCode].guessedWords = [];
    // Create a dedicated observer words list that preserves visibility state
    rooms[roomCode].observerWords = [...initialWords];
    rooms[roomCode].words = initialWords;
    rooms[roomCode].remainingWords = allWords.slice(settings.startingWords);
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
            io.to(roomCode).emit('observerWordsRoom', { team, words: rooms[roomCode].observerWords });
        } catch (err) {
            console.error('Failed to emit observerWordsRoom:', err);
        }

        // Signal round start with duration from settings
        const roundDuration = settings.roundDuration;
        io.to(roomCode).emit('roundStarted', roundDuration);

        // Reset ready flags for next round
        rooms[roomCode].players.forEach(p => p.ready = false);

        // Setup progressive word reveal timer
        if (rooms[roomCode].remainingWords.length > 0) {
            if (rooms[roomCode].wordTimer) clearInterval(rooms[roomCode].wordTimer);
            rooms[roomCode].wordTimer = setInterval(() => {
                if (rooms[roomCode].remainingWords.length > 0 && rooms[roomCode].roundActive) {
                    const [newWord] = pullWords(rooms[roomCode], 1);
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
                            // Other team players get the updated list of all words as observerWords
                            console.log('Sending observer word list to other team player:', player.name);
                            io.to(player.id).emit('observerWords', rooms[roomCode].observerWords);
                        }
                    });

                    // Also send a room-level update for observers
                    try {
                        io.to(roomCode).emit('observerWordsRoom', { team, words: rooms[roomCode].observerWords });
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
                    // Emit review payload for clients to display review UI
                    io.to(roomCode).emit('roundReview', {
                        team,
                        roundNumber: rooms[roomCode].currentRound,
                        shownWords: rooms[roomCode].shownWords || [],
                        guessedWords: rooms[roomCode].guessedWords || []
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

                        // Reset ready flags and clear mid-round switch locks for next round
                        rooms[roomCode].players.forEach(p => { p.ready = false; p.switchedFrom = null; });

                            // Broadcast updated game state with new turn
                            io.to(roomCode).emit('updateGameState', {
                                describers: {...rooms[roomCode].describers},
                                currentTurn: rooms[roomCode].currentTurn,
                                currentRound: rooms[roomCode].currentRound,
                                roundActive: !!rooms[roomCode].roundActive,
                                settings: rooms[roomCode].settings,
                                players: rooms[roomCode].players.map(p => ({...p})),
                                teams: {
                                    red: { score: rooms[roomCode].teams.red.score },
                                    blue: { score: rooms[roomCode].teams.blue.score }
                                }
                            });
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
            if (!room.guessedWords) room.guessedWords = [];
            room.guessedWords.push(wordObj);

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
            io.to(roomCode).emit('observerWordsRoom', { team: room.currentTurn, words: room.observerWords });
            io.to(roomCode).emit('updateGameState', {
                describers: { ...room.describers },
                currentTurn: room.currentTurn,
                currentRound: room.currentRound,
                roundActive: !!room.roundActive,
                settings: room.settings,
                players: room.players.map(p => ({ ...p })),
                teams: {
                    red: { score: room.teams.red.score },
                    blue: { score: room.teams.blue.score }
                }
            });
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
                    partialPoints: exactWord.partialPoints
                }, player);
            } else {
                finishWord(exactWord);
                awardPoints(exactWord.originalPoints);
                io.to(roomCode).emit('correctGuess', {
                    word: exactWord.word,
                    points: exactWord.originalPoints
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
        const gameState = {
            describers: {...rooms[roomCode].describers},
            currentTurn: rooms[roomCode].currentTurn,
            currentRound: rooms[roomCode].currentRound,
            roundActive: !!rooms[roomCode].roundActive,
            settings: rooms[roomCode].settings,
            players: rooms[roomCode].players.map(p => ({...p})),
            teams: {
                red: { score: rooms[roomCode].teams.red.score },
                blue: { score: rooms[roomCode].teams.blue.score }
            }
        };
        io.to(roomCode).emit('updateGameState', gameState);

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

    socket.on('disconnect', () => {
        console.log('user disconnected:', socket.id);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const player = room.players.find(p => p.id === socket.id);
            if (!player) continue;

            // If they were describer, clear describer slot
            if (room.describers[player.team] === player.id) {
                room.describers[player.team] = null;
                // Tell room that describer left
                io.to(roomCode).emit('describerLeft', { team: player.team });
            }

            // Remove from team players list and players array
            room.teams[player.team].players = room.teams[player.team].players.filter(p => p.id !== player.id);
            room.players = room.players.filter(p => p.id !== player.id);

            // Emit updated lists
            io.to(roomCode).emit('playerList', room.players);
            io.to(roomCode).emit('updateGameState', {
                describers: {...room.describers},
                currentTurn: room.currentTurn,
                currentRound: room.currentRound,
                roundActive: !!room.roundActive,
                settings: room.settings,
                players: room.players.map(p => ({...p})),
                teams: {
                    red: { score: room.teams.red.score },
                    blue: { score: room.teams.blue.score }
                }
            });
        }
    });
});



server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
