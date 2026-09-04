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

function getRandomWords(n, difficulty = 'mixed', options = {}) {
    // options: { enforceRatio: bool, easyRatio: 0..1 }
    const easy = wordPacks.easy || [];
    const medium = wordPacks.medium || [];

    if (difficulty === 'easy') {
        const shuffled = [...easy].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, n);
    }
    if (difficulty === 'medium') {
        const shuffled = [...medium].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, n);
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
        return combined.slice(0, n);
    }

    // Default: pool all words and randomize
    const pool = [...easy, ...medium];
    if (pool.length === 0) {
        console.error('No words available for mixed difficulty');
        return [];
    }
    const shuffled = pool.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, n);
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
        // === MANDATORY FIX 4: Initialize completion tracking ===
        rooms[roomCode].completedWords = []; // Reset for new round
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
                    const newWord = rooms[roomCode].remainingWords.shift();
                    // Add word to room's word list only once
                    rooms[roomCode].words.push(newWord);
                    // Track that this word was shown to the describer
                    if (!rooms[roomCode].shownWords) rooms[roomCode].shownWords = [];
                    rooms[roomCode].shownWords.push(newWord);
                    
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
                        // Add new word to observer list and emit
                        rooms[roomCode].observerWords.push(newWord);
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
        console.log(`Received guess "${guess}" in room ${roomCode} from socket ${socket.id}`);
        
        if (!rooms[roomCode]) {
            console.log('Room not found:', roomCode);
            return;
        }

        // === MANDATORY FIX 1: Early completion check ===
        const normalizedGuess = (typeof guess === 'string' ? guess : String(guess)).trim().toLowerCase();
        
        // Initialize completedWords if it doesn't exist
        if (!rooms[roomCode].completedWords) rooms[roomCode].completedWords = [];
        
        // Check if word was already completed (BEFORE any processing)
        if (rooms[roomCode].completedWords.includes(normalizedGuess)) {
            console.log('Word already completed (early check):', normalizedGuess);
            socket.emit('alreadyGuessed', normalizedGuess);
            return;
        }
        // === END MANDATORY FIX 1 ===

        const player = rooms[roomCode].players.find(p => p.id === socket.id);
        if (!player) {
            console.log('Player not found for socket:', socket.id);
            return;
        }

        console.log('Current room state:', {
            roomCode,
            players: rooms[roomCode].players,
            words: rooms[roomCode].words,
            describers: rooms[roomCode].describers,
            currentTurn: rooms[roomCode].currentTurn
        });

        // Don't allow someone with the describer role to guess
        if (player.role === 'describer') {
            console.log('Player with describer role tried to guess, ignoring');
            return;
        }

        // Make guess lowercase and trim spaces (already normalized earlier for the early completion check)
        console.log('Normalized guess:', normalizedGuess);

        // Ensure room has a completedWords tracker (fast checks to prevent re-scoring)
        if (!rooms[roomCode].completedWords) rooms[roomCode].completedWords = [];

        // Initialize tracking arrays if they don't exist
        if (!rooms[roomCode].guessedWords) rooms[roomCode].guessedWords = [];
        
        // Announce the guess to all players in the room so both teams can see it live
        try {
            // Only announce if this exact word hasn't been guessed before
            const isNewGuess = !rooms[roomCode].guessedWords.some(w => 
                w && w.word && w.word.toLowerCase() === normalizedGuess
            );
            if (isNewGuess) {
                socket.to(roomCode).emit('announceGuess', normalizedGuess, { id: player.id, name: player.name });
            }
        } catch (err) {
            console.error('Failed to announce guess:', err);
        }

        // Check if word was already completed (after announcing, before scoring)
        const alreadyCompleted = rooms[roomCode].completedWords.includes(normalizedGuess) ||
            rooms[roomCode].guessedWords.some(w => {
                if (!w) return false;
                const wordText = (typeof w === 'string') ? w : (w.word || '');
                // Word is considered completed if it's either a full guess or was a partial match that was completed
                const isCompleted = !w.isPartialMatch || w.wasCompleted || w.completed;
                return isCompleted && wordText.toLowerCase() === normalizedGuess;
            });
            
        if (alreadyCompleted) {
            // Make sure we persist this into completedWords for future quick checks
            if (!rooms[roomCode].completedWords.includes(normalizedGuess)) {
                rooms[roomCode].completedWords.push(normalizedGuess);
            }
            console.log('Word was already completed:', normalizedGuess);
            socket.emit('alreadyGuessed', normalizedGuess);
            return;
        }
        
        console.log('Available words:', rooms[roomCode].words);

        // First check for exact matches, then check for close matches
        let wordIndex = -1;
        let isPartialMatch = false;
        let closestWord = null;
        let isCompletingPartialMatch = false;

        // First check if this completes any previously guessed partial word
        const partialMatch = rooms[roomCode].guessedWords ? rooms[roomCode].guessedWords.find(w => {
            if (!w || !w.isPartialMatch) return false;
            return w.word.toLowerCase() === normalizedGuess;
        }) : null;

        if (partialMatch) {
            console.log('Found completion for previously guessed partial:', partialMatch);
            isCompletingPartialMatch = true;
            closestWord = {...partialMatch}; // Copy to preserve original state
            // Calculate remaining points (full - partial)
            const basePoints = partialMatch.originalPoints || 
                (partialMatch.difficulty === 'medium' ? 15 : 6);
            const remaining = basePoints - (partialMatch.partialPoints || 0);
            
            // Update player score
            player.score = (player.score || 0) + remaining;
            if (player.team && rooms[roomCode].teams[player.team]) {
                rooms[roomCode].teams[player.team].score += remaining;
            }
            
            // Emit completion silently (don't announce the guess)
            io.to(roomCode).emit('correctGuess', {
                word: partialMatch.word,
                points: remaining,
                basePoints: basePoints,
                partialPoints: partialMatch.partialPoints,
                isCompletingPartial: true
            }, player);
            
            // === CRITICAL FIX: Update observer words for this completion ===
            const wordText = partialMatch.word;
            if (wordText) {
                const obsIdx = rooms[roomCode].observerWords.findIndex(w => {
                    const wText = typeof w === 'string' ? w : (w && w.word);
                    return wText === wordText;
                });
                if (obsIdx !== -1) {
                    const wordObj = typeof rooms[roomCode].observerWords[obsIdx] === 'string' 
                        ? { word: rooms[roomCode].observerWords[obsIdx] }
                        : { ...rooms[roomCode].observerWords[obsIdx] };
                    
                    // Clear partial flags and set completion flags (GREEN state)
                    wordObj.completed = true;
                    wordObj.isCorrect = true;
                    wordObj.isPartialMatch = false;
                    wordObj.wasCompleted = true;
                    wordObj.points = basePoints; // Full points
                    wordObj.guessedBy = player.name;
                    
                    rooms[roomCode].observerWords[obsIdx] = wordObj;
                }
            }
            // === END CRITICAL FIX ===
            
            // Update game state with full context
            const gameState = {
                players: rooms[roomCode].players.map(p => ({...p})),
                teams: {
                    red: { score: rooms[roomCode].teams.red.score },
                    blue: { score: rooms[roomCode].teams.blue.score }
                },
                currentTurn: rooms[roomCode].currentTurn,
                roundActive: rooms[roomCode].roundActive,
                describers: rooms[roomCode].describers
            };
            // Record completed word to prevent re-scoring
            try {
                // Atomic update of completion tracking
                const canon = (partialMatch.word || '').toString().toLowerCase();
                if (canon) {
                    rooms[roomCode].completedWords = rooms[roomCode].completedWords || [];
                    if (!rooms[roomCode].completedWords.includes(canon)) {
                        rooms[roomCode].completedWords.push(canon);
                    }
                    // Also mark the word as completed in guessedWords
                    const guessedWord = rooms[roomCode].guessedWords.find(w => 
                        w && w.word && w.word.toLowerCase() === canon
                    );
                    if (guessedWord) {
                        guessedWord.completed = true;
                        guessedWord.wasCompleted = true;
                        guessedWord.isPartialMatch = false; // Clear partial flag
                    }
                }
            } catch (e) { console.error('Failed to record completed partial match', e); }

            // === NEW FIX: Update describer view ===
            const currentTeam = rooms[roomCode].currentTurn;
            const currentDescriberId = rooms[roomCode].describers[currentTeam];
            if (currentDescriberId) {
                io.to(currentDescriberId).emit('describerWords', rooms[roomCode].words);
            }

            // Notify ALL clients of observer words update
            io.to(roomCode).emit('observerWordsRoom', { 
                team: rooms[roomCode].currentTurn,
                words: rooms[roomCode].observerWords 
            });

            io.to(roomCode).emit('updateGameState', gameState);
            return;
        }

        // Atomically check and find the word to prevent race conditions
        let targetWord = null;
        let exactMatch = false;
        
        // First pass: look for exact matches (including partially matched words)
        for (let i = 0; i < rooms[roomCode].words.length; i++) {
            const w = rooms[roomCode].words[i];
            if (!w) continue;
            
            const wordText = typeof w === 'string' ? w : (w.word || '');
            if (wordText.toLowerCase() === normalizedGuess) {
                targetWord = w;
                wordIndex = i;
                exactMatch = true;
                // If this was a partial match, mark it
                if (w.isPartialMatch) {
                    isCompletingPartialMatch = true;
                    closestWord = {...w};
                }
                break;
            }
        }

        // If no exact match, check for close matches (within 3 character edits)
        if (!exactMatch) {
            const MAX_DISTANCE = 3;
            let minDistance = MAX_DISTANCE + 1;
            
            rooms[roomCode].words.forEach((w, idx) => {
                if (!w) return;
                // Don't skip partial matches - we want to allow completion
                const wordText = (typeof w === 'string' ? w : w.word || '').toLowerCase();
                const distance = getLevenshteinDistance(wordText, normalizedGuess);
                
                // If this is an exact match with a partial word, prioritize that
                if (distance === 0 && w.isPartialMatch) {
                    console.log('Found exact match for partial word in distance check:', w);
                    minDistance = 0;
                    wordIndex = idx;
                    isCompletingPartialMatch = true;
                    closestWord = w;
                    return;
                }
                
                // Otherwise track the closest match that isn't already partial
                if (distance <= MAX_DISTANCE && distance < minDistance && !w.isPartialMatch) {
                    minDistance = distance;
                    wordIndex = idx;
                    isPartialMatch = true;
                    closestWord = w;
                }
            });
        }

        if (wordIndex === -1) {
            // No match found at all
            io.to(roomCode).emit('wrongGuess', guess, player);
            return;
        }

        // Found a match - get word and handle points
        const matchedWord = rooms[roomCode].words[wordIndex];
        console.log('Matched word:', matchedWord);

        // Defensive guards to prevent double-scoring / spam exploits
        try {
            // canonical text for matching
            const canonicalText = (typeof matchedWord === 'string') ? matchedWord.toLowerCase() : ((matchedWord && (matchedWord.word || ''))).toLowerCase();

            // ensure completedWords exists
            if (!rooms[roomCode].completedWords) rooms[roomCode].completedWords = [];

            // If this word is already recorded as completed, reject immediately
            if (canonicalText && rooms[roomCode].completedWords.includes(canonicalText)) {
                console.log('Attempt to score already-completed word (completedWords):', canonicalText);
                socket.emit('alreadyGuessed', canonicalText);
                return;
            }

            // If matchedWord object itself indicates completion, reject
            if (matchedWord && matchedWord.completed) {
                const txt = canonicalText || normalizedGuess;
                console.log('Attempt to score already-completed word (matchedWord.completed):', txt);
                // ensure it's recorded in completedWords for future checks
                if (txt && !rooms[roomCode].completedWords.includes(txt)) rooms[roomCode].completedWords.push(txt);
                socket.emit('alreadyGuessed', txt);
                return;
            }

            // Prevent duplicate partial awards
            if (isPartialMatch && matchedWord && matchedWord.partialAwarded) {
                const txt = (typeof matchedWord === 'string') ? matchedWord.toLowerCase() : ((matchedWord && (matchedWord.word || ''))).toLowerCase();
                console.log('Partial points already awarded for this word, ignoring repeated partial guess:', txt);
                socket.emit('alreadyGuessed', txt || normalizedGuess);
                return;
            }

            // For completing a partial match, ensure it's not already completed
            if (isCompletingPartialMatch && matchedWord && (matchedWord.completed || matchedWord.isCompletingPartial || matchedWord.wasCompleted)) {
                const txt = (typeof matchedWord === 'string') ? matchedWord.toLowerCase() : ((matchedWord && (matchedWord.word || ''))).toLowerCase();
                console.log('Completing partial but word is already marked completed, ignoring:', txt);
                if (txt && !rooms[roomCode].completedWords.includes(txt)) rooms[roomCode].completedWords.push(txt);
                socket.emit('alreadyGuessed', txt || normalizedGuess);
                return;
            }
        } catch (guardErr) {
            console.error('Error in score-guard checks:', guardErr);
        }

        try {
            
            // Calculate points based on match type
            const oldScore = player.score || 0;
            let basePoints = (typeof matchedWord === 'object' && matchedWord.points) 
                ? matchedWord.points 
                : (typeof matchedWord === 'object' && matchedWord.difficulty === 'medium' ? 15 : 6);
            
            let points;
            if (isCompletingPartialMatch && matchedWord.isPartialMatch) {
                // They got it exactly right after a partial match - award only remaining points
                const partialPoints = matchedWord.partialPoints || Math.floor(basePoints / 2);
                const remainingPoints = basePoints - partialPoints;
                points = remainingPoints;
                console.log('COMPLETING PARTIAL MATCH:', {
                    word: matchedWord,
                    basePoints,
                    partialPoints,
                    remainingPoints,
                    isCompletingPartialMatch
                });
                // Atomically mark completed to avoid race awarding
                try {
                    matchedWord.isPartialMatch = false; // Clear the partial match flag
                    matchedWord.completedPartial = true; // Mark as completed
                    matchedWord.isCompletingPartial = true; // Mark as completing partial
                    matchedWord.completed = true; // Canonical completed flag
                    matchedWord.points = points; // Update points for this completion
                    // Ensure canonical recorded
                    const txt = (typeof matchedWord === 'string') ? matchedWord.toLowerCase() : ((matchedWord && (matchedWord.word || '')).toLowerCase());
                    if (txt && !rooms[roomCode].completedWords.includes(txt)) rooms[roomCode].completedWords.push(txt);
                } catch (e) { console.error('Failed to mark matchedWord as completed atomically', e); }
                
                // === CRITICAL FIX: Update observer words for completed partial match ===
                const wordText = typeof matchedWord === 'string' ? matchedWord : (matchedWord && matchedWord.word);
                if (wordText) {
                    // Find and update in observer list
                    const obsIdx = rooms[roomCode].observerWords.findIndex(w => {
                        const wText = typeof w === 'string' ? w : (w && w.word);
                        return wText === wordText;
                    });
                    if (obsIdx !== -1) {
                        const wordObj = typeof rooms[roomCode].observerWords[obsIdx] === 'string' 
                            ? { word: rooms[roomCode].observerWords[obsIdx] }
                            : { ...rooms[roomCode].observerWords[obsIdx] };
                        
                        // Clear partial flags and set completion flags
                        wordObj.completed = true;
                        wordObj.isCorrect = true;
                        wordObj.isPartialMatch = false;
                        wordObj.wasCompleted = true;
                        wordObj.points = basePoints; // Full points now
                        wordObj.guessedBy = player.name;
                        
                        rooms[roomCode].observerWords[obsIdx] = wordObj;
                    }
                }
                // === END CRITICAL FIX ===
                
                // Persist modifications back into the room's word list in case matchedWord was a reference copy
                try {
                    rooms[roomCode].words[wordIndex] = matchedWord;
                    console.log('Persisted matchedWord after completion at index', wordIndex, matchedWord);
                } catch (e) { console.error('Failed to persist matchedWord after completion', e); }
            } else if (isPartialMatch) {
                // New partial match - award half points
                points = Math.floor(basePoints / 2);
                console.log(`New partial match: base=${basePoints}, awarding=${points}`);
                matchedWord.isPartialMatch = true;
                matchedWord.originalPoints = basePoints;
                matchedWord.partialPoints = points;
                matchedWord.points = points; // Store current points
                // Mark that we've awarded the partial points so future repeated partials won't award again
                matchedWord.partialAwarded = true;
                
                // Update observer words list for partial match
                const wordText = typeof matchedWord === 'string' ? matchedWord : (matchedWord && matchedWord.word);
                if (wordText) {
                    const obsIdx = rooms[roomCode].observerWords.findIndex(w => {
                        const wText = typeof w === 'string' ? w : (w && w.word);
                        return wText === wordText;
                    });
                    if (obsIdx !== -1) {
                        const wordObj = typeof rooms[roomCode].observerWords[obsIdx] === 'string' 
                            ? { word: rooms[roomCode].observerWords[obsIdx] }
                            : { ...rooms[roomCode].observerWords[obsIdx] };
                        
                        // Set partial match flags (ORANGE state)
                        wordObj.isPartialMatch = true;
                        wordObj.partialPoints = points;
                        wordObj.basePoints = basePoints;
                        wordObj.originalPoints = basePoints;
                        wordObj.guessedBy = player.name;
                        wordObj.completed = false; // Ensure not marked as completed
                        
                        rooms[roomCode].observerWords[obsIdx] = wordObj;
                    }
                }
                
                // Persist modifications back into the room's word list
                try {
                    rooms[roomCode].words[wordIndex] = matchedWord;
                    console.log('Persisted matchedWord for partial match at index', wordIndex, matchedWord);
                } catch (e) { console.error('Failed to persist matchedWord for partial match', e); }
            } else {
                // Normal exact match - full points
                points = basePoints;
                console.log(`Full match: awarding=${points}`);
                // Mark completed immediately and record canonical word text to block duplicate scoring
                try {
                    matchedWord.completed = true;
                    const txt = (typeof matchedWord === 'string') ? matchedWord : (matchedWord && (matchedWord.word || ''));
                    const lower = txt ? String(txt).toLowerCase() : normalizedGuess;
                    if (!rooms[roomCode].completedWords) rooms[roomCode].completedWords = [];
                    if (lower && !rooms[roomCode].completedWords.includes(lower)) rooms[roomCode].completedWords.push(lower);
                } catch (e) { console.error('Failed to mark full match as completed early', e); }
                matchedWord.points = points;

                // === ADD THIS: Update observer words for normal exact match ===
                const wordText = typeof matchedWord === 'string' ? matchedWord : (matchedWord && matchedWord.word);
                if (wordText) {
                    const obsIdx = rooms[roomCode].observerWords.findIndex(w => {
                        const wText = typeof w === 'string' ? w : (w && w.word);
                        return wText === wordText;
                    });
                    if (obsIdx !== -1) {
                        const wordObj = typeof rooms[roomCode].observerWords[obsIdx] === 'string' 
                            ? { word: rooms[roomCode].observerWords[obsIdx] }
                            : { ...rooms[roomCode].observerWords[obsIdx] };
                        
                        // Set completion flags (GREEN state)
                        wordObj.completed = true;
                        wordObj.isCorrect = true;
                        wordObj.isPartialMatch = false;
                        wordObj.wasCompleted = true;
                        wordObj.points = points;
                        wordObj.guessedBy = player.name;
                        
                        rooms[roomCode].observerWords[obsIdx] = wordObj;
                    }
                }
                // === END ADD ===
            }

            // Update player score
            player.score = oldScore + points;
            console.log(`Player ${player.name} score updated: ${oldScore} -> ${player.score} (+${points}${isPartialMatch ? ' (partial match)' : ''})`);
                    

            // Only remove the word if it's a full match or completing a partial match
            if (!isPartialMatch) {
                // Remove from active words list
                rooms[roomCode].words.splice(wordIndex, 1);
            }
            // Update player's score in both the players array and their team
            const playerIndex = rooms[roomCode].players.findIndex(p => p.id === player.id);
            if (playerIndex !== -1) {
                rooms[roomCode].players[playerIndex].score = player.score;
            }

            // Update team score
            if (player.team && rooms[roomCode].teams[player.team]) {
                rooms[roomCode].teams[player.team].score += points;
                console.log(`Team ${player.team} score updated: +${points}`);
                const wordText = typeof matchedWord === 'string' ? matchedWord : matchedWord.word;
                console.log(`Team ${player.team} scored ${points} points for word "${wordText}", total: ${rooms[roomCode].teams[player.team].score}`);
            }

            // === NEW FIX: Update describer view for all guess types ===
            const currentTeam = rooms[roomCode].currentTurn;
            const currentDescriberId = rooms[roomCode].describers[currentTeam];
            if (currentDescriberId) {
                io.to(currentDescriberId).emit('describerWords', rooms[roomCode].words);
            }

            // For partial matches, we want to send the actual guess text along with the match info
            if (isPartialMatch) {
                console.log('Emitting partial match:', { guess: normalizedGuess, points, basePoints });
                io.to(roomCode).emit('correctGuess', {
                    word: normalizedGuess,
                    isPartialMatch: true,
                    points: points,
                    basePoints: basePoints  // Add this
                }, player);
            } else if (isCompletingPartialMatch) {
                console.log('Emitting completing partial match:', { 
                    word: matchedWord.word, 
                    points,
                    basePoints: basePoints,
                    partialPoints: matchedWord.partialPoints,
                    remainingPoints: points
                });
                io.to(roomCode).emit('correctGuess', {
                    ...matchedWord,
                    isCompletingPartial: true,
                    points: points,
                    partialPoints: matchedWord.partialPoints,
                    basePoints: basePoints
                }, player);
            } else {
                console.log('Emitting normal correct guess:', { word: matchedWord.word, points });
                io.to(roomCode).emit('correctGuess', {
                    word: matchedWord.word,
                    points: points
                }, player);
            }

            // Track guessed word for review
            try {
                if (!rooms[roomCode].guessedWords) rooms[roomCode].guessedWords = [];
                
                // Update or store the word
                let wordToStore;
                if (isCompletingPartialMatch) {
                    // Find and update the existing partial match
                    const partialIndex = rooms[roomCode].guessedWords.findIndex(w => 
                        w.word.toLowerCase() === normalizedGuess && w.isPartialMatch
                    );
                    if (partialIndex !== -1) {
                        wordToStore = {...rooms[roomCode].guessedWords[partialIndex]};
                        wordToStore.isPartialMatch = false; // No longer partial
                        wordToStore.wasCompleted = true;    // Mark as completed
                        wordToStore.completedPoints = points;
                        rooms[roomCode].guessedWords[partialIndex] = wordToStore;
                    }
                } else {
                    // Store new word
                    wordToStore = {...matchedWord};
                    if (isPartialMatch) {
                        wordToStore.isPartialMatch = true;
                        wordToStore.originalPoints = basePoints;
                        wordToStore.partialPoints = points;
                    }
                    // Only add if not already in list
                        if (!rooms[roomCode].guessedWords.some(w => {
                            const wText = (typeof w === 'string') ? w : (w && w.word) || '';
                            return wText && (wText === ((typeof wordToStore === 'string') ? wordToStore : wordToStore.word));
                        })) {
                            rooms[roomCode].guessedWords.push(wordToStore);
                        }
                }
            } catch (err) {
                console.error('Failed to track guessed word:', err);
            }
                // Ensure we record completed words in the dedicated list so future guesses can't award points
                try {
                    // Determine canonical word text to record
                    let completedText = null;
                    if (isCompletingPartialMatch) {
                        completedText = (closestWord && (closestWord.word || String(closestWord))) || normalizedGuess;
                    } else if (!isPartialMatch) {
                        // For full matches, matchedWord may be an object or string
                        completedText = (typeof matchedWord === 'string') ? matchedWord : (matchedWord && (matchedWord.word || normalizedGuess));
                    }
                    if (completedText) {
                        const lower = completedText.toLowerCase();
                        if (!rooms[roomCode].completedWords.includes(lower)) rooms[roomCode].completedWords.push(lower);
                    }
                } catch (e) {
                    console.error('Failed to update completedWords list', e);
                }
            
            // Notify ALL clients of observer words update
            io.to(roomCode).emit('observerWordsRoom', { 
                team: rooms[roomCode].currentTurn,
                words: rooms[roomCode].observerWords 
            });

            // Then emit both players and team scores
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
            
            // Log the final state
            console.log('Updated room state:', {
                roomCode,
                players: rooms[roomCode].players,
                words: rooms[roomCode].words
            });
        } catch (err) {
            console.error('Failed to handle correct guess:', err);
        }
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
