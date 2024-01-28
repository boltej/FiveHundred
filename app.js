const express = require('express');
//const { emit } = require('process');
const { DefaultSerializer } = require('v8');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
    //upgradeTimeout: 30000,
    //pingInterval: 25000, // default - 25000
    //pingTimeout: 60000, // default - 60000
    //transports: ['websocket'],
    //allowUpgrades: false
});
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const csvWriter = require('csv-write-stream');
const csvReader = require('csv-parser');


/*
Note: 
a "play" is one card being played
a "round" is four cards being played, one from each player
a "hand" is one set of ten plays (a complete hand of cards)
a "game" is a set of rounds, that finishes when a team gets 500 points
*/

const GP_PREGAME = 0;
const GP_SUSPENDED = 1;
const GP_GAMESTARTED = 2;
const GP_BIDDING = 3;
const GP_SELECTINGMIDDLE = 4;
const GP_PLAYINGHAND = 5;
const GP_GAMECOMPLETE = 6;

class GameState {
    gameStarted = false;
    gamePhase = GP_PREGAME;
    currentPlay = -1;
    currentRound = 0;
    currentHand = 0;
    currentBid = '';
    currentCardsPlayed = [];
    currentBidText = 'no bid (yet)';
    currentTeam = 0;
    currentPlayer = 0;
    currentDealerTeam = 0;
    currentDealerPlayer = 0;
    bidCount = 0;
    winningBid = '0';
    winningBidderTeam = -1;
    winningBidderPlayer = -1;
    winningPlayTeam = -1;
    winningPlayPlayer = -1;
    trumpSuit = '';
    highCard = '';
    firstCardPlayed = '';
    middle = [];
    twoJokers = false;

    constructor() {
    }
}

class Player {
    username = '';
    role = '';    // 'player' | 'observer' | 'suspended' | 'bot'
    team = -1;    // -1|0|1
    player = -1;  // -1|0|1
    hand = [];
    startingHand = [];
    handStrength = 0;
    suggestedBid = ''
    hsThisGame = [];  // accumulating array of hand strengths dealt over a game
    sbThisGame = [];  // accumulating array of suggested bids dealt over a game
    roomID = '';
    socketID = '';

    constructor(_username, _role, _team, _player, _roomID, _socketID) {
        this.username = _username;
        this.role = _role;
        this.team = _team;
        this.player = _player;
        this.roomID = _roomID;
        this.socketID = _socketID;
    }
}


class Room {
    roomID = 0;
    teams = [{ team: 'A', tricks: 0, score: 0 }, { team: 'B', tricks: 0, score: 0 }];
    players = [];   // array of Players
    botCount = 0;
    deck = [
        'AS', 'KS', 'QS', 'JS', 'TS', '9S', '8S', '7S', '6S', '5S', '4S',
        'AC', 'KC', 'QC', 'JC', 'TC', '9C', '8C', '7C', '6C', '5C', '4C',
        'AD', 'KD', 'QD', 'JD', 'TD', '9D', '8D', '7D', '6D', '5D', '4D',
        'AH', 'KH', 'QH', 'JH', 'TH', '9H', '8H', '7H', '6H', '5H', '4H'];//,
    //'JJ'];

    fullDeck = [];

    gs = new GameState();

    constructor(roomID) {
        this.roomID = roomID;
    }
}


let rooms = [];

//app.set('view engine', 'ejs')
app.use(express.static(__dirname + '/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
    //res.redirect('/${uuidV4()}');
});

app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/admin.html');
});

//app.get('/:room',(req,res)=> {
//  res.render('room', { roomID: req.params.room });
//});

function GetRoom(roomID) {
    for (r of rooms)
        if (r.roomID === roomID)
            return r;

    return null;
}

io.on('connection', (socket) => {
    console.log('a user connected');

    // handle a use disconnecting (done)
    socket.on('disconnect', () => {
        // get the player's room based on their socketID
        let room = null;
        let dp = null;
        for (r of rooms) {
            for (dp of r.players) {
                if (dp.socketID === socket.id) {
                    room = r;
                    break;
                }
            }
            if (room !== null)
                break;
        }

        // did we find the room/socket?  If not, nothing else to do
        // disconnecting
        if (room === null)
            return;

        // found the player, place them in a "suspended" class
        //let leaving = '';
        //let team = 0;
        //let player = 0;
        //let role = '';
        //// change player status in room's player list to 'suspended'
        //let leaving = p.username;
        //let team = p.team;
        //        player = room.players[i].player;
        //        role = room.players[i].role;
        //room.players.splice(i, 1);
        const role = dp.role;
        dp.role = 'suspended';
        dp.team = -1;
        dp.player = -1;

        let remaining = [];
        for (p of room.players)
            if (p.role === 'player')
                remaining.push(p.username);

        if (remaining.length < 4)
            room.gs.gamePhase = GP_SUSPENDED;

        socket.to(room.roomID).emit('user disconnected', dp.team, dp.player, dp.username, role);
        console.log('player ' + dp.username + ' disconnected.  Remaining players: ' + remaining.join());

        if (remaining.length === 0) {
            for (let i = 0; i < rooms.length; i++) {
                if (rooms[i] === room) {
                    console.log('Room ' + room.roomID + ' has been closed');
                    rooms.splice(i, 1);
                    break;
                }
            }
            io.emit('update rooms');
        }
    });

    // start a new room, done)
    socket.on('add room', (fn) => {
        let roomID = uuidv4();        // generate unique identifier
        let room = new Room(roomID);  // make the room 
        rooms.push(room);             // add to list of rooms open on the server
        console.log('adding room ' + roomID);
        io.emit('room added', roomID);   // let everyone know a new room was created
        fn(roomID);                   // callback for sender

    });

    socket.on('get playerlist', (fn) => {
        let _users = [];
        let count = 1;
        fs.createReadStream('data/games.csv')
           .pipe(csvReader())
           .on('data', (row) => {
               // have a game record, update the users stats
               let username = row['Username'];
               if (username !== undefined) {
                   if (_users.includes(username) === false) {
                       _users.push(username);
                   }
               }
            })
           .on('end', () => {
                // at this point, the 'users' dictionary contains entries for each user
                // in the database.  Clean up are return
                //console.log("users");
                //console.log(_users);
                fn(_users);
            });
    });


    // log the chat message (done)
    //socket.on('chat message', (roomID, msg) => {
    //    io.to(roomID).emit('chat message', msg);
    //});

    // a new player has joined - send the current teams list (done)
    socket.on('new player', (roomID, username, role) => {
        // get next open player slot for this room
        let room = GetRoom(roomID);
        if (room === null) {
            console.log('Unable to find room ' + roomID);
            return;
        }

        if (role === 'bot') {
            room.botCount++;
            username = GetRandomBotName();
        }

        // get count of current players in this room
        // and whether the new player is on the suspended list for this room
        let playerCount = 0;
        let wasSuspended = false;
        let newPlayer = null;
        for (p of room.players) {
            if (p.role === 'player')
                playerCount++;
            else if (p.role === 'suspended' && p.username === username) {
                wasSuspended = true;
                newPlayer = p;
                //newPlayer.role = playerInfo.role;
            }
        }
        
        if (wasSuspended === false) {
            console.log('Adding Player ' + username + ', Role: ' + role);
            newPlayer = new Player(username, role, -1, -1, roomID, socket.id);
            room.players.push(newPlayer);
        } else {  // WAS  suspended previously
            console.log('Resuming Player ' + username + ', Role: ' + role);
            newPlayer.role = role;
        }

        if (role === 'player' || role === 'bot') {
            if (playerCount > 3) {
                console.log('Error: player count exceeds 4!!!!');
                return;
            }

            let t0p0 = false;
            let t0p1 = false;
            let t1p0 = false;
            let t1p1 = false;
            for (const p of room.players) {
                if (p.role === 'player' || p.role === 'bot') {
                    if (p.team === 0 && p.player === 0)
                        t0p0 = true;
                    else if (p.team === 0 && p.player === 1)
                        t0p1 = true;
                    else if (p.team === 1 && p.player === 0)
                        t1p0 = true;
                    else if (p.team === 1 && p.player === 1)
                        t1p1 = true;
                }
            }

            if (t0p0 === false) {
                newPlayer.team = 0;
                newPlayer.player = 0;
            } else if (t0p1 === false) {
                newPlayer.team = 0;
                newPlayer.player = 1;
            } else if (t1p0 === false) {
                newPlayer.team = 1;
                newPlayer.player = 0;
            } else if (t1p1 === false) {
                newPlayer.team = 1;
                newPlayer.player = 1;
            }
            //console.log('Player ' + username + ' has joined a game');
        }
        else  // playerInfo.role != 'player'
            console.log('Observer ' + username + ' has joined a game');

        //newPlayer.username = username;

        if (newPlayer.role === 'bot')
            newPlayer.socketID = 'bot_' + room.botCount.toString();
        else {
            socket.join(roomID);  // connect socket to room 
            newPlayer.socketID = socket.id;
        }
        // player added === user-connected
        io.to(roomID).emit('player added', newPlayer.team, newPlayer.player, username, room.players);
        //io.to(roomID).emit('players', room.players);
        io.emit('update rooms');
    });

    socket.on('update team', (roomID, socketID, team, player) => {
        let room = GetRoom(roomID);
        if (room === null) {
            console.log('Unable to find room ' + roomID);
            return;
        }

        for (const p of room.players) {
            if (p.socketID === socketID) {
                p.team = team;
                p.player = player;
                break;
            }
        }
    });

    socket.on('get rooms', (fn) => {
        //console.log('get rooms called');
        let _rooms = [];

        for (r of rooms) {
            roomInfo = {
                roomID: r.roomID,
                players: r.players
            };
            _rooms.push(roomInfo);
        }

        fn(_rooms);
    });

    // request for current teams (done)
    socket.on('get teams', (roomID, fn) => {
        let room = GetRoom(roomID);
        [teamA, teamB] = GetTeams(room);
        fn(teamA, teamB);
    });

    // get the current game state
    socket.on('get state', (roomID, fn) => {
        let room = GetRoom(roomID);
        fn(room.gs, room.teams, room.players);
    });

    socket.on('get hand', (roomID, team, player, fn) => {
        let room = GetRoom(roomID);

        for (let p of room.players) {
            if ((p.role === 'player' || p.role === 'bot') && p.team === team && p.player === player) {
                fn(p.hand);
                break;
            }
        }
    });

    // tell observers to update hand when observee hand changes
    socket.on('update hand', (roomID, socketID, updatedHand, updatedMiddle) => {
        let room = GetRoom(roomID);

        if (room === null)
            console.log("no room found during on('update hand')");

        room.gs.middle = updatedMiddle;

        for (let p of room.players) {
            if ((p.role === 'player' || p.role === 'bot') && p.socketID === socketID) {
                p.hand = [...updatedHand];  // make a copy of the hand

                for (let obs of room.players) {
                    if (obs.role === 'observer') { // && obs.team === p.team && obs.player === p.player) {
                        io.to(obs.socketID).emit('new hand', updatedHand);
                        io.to(obs.socketID).emit('sending middle', updatedMiddle, (obs.team === p.team && obs.player === p.player) ? 1 : 0);
                    }
                }
            }
        }
    });

    // request to start a game (done)
    socket.on('start game', (roomID, restart, twoJokers) => {
        let room = GetRoom(roomID);

        if (restart)
            room.gs.gameStarted = false;

        if (room.gs.gameStarted)
            return;

        // to start a game, 
        // 1) reset round counter to 0 and team scores to 0
        // 2) run rounds until score of 500 achieved
        room.gs.currentHand = 0;
        room.gs.currentRound = 0;
        room.gs.currentDealerTeam = 0;
        room.gs.currentDealerPlayer = 0;
        //room.gs.currentDealerTeam = Math.floor(Math.random() * 2);
        //room.gs.currentDealerPlayer = Math.floor(Math.random() * 2);
        room.gs.winningBidderTeam = -1;
        room.gs.winningBidderPlayer = -1;
        room.gs.trumpSuit = '';
        room.gs.twoJokers = twoJokers;
        room.gs.gamePhase = GP_GAMESTARTED;
        room.teams[0].score = 0;
        room.teams[1].score = 0;
        io.to(roomID).emit('game started', twoJokers);

        room.gs.gameStarted = true;
        console.log('starting game in room ' + roomID);

        for (p of room.players) {
            p.handStrength = 0;
            p.hsThisGame = [];
            p.suggestedBid = 0;
            p.sbThisGame = [];
        }

        StartHand(room);
    });

    // redeal a hand
    socket.on('redeal', (roomID) => {
        let room = GetRoom(roomID);
        io.to(roomID).emit('redeal');

        room.gs.bidCount = 0;
        StartHand(room);  // this calls GetNextPlayer
    });

    // request to place bid (done)
    socket.on('place bid', (roomID, bid, bidText) => {
        let room = GetRoom(roomID);
        PlaceBid(room, bid, bidText);
    });

    //  a partners is sending a low card to a winning nello bidder
    socket.on('receive nello', (roomID, card) => {
        let room = GetRoom(roomID);
        let p = GetPlayer(room, room.gs.winningBidderTeam, room.gs.winningBidderPlayer);

        console.log('Sending nello card ' + card + ' to player ' + p.username + '[' + p.socketID + ']');
        // add card to winning bidder's hand
        p.hand.push(card);
        // remove from partners hand
        RemoveCardFromHand(room, room.gs.winningBidderTeam, room.gs.winningBidderPlayer === 1 ? 0 : 1, card);

        // send 'receive nello' msg to the winning player to send the client the card
        if (p.role === 'player')
            io.to(p.socketID).emit('receive nello', card);
        else
            BotReceiveNelloCard(p, card);

        // send to observers as well
        for (const obs of room.players) {
            if (obs.role === 'observer' && obs.team === room.gs.winningBidderTeam && obs.player === room.gs.winningBidderPlayer) {
                io.to(obs.socketID).emit('receive nello', card);
            }
        }
    });

    // the winning bidder is moving a card to/from the middle and their hand
    // update state and alter observers
    socket.on('transfer middle', (roomID, team, player, cardID, direction) => {
        let room = GetRoom(roomID);

        if (direction === 0) { // from middle to hand
            AddCardToHand(room, team, player, cardID); // add to hand
            room.gs.middle.splice(room.gs.indexOf(cardID), 1);  // remove from middle
        } else {
            RemoveCardFromHand(room, team, player, cardID);  // remove from hand
            room.gs.middle.push(cardID);  // add to middle
        }

        // let observers know what happened
        for (obs of room.players) {
            if (obs.role === 'observer')
                io.to(obs.socketID).emit('transfer middle', team, player, cardID, direction);
        }

        io.to(roomID).emit('transfer middle', team, player, cardID, direction);
    });

    // indicates middle selection is complete (done)
    socket.on('middle complete', (roomID, flag) => {
        let room = GetRoom(roomID);

        if (flag === 0) {   //non-double-nello or first exchange of double nello
            if (room.gs.winningBid !== 'Nd') {
                MiddleComplete(room);
                StartRound(room);
            }
            else {   // double nello
                const partner = room.gs.winningBidderPlayer === 0 ? 1 : 0;
                const p = GetPlayer(room, room.gs.winningBidderTeam, partner);
                
                io.to(p.socketID).emit('sending middle', room.gs.middle, 0);

                // send middle to any observers of this player as well
                for (const obs of room.players) {
                    let bidWinner = room.gs.w
                    if (obs.role === 'observer') // && obs.team === p.team && obs.player === p.player)
                        io.to(obs.socketID).emit('sending middle', room.gs.middle, (obs.team === room.gs.winningBidderTeam && obs.player === room.gs.bidWinner.player) ? 1 : 0);
                }
                io.to(room.roomID).emit('select middle Nd', p.socketID);
            }
        }
        else { // flag === 1 - partner in Nd bid finished
            MiddleComplete(room);
            StartRound(room);
        }
    });

    // indicates first card of a round has been played) (done)
    socket.on('first card played', (roomID, card) => {
        console.log('first card played: ' + card);
        let room = GetRoom(roomID);
        let bidderName = GetUsername(room, room.gs.winningBidderTeam, room.gs.winningBidderPlayer, 'player');
        io.to(roomID).emit('first card played', card, room.gs.winningBidderTeam, room.gs.winningBidderPlayer, bidderName, room.gs.winningBid);  // send back to all clients
    });

    // a card was played in this room update game state and let clients know
    socket.on('card played', (roomID, cardID) => {
        let room = GetRoom(roomID);
        CardPlayed(room, cardID);
    });

    socket.on('continue hand', (roomID) => {
        let room = GetRoom(roomID);
        StartHand(room);
    });

    socket.on('get handstrength', (roomID, team, player, fn) => {
        let room = GetRoom(roomID);
        for (p of room.players) {
            if ((p.role === 'player' || p.role === 'bot') && p.team === team && p.player === player) {
                //let hs = GetHandStrength(p.startingHand); 
                //console.log('getting handstrength for player ' + p.username + ': ' + p.hsThisGame + ' from player ' + p.socketID);
                fn(p.hsThisGame);
                break;
            }
        }
    });

    socket.on('get suggested bids', (roomID, team, player, fn) => {
        let room = GetRoom(roomID);
        for (p of room.players) {
            if ((p.role === 'player' || p.role === 'bot') && p.team === team && p.player === player) {
                //let hs = GetHandStrength(p.startingHand); 
                //console.log('getting handstrength for player ' + p.username + ': ' + p.hsThisGame + ' from player ' + p.socketID);
                fn(p.sbThisGame);
                break;
            }
        }
    });

    socket.on('get leaderboard', (fn) => {

        //let userStats = { '# Games':0, 'Games Won':0, '% Won':0, 'AHS':0 };   // 'user' :
        let users = {};
        fs.createReadStream('data/games.csv')
            .pipe(csvReader())
            .on('data', (row) => {
                // have a game record, update the users stats
                let username = row['Username'];
                if (username !== undefined) {
                    //console.log(username);
                    //console.log(row);

                    // find current record for this user (key = username, value=dictionary of stats)
                    if (users[username]) {
                        let user = users[username];
                        user['Games']++;
                        if (parseInt(row['Won']) > 0)
                            user['Games Won'] += 1;
                        user['AHS'] += parseInt(row['HandStrength']);
                    }
                    else {  // user not found, so add them
                        users[username] = {
                            'Games': 1,
                            'Games Won': parseInt(row['Won']),
                            '% Won': 0,
                            'AHS': parseInt(row['HandStrength'])
                        };
                    }
                }
            })
            .on('end', () => {
                // at this point, the 'users' dictionary contains entries for each user
                // in the database.  Clean up are return
                for (let username in users) {
                    let user = users[username];
                    //console.log(username);
                    //console.log(user);
                    user['% Won'] = user['Games Won'] / user['Games'];
                    user['AHS'] = user['AHS'] / user['Games'];
                    //console.log(user);
                }
                fn(users);
            });
    });

    socket.on('suggest bid', (roomID, team, player, fn) => {
        let room = GetRoom(roomID);

        const p = GetPlayer(room, team, player);
        const topBid = GetSuggestedBid(p.hand);

        //let topBidRank = 0;
        //let topBid = '';
        //for (const [trumpSuit, bidRank] of Object.entries(topBids)) {
        //    console.log('  examining bid [' + bidRank.toString() + trumpSuit + '] to ' + p.username);
        //    if (bidRank > topBidRank) {
        //        topBidRank = bidRank;
        //        topRank = Math.round(topBidRank);
        //        topBid = topRank.toString() + trumpSuit;
        //    }
        //}
        console.log('suggesting bid [' + topBid + '] to ' + p.username);
        fn(topBid);
    });

    socket.on('suggest bid from hand', (hand, fn) => {
        const topBid = GetSuggestedBid(hand);
        console.log('suggesting bid [' + topBid + '] for hand ' + hand);
        fn(topBid);
    });

    socket.on('error', (err) => {
        console.error('Socket Error Encountered: ', err);
    });
});

io.on('error', (err) => {
    console.error('io Error Encountered: ', err);
});

process.on('uncaughtException', (err) => {
    console.error('Process Error Encountered: ', err);
});

server.listen(8877, () => {
    console.log('listening on *:8877');
});

/////////////////////////////////////////////
// helper functions
////////////////////////////////////////////

function GetNextPlayer(team, player) {
    // sequence is T0P0,T1P0,T0P1,T1P1
    if (team === 0 && player === 0)
        team = 1;
    else if (team === 1 && player === 0) {
        team = 0;
        player = 1;
    }
    else if (team === 0 && player === 1)
        team = 1;
    else {  // team == 1, player == 1
        team = 0;
        player = 0;
    }

    return [team, player];
}

function GetScoreFromBid(bid) {
    let rank = bid[0];
    let suit = bid[1];

    if (rank === 'T')
        rank = 10;

    //   rank:  6   7   8   9  10
    // spades: 40/140/240/340/440
    // clubs: 60/160/260...
    // diamonds: 80/180/280...
    // hearts: 100/200/300...
    // notrump: 120/220/320...
    // nello: 250

    // nello?
    switch (bid) {
        case 'Nl': return 250;   // nello
        case 'No': return 350;   // open face nello
        case 'Nd': return 450;   // double nello
    }

    // not nello?
    let score = (rank - 6) * 100;
    switch (suit) {
        case 'S': score += 40; break;
        case 'C': score += 60; break;
        case 'D': score += 80; break;
        case 'H': score += 100; break;
        case 'N': score += 120; break;
    }
    return score;
}

function GetSocketID(room, team, player, roles) {
    for (const p of room.players) {
        if (roles.includes(p.role) && p.team === team && p.player === player)
            return p.socketID;
    }
    return null;
}

function GetUsername(room, team, player, role) {
    for (const p of room.players) {
        if (p.role === role && p.team === team && p.player === player)
            return p.username;
    }
}

function GetPlayer(room, team, player) {
    for (const p of room.players) {
        if ((p.role === 'player' || p.role === 'bot') && p.team === team && p.player === player)
            return p;
    }
    console.log('GetPlayer() - Team ' + team + ' Player ' + player + ' not found in room ' + room.roomID);
    return null;
}

function IsHighCard(cardID, highCardID, firstPlaySuit, trumpSuit) {
    // joker always wins
    if (cardID === 'JJ')
        return true;

    if (highCardID === '')  // first card???  NEED TO RESET BEFORE EACH HAND
        return true;

    let cs, cr, hs, hr;
    [cr, cs] = GetRankAndSuit(cardID, trumpSuit);   // card play
    [hr, hs] = GetRankAndSuit(highCardID, trumpSuit);  // current high card

    // bid is no trump or nello, only following suit and rank matters
    let isNello = trumpSuit === 'l' || trumpSuit === 'o' || trumpSuit === 'd';
    if (trumpSuit === 'N' || isNello)
        return ((cs === firstPlaySuit) && (cr > hr)) ? true : false;

    // if non-trump card doesn't follow suit, it loses
    if (cs !== trumpSuit && cs !== firstPlaySuit)
        return false;

    // if high card is trump, it beats any non-trump card
    if (hs === trumpSuit && cs !== trumpSuit)
        return false;

    // if card is trump, it beats any non-trump high card, or any lower trump
    if (cs === trumpSuit && hs !== trumpSuit)
        return true;

    // cards are same suit (including both trump) - rank is all that matter
    if (cs === hs)
        return (cr > hr) ? true : false;
    else
        return false;
}

// start a hand (play ten rounds) - deal, request bids (done)
function StartHand(room) {
    io.to(room.roomID).emit('start hand', room.gs.currentHand);
    console.log('starting hand' + room.gs.currentHand);

    // reset state as needed
    room.gs.currentBid = '';
    room.gs.currentBidText = 'no bid (yet)';
    room.gs.trumpSuit = '';
    room.teams[0].tricks = 0;
    room.teams[1].tricks = 0;

   
    /*
    let misdeal = true;
    while (misdeal) {
        // shuffle the deck 5 times
        for (let j = 0; j < 5; j++)
            room.deck = _ShuffleArray(room.deck);

        // check for misdeal
        misdeal = false;
        for (let i = 0; i < 4; i++) {
            let start = i * 10;
            let hand = room.deck.slice(start, start+10);
            if (IsMisdeal(hand)) {
                misdeal = true;
                break;
            }
        }
    }*/
    // check for two jokers
    //let deck = [...room.deck];  // make a copy of the hand array
    //if (room.gs.twoJokers && room.deck.length !== 46) {
    //}

    // shuffle the room deck 2 times.
    for (let j = 0; j < 2; j++)
        _ShuffleArray(room.deck);

    // add jokers as needed
    room.fullDeck = [...room.deck];  // make a copy of the deck
    if (room.gs.twoJokers) {
        room.fullDeck.push('Jr');
        room.fullDeck.push('Jb');
    } else
        room.fullDeck.push('JJ');

    // shuffle the deck 3 more times
    for (j = 0; j < 3; j++)
        _ShuffleArray(room.fullDeck);

    // deal cards
    let i = 0;
    let misdeal = false;
    for (const p of room.players) {
        if (p.role === 'player' || p.role === 'bot') {
            let hand = room.fullDeck.slice(i, i + 10);
            p.startingHand = [...hand];  // make a copy of the hand array
            p.hand = [...hand];

            if (p.role === 'player') {
                console.log('Dealing ' + hand.join() + ' to ' + p.username + '(trump=' + room.gs.trumpSuit + ')');
                io.to(p.socketID).emit('new hand', hand);

                if (IsMisdeal(hand))
                    misDeal = true;
                    //io.emit('misdeal', p.username );
                    //io.to(p.socketID).emit('misdeal');
            }

            // send to any observers of this player as well
            for (const pp of room.players) {
                if (pp.role === 'observer' && pp.team === p.team && pp.player === p.player)
                    io.to(p.socketID).emit('new hand', hand);
            }

            let handStrength = GetHandStrength(hand, room.gs.trumpSuit);
            p.hsThisGame.push(handStrength);
            p.handStrength += handStrength;

            let suggestedBid = GetSuggestedBid(hand);
            if ( suggestedBid[0] === 'T')
                p.sbThisGame.push(10);
            else
                p.sbThisGame.push(parseInt(suggestedBid[0]));

            p.suggestedBid = suggestedBid;

            i += 10;
        }
    }

    if (misdeal)
        io.emit('misdeal', p.username);

    // cards delt, start bidding
    room.gs.gamePhase = GP_BIDDING;
    io.to(room.roomID).emit('start bidding');
    room.gs.currentBid = '';
    room.gs.currentBidText = 'no bid (yet)';
    room.gs.winningBidderTeam = 0;
    room.gs.winningBidderPlayer = 0;
    // bidding starts with first player after dealer
    [room.gs.currentTeam, room.gs.currentPlayer] = GetNextPlayer(room.gs.currentDealerTeam, room.gs.currentDealerPlayer);

    // request a bid from the current team/player
    let p = GetPlayer(room, room.gs.currentTeam, room.gs.currentPlayer);
    console.log('Bidding started by ' + p.username);
    io.to(room.roomID).emit('request bid', p.socketID, room.gs.currentBid,
        room.gs.currentBidText, true, p.username, null, -1, -1, null);
    if (p.role === 'bot')
        BotHandleBidRequest(room, p, room.gs.currentBid, room.gs.winningBidderTeam);
}


function PlaceBid(room, bid, bidText) {

    let pass = false;

    if (bid === 'pass') {
        pass = true;
    }
    else {  // e.g. '6C'
        room.gs.currentBid = bid;
        room.gs.currentBidText = bidText;
        room.gs.winningBid = bid;
        room.gs.winningBidderTeam = room.gs.currentTeam;
        room.gs.winningBidderPlayer = room.gs.currentPlayer;
        room.gs.trumpSuit = bid[1];   // Note: for nello, this is 'l/o/d'
    }

    //console.log('Bid placed: ' + bidText + ' (' + bidText + '), current Winning Bid is ' + room.gs.winningBid + ' (' + room.gs.currentBidText + ')');
    room.gs.bidCount++;

    // end of bidding?
    if (room.gs.bidCount === 4) {
        room.gs.bidCount = 0;

        io.to(room.roomID).emit('bidding complete', room.gs.winningBid, room.gs.currentBidText, room.gs.winningBidderTeam, room.gs.winningBidderPlayer);

        let bidWinner = GetPlayer(room, room.gs.winningBidderTeam, room.gs.winningBidderPlayer);
        let socketID = bidWinner.socketID; // GetSocketID(room, room.gs.winningBidderTeam, room.gs.winningBidderPlayer, ['player', 'bot']);

        console.log('Bidding completed.  Winning Bid is ' + room.gs.currentBidText + ', placed by ' + bidWinner.username);

        let middle = room.fullDeck.slice(40);
        room.gs.middle = [...middle]; // copy to gamestate

        // send the middle to the winning bidder (and updated hand for winning player with middle to obervers)
        console.log('Sending middle (' + middle.join() + ') to ' + bidWinner.username + ' through socket:' + socketID);

        if (bidWinner.role === 'player')
            io.to(socketID).emit('sending middle', middle, 0);

        // send middle to any observers of this player as well
        for (const obs of room.players) {
            if (obs.role === 'observer') // && obs.team === p.team && obs.player === p.player)
                io.to(obs.socketID).emit('sending middle', middle, (obs.team === bidWinner.team && obs.player === bidWinner.player) ? 1 : 0);
        }

        room.gs.gamePhase = GP_SELECTINGMIDDLE;
        io.to(room.roomID).emit('select middle', socketID, bidWinner.username, room.gs.winningBid, room.gs.currentBidText);

        // indicate the winning bidder will start the hand
        room.gs.currentTeam = room.gs.winningBidderTeam;
        room.gs.currentPlayer = room.gs.winningBidderPlayer;

        // if a nello bid, ask partner to send a card
        switch (room.gs.winningBid) {
            case 'Nl':    // regular nello
            case 'No': {  // open face (not double)
                // have partner send a card to the winning bidder
                for (const p of room.players) {
                    if ((p.role === 'player' || p.role === 'bot') && p.team === room.gs.winningBidderTeam && p.player !== room.gs.winningBidderPlayer) {
                        console.log('Nello bid: sending request for low card to ' + p.username + ' [' + p.socketID + ']');

                        if (p.role === 'player')
                            io.to(p.socketID).emit('send nello');
                        else
                            BotHandleNelloRequest(p);
                        break;
                    }
                }
                break;
            }
            //case 'Nd':   // double nello
        }

        // if winner was a bot, have them process the middle
        if (bidWinner.role === 'bot')
            BotProcessMiddle(room, bidWinner, middle, room.gs.trumpSuit);

        return;
    }   // end of: if ( bidCount==4) (end of bidding)

    // bidding will continue... move to next bidder
    let lastBidderName = GetUsername(room, room.gs.currentTeam, room.gs.currentPlayer, 'player');
    [room.gs.currentTeam, room.gs.currentPlayer] = GetNextPlayer(room.gs.currentTeam, room.gs.currentPlayer);

    // get the socketID for the next bidder and request a new bid
    let bidder = GetPlayer(room, room.gs.currentTeam, room.gs.currentPlayer);

    console.log('Bid requested from ' + bidder.username);

    winningBidder = GetUsername(room, room.gs.winningBidderTeam, room.gs.winningBidderPlayer, 'player');

    io.to(room.roomID).emit('request bid', bidder.socketID, room.gs.currentBid, room.gs.currentBidText,
        pass, bidder.username, lastBidderName, room.gs.winningBidderTeam, room.gs.winningBidderPlayer,
        winningBidder);

    if (bidder.role === 'bot')
        BotHandleBidRequest(room, p, room.gs.currentBid, room.gs.winningBidderTeam);
}

function MiddleComplete(room) {
    console.log('Middle selection complete, starting round');
    room.gs.currentRound = 0;
    // send observers updated hand?
    //for (const obs of room.players) {
    //    if (obs.team === p.team && obs.player === p.player)
    //        io.to(obs.socketID).emit('new hand', hand);

    // note - currentTeam/Player already set to winningBidderTeam/Player        
    ///StartRound(room);
}

// start a round of four cards to be played (done)
function StartRound(room) {
    // starts a new round (play four cards), currentTeam/gs.currentPlayer start
    room.gs.currentCardsPlayed = [];
    room.gs.currentPlay = 0;
    room.gs.highCard = '';
    room.gs.gamePhase = GP_PLAYINGHAND;
    console.log("emitting 'start round' " + room.gs.currentRound);
    io.to(room.roomID).emit('start round', room.gs.currentRound);

    // send a "play card" message to the room, indicating current player
    let p = GetPlayer(room, room.gs.currentTeam, room.gs.currentPlayer);
    if (p.role === 'player')
        io.to(room.roomID).emit('play card', room.gs.currentRound, p.socketID, p.username);
    else if (p.role === 'bot')
        BotPlayCard(p);
}


function CardPlayed(room, cardID) {
    console.log('card played: ' + cardID);

    // remove card from players hand in server representation
    RemoveCardFromHand(room, room.gs.currentTeam, room.gs.currentPlayer, cardID);
    room.gs.currentCardsPlayed.push(cardID);

    // first play of round?
    if (room.gs.currentPlay === 0) {
        room.gs.firstCardPlayed = cardID;
        room.gs.highCard = cardID;
        room.gs.winningPlayTeam = room.gs.currentTeam;
        room.gs.winningPlayPlayer = room.gs.currentPlayer;
    }
    // or card played is current the high card?
    else if (IsHighCard(cardID, room.gs.highCard, room.gs.firstCardPlayed[1], room.gs.winningBid[1])) {
        room.gs.highCard = cardID;
        room.gs.winningPlayTeam = room.gs.currentTeam;
        room.gs.winningPlayPlayer = room.gs.currentPlayer;
    }
    // tell clients to transfer card to play area
    console.log("emitting 'card played' (" + cardID + ' by ' + GetUsername(room, room.gs.currentTeam, room.gs.currentPlayer, 'player') + ', play=' + room.gs.currentPlay + ')');
    io.to(room.roomID).emit('card played', room.gs.currentTeam, room.gs.currentPlayer, cardID);

    // indicate hand has been played
    room.gs.currentPlay++;

    if (room.gs.currentPlay < 4) { // still playing this play (i.e. hasn't gone all the way around)? 
        // get next player
        [room.gs.currentTeam, room.gs.currentPlayer] = GetNextPlayer(room.gs.currentTeam, room.gs.currentPlayer);

        // if playing nello and next player is non-active nello player, skip
        let nello = (room.gs.winningBid === 'Nl' || room.gs.winningBid === 'No') ? true : false;
        if (nello && room.gs.currentTeam === room.gs.winningBidderTeam && room.gs.currentPlayer !== room.gs.winningBidderPlayer) {
            room.gs.currentPlay++;
            [room.gs.currentTeam, room.gs.currentPlayer] = GetNextPlayer(room.gs.currentTeam, room.gs.currentPlayer);
        }
    }
    if (room.gs.currentPlay < 4) { // still playing this play? 
        let p = GetPlayer(room, room.gs.currentTeam, room.gs.currentPlayer);
        console.log("emitting 'play card' to " + p.username);
        if (p.role === 'player')
            io.to(room.roomID).emit('play card', room.gs.currentRound, p.socketID, p.username);
        else if (p.role === 'bot')
            BotPlayCard(p);
    }
    else {  // four cards played, move to next round
        RoundComplete(room);
    }
}


function RoundComplete(room) {
    console.log('Completed Round ' + room.gs.currentRound);

    // find winner of this round (high card played)
    room.teams[room.gs.winningPlayTeam].tricks += 1;

    let winningUser = GetUsername(room, room.gs.winningPlayTeam, room.gs.winningPlayPlayer, 'player');
    console.log("emitting 'round complete' msg, winner is " + winningUser);
    io.to(room.roomID).emit('round complete', room.gs.currentRound, winningUser, room.teams[0].tricks, room.teams[1].tricks);

    // if open-face nello, indicate hand to show
    if (room.gs.currentRound === 0 && room.gs.winningBid === 'No') {
        winningBidder = GetPlayer(room, room.gs.winningBidderTeam, room.gs.winningBidderPlayer);
        io.to(room.roomID).emit('show openface hand', winningBidder.username, winningBidder.hand);
    }

    // update game state to start new round (of four plays)
    room.gs.currentRound++;
    room.gs.currentPlay = 0;

    // do we need to do more rounds (i.e. any cards left to play?)
    // if so, start another round, starting with the winning player
    if (room.gs.currentRound < 10) {
        room.gs.currentTeam = room.gs.winningPlayTeam;
        room.gs.currentPlayer = room.gs.winningPlayPlayer;
        room.gs.currentPlay = 0;
        console.log("Starting Round " + room.gs.currentRound);
        StartRound(room);
    }
    else {
        HandComplete(room);
    }
}

function RemoveCardFromHand(room, team, player, cardID) {
    let p = GetPlayer(room, team, player);
    for (let i = 0; i < p.hand.length; i++) {
        if (p.hand[i] === cardID) {
            p.hand.splice(i, 1);
        }
    }
}


function AddCardToHand(room, team, player, cardID) {
    for (const p of room.players) {
        let found = false;
        if ((p.role === 'player' || p.role === 'bot') && p.team === team && p.player === player) {
            found = true;
            p.hand.push(cardID);
            break;
        }
        if (found === true)
            break;
    }
}

// a hand has finished - check for game over, and start new hand if not 
function HandComplete(room) {
    console.log("Hand Complete: " + room.gs.currentRound);
    // check to see if there is a winner.  If so, finish game; 
    // otherwise, do another round.

    // did the winning bidder make the bid?
    let biddingTeam = room.gs.winningBidderTeam;
    let biddingTeamTricks = room.teams[biddingTeam].tricks;
    let biddingTeamPts = GetScoreFromBid(room.gs.winningBid);
    let bidMade = false;
    let bid = room.gs.currentBid;
    let bidRank = bid[0];

    // did the bidder get enough tricks to make bid?
    // nello-> no tricks; otherwise, cover bid
    let isNello = bid === 'Nl' || bid === 'No' || bid === 'Nd';
    if ((isNello && biddingTeamTricks === 0) || (!isNello && biddingTeamTricks >= bidRank)) {
        bidMade = true;
    }
    else {
        biddingTeamPts *= -1;  // flip sign of bid value
        bidMade = false;
    }
    room.teams[room.gs.winningBidderTeam].score += biddingTeamPts;

    if (biddingTeam === 0)
        room.teams[1].score += 10 * room.teams[1].tricks;
    else
        room.teams[0].score += 10 * room.teams[0].tricks;

    const imgURLWinner = GetRandomImage(0);
    const imgURLLoser = GetRandomImage(1);
    //console.log("imgURL= " + imgURLWinner);
    //io.to(room.roomID).emit('hand complete', room.gs.currentHand, biddingTeam, bidMade,
    //    biddingTeamTricks, biddingTeamPts, room.teams[0].score, room.teams[1].score, imgURLWinner);

    let imgURL = null; // = imgURLWinner;
    let msg = null;

    for (let p of room.players) {
        if (p.role === 'player' || p.role === 'observer') {

            if (p.team === room.gs.winningBidderTeam) {
                if (bidMade) {
                    imgURL = imgURLWinner;
                    msg = "Congratulations! You made your bid!";
                } else {
                    imgURL = imgURLLoser;
                    msg = "Bad News! You got set!";
                }
            } else {  // non-bidding team
                if (bidMade) {
                    imgURL = imgURLLoser;
                    msg = "Well, you tried, but they got their bid.";
                } else {
                    imgURL = imgURLWinner;
                    msg = "Congratulation, you set the other team!";
                }
            }

            console.log("emitting 'hand complete' msg");
            io.to(p.socketID).emit('hand complete', room.gs.currentHand, biddingTeam, bidMade,
                biddingTeamTricks, biddingTeamPts, room.teams[0].score, room.teams[1].score, msg, imgURL);
        }
    }

    SaveHandData(room, biddingTeamTricks);

    let gameWinner = -1;
    if (room.teams[0].score >= 500 && room.teams[0].score > room.teams[1].score)
        gameWinner = 0;
    else if (room.teams[1].score >= 500 && room.teams[1].score > room.teams[0].score)
        gameWinner = 1;
    else if (room.teams[0].score >= 500 && (room.teams[0].score === room.teams[1].score))
        gameWinner = 2;  // tie!

    console.log("Game Winner: " + gameWinner + "  " + room.teams[0].score + " to " + room.teams[1].score);

    // end of game reached?
    if (gameWinner >= 0) {
        [teamA, teamB] = GetTeams(room);
        room.gs.gamePhase = GP_GAMECOMPLETE;
        GameComplete(room);
        io.to(room.roomID).emit('game complete', gameWinner, room.teams[0].score, room.teams[1].score, teamA, teamB);
    }
    else {
        room.gs.currentHand++;
        [room.gs.currentDealerTeam, room.gs.currentDealerPlayer] = GetNextPlayer(room.gs.currentDealerTeam, room.gs.currentDealerPlayer);
        //StartHand(room);
    }
}


function GameComplete(room) {
    room.gs.gameStarted = false;

    for (p of room.players) {
        if (room.gs.currentHand > 0 && p.hsThisGame.length > 0)
            p.handStrength /= p.hsThisGame.length; // average hand strength for game
    }
    SaveGameData(room);
}


function GetRandomImage(flag) {
    if (flag === 0) {
        const directoryPath = path.join(__dirname, '/public/Animations/Winners');
        const files = fs.readdirSync(directoryPath);
        const file = files[Math.floor(Math.random() * files.length)];
        console.log('Getting random file: ' + file);
        return 'Animations/Winners/' + file;
    }
    else {
        const directoryPath = path.join(__dirname, '/public/Animations/Losers');
        const files = fs.readdirSync(directoryPath);
        const file = files[Math.floor(Math.random() * files.length)];
        console.log('Getting random file: ' + file);

        return 'Animations/Losers/' + file;
    }
}


// Fisher-Yates verion (in place)
function _ShuffleArray(array) {
    let m = array.length;
    let i = 0;

    while (m) {
        i = Math.floor(Math.random() * m--);

        [array[m], array[i]] = [array[i], array[m]];
    }

    return array;
}


function shuffleArray(array) {
    let curId = array.length;
    // There remain elements to shuffle
    while (0 !== curId) {
        // Pick a remaining element
        let randId = Math.floor(Math.random() * curId);
        curId -= 1;
        // Swap it with the current element.
        let tmp = array[curId];
        array[curId] = array[randId];
        array[randId] = tmp;
    }
    return array;
}

/*
function SortCards(a, b) {
    let sa = '';  // suit (character)
    let sb = '';
    let na = 0; // numeric ranking of suits
    let nb = 0;
    let ra = 0; // rank
    let rb = 0;
 
    [ra, sa] = GetRankAndSuit(a,trumpSuit);   //??????
    [rb, sb] = GetRankAndSuit(b,trumpSuit);
 
    //console.log('CardA: ' + a + 'r=' + ra + ',s=' + sa);
    //console.log('CardB: ' + b + 'r=' + rb + ',s=' + sb);
 
    switch (sa) {
        case 'S': na = 0; break;
        case 'C': na = 1; break;
        case 'D': na = 2; break;
        case 'H': na = 3; break;
        case 'J': na = 4; break;// joker
    }
 
    switch (sb) {
        case 'S': nb = 0; break;
        case 'C': nb = 1; break;
        case 'D': nb = 2; break;
        case 'H': nb = 3; break;
        case 'J': nb = 4; break;// joker
    }
    // different suits?
    if (na !== nb)
        return (na - nb);
 
    // note: no jokers after this, ther are filtered out above
    // same suit, so sort by rank
    return (ra - rb);
}
*/

function GetRankAndSuit(card, trumpSuit) {
    // trumpSuit == ''     ==> No Trump
    // trumpSuit in 'SCDH' ==> Spade/Club/Diamond/Heart

    // first, handle jokers 
    // Rank = 17.  If no trump defined, return 'J' for suit, else trump suite
    if (card === 'JJ') {
        return [17, (trumpSuit === '') ? 'J' : trumpSuit];
    }
    else if (card === 'Jr') {
        // if noTrump or red trump, this is high joker
        if (trumpSuit === '' || trumpSuit === 'H' || trumpSuit === 'D')
            return [18, (trumpSuit === '') ? 'J' : trumpSuit];
        else
            return [17, (trumpSuit === '') ? 'J' : trumpSuit];
    }
    else if (card === 'Jb') {
        // if black trump, this is high joker
        if (trumpSuit === 'C' || trumpSuit === 'S')
            return [18, (trumpSuit === '') ? 'J' : trumpSuit];
        else
            return [17, (trumpSuit === '') ? 'J' : trumpSuit];
    }

    let rank = 0;

    // trump defined? then handle jacks separately
    if (IsTrump(card, trumpSuit) && card[0] === 'J') { // it's trump
        rank = (card[1] === trumpSuit) ? 16 : 15;
        return [rank, trumpSuit];
    }
    // no trump defined, treat jacks normally
    switch (card[0]) {
        case 'T': rank = 10; break;
        case 'J': rank = 11; break;
        case 'Q': rank = 12; break;
        case 'K': rank = 13; break;
        case 'A': rank = 14; break;
        default: rank = parseInt(card[0]);
    }

    return [rank, card[1]];
}

function IsTrump(card, trumpSuit) {
    if (trumpSuit === '')
        return false;

    // joker? always trump
    if (card[1] === 'J')  // joker?
        return true;

    // jack and trump defined?
    if (card[0] === 'J') { // jack?
        switch (card[1]) {
            case 'S':
                return (trumpSuit === 'S') ? 1 : (trumpSuit === 'C') ? -1 : 0;
            case 'C':
                return (trumpSuit === 'C') ? 1 : (trumpSuit === 'S') ? -1 : 0;
            case 'D':
                return (trumpSuit === 'D') ? 1 : (trumpSuit === 'H') ? -1 : 0;
            case 'H':
                return (trumpSuit === 'H') ? 1 : (trumpSuit === 'D') ? -1 : 0;
        }
    }

    // not a jack
    return (card[1] === trumpSuit) ? 1 : 0;
}


function GetTeams(room) {
    if (room === null)
        return null;
    let teamA = [];
    let teamB = [];

    for (const p of room.players) {
        if (p.role === 'player') {
            if (p.team === 0)
                teamA.push(p.username);
            else
                teamB.push(p.username);
        }
    }
    return [teamA, teamB];
}


function IsMisdeal(hand) {
    let misdeal = true;
    for (card of hand) {
        switch (card[0]) {
            case 'J':
            case 'Q':
            case 'K':
                misdeal = false;
                break;
            default:
                continue;
        }
    }
    if (misdeal)
        LogHand("misdeal:", hand);

    return misdeal;
}

function GetHandStrength(hand, trumpSuit) {
    // <= 10 count 0 pt
    // Q = 1pt
    // K = 2pts
    // A = 3pt
    // Jack (rightBower=5pt,left bower 4pt, NT=0, trump undefined=1
    // Joker = 6pts
    // out of suite = 2 pts
    // 1 pt for count of suite > 3
    // 2 pt for count of suite > 4
    // 3 pt for count of suite > 5
    // 4 pts for count of suite > 6 etc
    // trump adds two to any 

    let strength = 0;
    let spadeCount = 0;
    let clubCount = 0;
    let heartCount = 0;
    let diamondCount = 0;
    for (card of hand) {
        switch (card[0]) {
            case 4:
            case 5:
            case 6:
            case 7:
            case 8:
            case 9:
            case 'T':
                if (IsTrump(card, trumpSuit))
                    strength += 2;
                break;

            case 'J':
                if (card[1] === 'J')        // joker
                    strength += 7;
                else if (card[1] === trumpSuit)     // right bower
                    strength += 5;
                else if (IsTrump(card, trumpSuit))  // left bower
                    strength += 6;
                else if (trumpSuit === '')
                    strength += 1;
                break;

            case 'Q': strength += IsTrump(card, trumpSuit) ? 2 : 0; break;
            case 'K': strength += IsTrump(card, trumpSuit) ? 3 : 1; break;
            case 'A': strength += IsTrump(card, trumpSuit) ? 4 : 2; break;

        }
        switch (card[1]) {
            case 'C': clubCount++; break;
            case 'S': spadeCount++; break;
            case 'D': diamondCount++; break;
            case 'H': heartCount++; break;
        }
    }

    // no trump yet?
    switch (trumpSuit) {
        case '':   // trump not defined
        case 'T':  // no trump
        case 'l':   // nello
        case 'o':   // open face nello
        case 'd':   // double nello
            if (clubCount > 3)
                strength += clubCount - 3;

            if (spadeCount > 3)
                strength += spadeCount - 3;

            if (diamondCount > 3)
                strength += diamondCount - 3;

            if (heartCount > 3)
                strength += heartCount - 3;

            break;

        // trump defined...
        case 'S': if (spadeCount === 0) strength += 3; break;
        case 'C': if (clubCount === 0) strength += 3; break;
        case 'D': if (diamondCount === 0) strength += 3; break;
        case 'H': if (heartCount === 0) strength += 3; break;
    }

    return strength;
}

function SaveHandData(room, biddingTeamTricks) {
    var writer = csvWriter({ sendHeaders: false }); //Instantiate var
    var csvFilename = "data/hands.csv";

    // If CSV file does not exist, create it and add the headers
    if (!fs.existsSync(csvFilename)) {
        writer = csvWriter({ sendHeaders: false });
        writer.pipe(fs.createWriteStream(csvFilename));
        writer.write({
            header1: 'C1',
            header2: 'C2',
            header3: 'C3',
            header4: 'C4',
            header5: 'C5',
            header6: 'C6',
            header7: 'C7',
            header8: 'C8',
            header9: 'C9',
            header10: 'C10',
            header11: 'Username',
            header12: 'Bid',
            header13: 'Tricks'
        });
        writer.end();
    }

    // Append some data to CSV the file    
    writer = csvWriter({ sendHeaders: false });
    writer.pipe(fs.createWriteStream(csvFilename, { flags: 'a' }));

    let hand = '';
    let username = '';
    for (const p of room.players) {
        if (p.role === 'player' && p.team === room.gs.winningBidderTeam && p.player === room.gs.winningBidderPlayer) {
            hand = p.startingHand;
            username = GetUsername(room, p.team, p.player, 'player');
            break;
        }
    }

    writer.write({
        header1: hand[0],
        header2: hand[1],
        header3: hand[2],
        header4: hand[3],
        header5: hand[4],
        header6: hand[5],
        header7: hand[6],
        header8: hand[7],
        header9: hand[8],
        header10: hand[9],
        header11: username,
        header12: room.gs.winningBid,
        header13: biddingTeamTricks
    });
    writer.end();
}

function SaveGameData(room) {
    var writer = csvWriter({ sendHeaders: false }); //Instantiate var
    var csvFilename = "data/games.csv";

    // If CSV file does not exist, create it and add the headers
    if (!fs.existsSync(csvFilename)) {
        writer = csvWriter({ sendHeaders: false });
        writer.pipe(fs.createWriteStream(csvFilename));
        writer.write({
            header1: 'Date',
            header2: 'Username',
            header3: 'Won',
            header4: 'Margin',
            header5: 'HandStrength'
        });
        writer.end();
    }

    // Append some data to CSV the file    
    writer = csvWriter({ sendHeaders: false });
    writer.pipe(fs.createWriteStream(csvFilename, { flags: 'a' }));

    const today = new Date();
    const date = today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate();

    let winningTeam = 0;
    if (room.teams[1].score > room.teams[0].score)
        winningTeam = 1;
    let margin = winningTeam === 0 ? room.teams[0].score - room.teams[1].score : room.teams[1].score - room.teams[0].score;

    for (p of room.players) {
        if (p.role === 'player') {

            writer.write({
                header1: date,
                header2: p.username,
                header3: winningTeam === p.team ? 1 : 0,
                header4: winningTeam === p.team ? margin : -margin,
                header5: p.handstrength
            });
            //writer.write('\n');
        }
    }
    writer.end();
}


//////////////////  B O T   S T U F F //////////////////////

function BotProcessMiddle(room, bot, middle, trumpSuit) {
    // you just received the middle.  Basic strategy:
    // 1) combine the middle with your hand.
    // 2) score the hand, minus one card, for every card in the hand
    // 3) remove the card representing the worst-scoring hand and repeat untill 10 cards left

    let hand = bot.hand.concatenate(middle);
    let discards = [];

    let worstHandStrength = 1000;
    let worstCardIndex = -1;
    while (hand.length > 10) {
        for (const i = 0; i < hand.length; i++) {
            let testHand = hand.copy();
            testHand.splice(i, 1);

            let strength = GetHandStrength(testHand, trumpSuit);
            if (strength < worstHandStrength) {
                worstHandStrength = strength;
                worstCardIndex = i;
            }
        }
        discards.push(hand[worstCardIndex]);
        hand.splice(worstCardIndex, 1);
    }
    bot.hand = hand.copy();

    MiddleComplete(room);
    StartRound(room);
    return;
}

function BotHandleNelloRequest(room, bot, middle) {

}

function BotHandleBidRequest(room, bot, currentBid, highBidderTeam) {
    //console.log('Bid request made to bot ' + bot.username);
    let topBid = GetSuggestedBid(bot.hand);

    // has my partner bid yet?  Add 1.0 to that suit's bidRank
    // TODO:

    // get top ranking suit
    let topBidRank = parseInt(topBid[0]);
    //let topBid = '';
    //for (const [trumpSuit, bidRank] of Object.entries(myBids)) {
    //    if (bidRank > topBidRank) {
    //        topBidRank = bidRank;
    //        topRank = Math.round(topBidRank);
    //        topBid = topRank.toString() + trumpSuit;
    //    }
    //}
    if (topBidRank < 6) {
        console.log('Bot ' + bot.username + ' is passing');
        PlaceBid(room, 'pass', 'pass');
    }
    else if (CompareBids(topBid, currentBid) > 0) {
        topBidText = GetBidText(topBid);
        console.log('Bot ' + bot.username + ' is placing bid ' + topBid);
        PlaceBid(room, topBid, topBidText);
    }
    else { // prior bid
        console.log('Bot ' + bot.username + ' is passing');
        PlaceBid(room, 'pass', 'pass');
    }
}

function BotReceiveNelloCard(room, bot, card) {

}

function BotPlayCard(room, bot) {
    // look are current hand:
    // 1) Do I have to follow suit?

    // do I have the lead?  Then play in order
    if (room.gs.currentRound === 0) {
        // lead high trump if possible.
        let highCard = '';
        let highRank = 0;
        for (card of hand) {
            if (IsTrump(card, room.gs.trumpSuit)) {
                //
                [rank, suit] = GetRankAndSuit(card, room.gs.trumpSuit);
                if (rank > highRank) {
                    highCard = card;
                    highRank = rank;
                }
            }
        }
        if (highRank > 0) {
            // found a high trump, play it
        }

        io.to(room.roomID).emit('first card played', highCard, bot.team, bot.player, bot.username, room.gs.winningBid);  // send back to all clients
        CardPlayed(room, card);
    }

    // what's been played so far?
    // const leadSuit = room.gs.firstCardPlayed[1];  // e.g. 'S'

    // do have have the 


    //CardPlayed(room, card)
}

function GetSuggestedBid(hand) {
    // estimate an optimal bid for this hand.  Place it if higher than current bid; otherwise, pass
    let tricks = { 'S': 0, 'C': 0, 'D': 0, 'H': 0, 'T': 0, 'N': 0 };
    const _suits = ['S', 'C', 'D', 'H'];


    // we are going to evaluate the hands as if each suit were trump
    // and record how the had does for that suit as trump
    for (const trumpSuit of ['S', 'N', 'C', 'D', 'H', 'T']) { //'T'=NoTrump, 'N' = nello
        // evaluate the hand based on a given trump suite
        let counts = { 'S': 0, 'C': 0, 'D': 0, 'H': 0, 'JJ': 0, 'Jr': 0, 'Jb': 0, 'LB': 0, 'RB': 0, 'AT': 0, 'KT': 0, 'QT': 0, 'A': 0, 'HighTrump': 0, 'NS': 0, 'NC': 0, 'ND': 0, 'NH': 0 };

        _trumpSuit = trumpSuit;
        if (trumpSuit === 'T' || trumpSuit === 'N')
            _trumpSuit = '';

        // count the number and score of each suite in this hand (for the assume trump suit)
        for (card of hand) {
            let rank = 0;
            let suit = 0;
            [rank, suit] = GetRankAndSuit(card, _trumpSuit);   // card play
            //console.log("Suggested bid: trump: " + trumpSuit + ", suit: " + suit);
            //console.log("Suggested rank type: " + typeof rank + ", suit: " + typeof suit);

            counts[suit] += 1;

            // populate nello slots
            if (trumpSuit === 'N') {
                if (suit === 'S' || suit === 'C' || suit === 'D' || suit === 'H') {
                    if (rank === 4)
                        counts['N' + suit] += 1.5;
                    else if (rank === 5)
                        counts['N' + suit] += 1.1;
                    else if (rank === 6)
                        counts['N' + suit] += 0.85;
                    else if (rank === 7)
                        counts['N' + suit] += 0.6;
                    else if (rank === 8)
                        counts['N' + suit] += 0.4;
                    else if (rank === 9)
                        counts['N' + suit] += 0.2;
                }
            }

            // check individual cards
            if (rank === 12 && suit === trumpSuit) { // Trump queen
                counts['HighTrump'] += 1;
                counts['QT'] = 1;
            }

            if (rank === 13 && suit === trumpSuit) { // Trump King
                counts['HighTrump'] += 1;
                counts['KT'] = 1;
            }

            if (rank === 14) {   // Ace
                if (suit === trumpSuit) {
                    counts['HighTrump'] += 1;
                    counts['AT'] = 1;
                }
                else    // non-trump Ace
                    counts['A'] += 1;
            }

            if (rank === 15) { // left bower
                counts['LB'] = 1;
                counts['HighTrump'] += 1;
            }

            if (rank === 16) { // right bower
                counts['RB'] = 1;
                counts['HighTrump'] += 1;
            }

            if (rank === 17 || rank === 18) { // joker
                if (card === 'Jr')
                    counts['Jr'] = 1;
                else if (card === 'Jb')
                    counts['Jb'] = 1;
                else
                    counts['JJ'] = 1;

                counts['HighTrump'] += 1;
            }
        }   // end of hand

        let bidRank = 0;
        // so, we have hand stats for this trump suit, get estimated tricks
        if (trumpSuit === 'N') {       // trumpSuit == nello
            // low in at least two suites?
            bidRank = 0;
            for (const _suit of _suits) {
                // more than 3 low cards?
                //if (counts['N' + _suit] > 2.5)
                //    bidRank += 1;
                //
                //if (counts['N' + _suit] > 3.5)
                //    bidRank += 0.5;
                bidRank += counts['N' + _suit];

                // out of suites?
                if (counts[_suit] === 0)
                    bidRank += 1;

                else if (counts[_suit] === 1)  // easy to get out of this suit?
                    bidRank += 0.75;
            }
            tricks[trumpSuit] = bidRank;
        }  // end of trumpSuit = 'N'

        else if (trumpSuit === 'T') {   // no trump
            bidRank = 2;
            // count trump
            // Joker? +1
            if (counts['JJ'] > 0)
                bidRank += 1.1;

            if (counts['Jb'] > 0)
                bidRank += 0.9;
            
            if (counts['Jr'] > 0)
                bidRank += 1.1;

            // Additional tricks for aces, + kings, +queens
            for (var _suit of ['S', 'C', 'D', 'H']) {
                if (hand.includes('A' + _suit)) {
                    bidRank += 1.0;
                    if (hand.includes('K' + _suit)) {
                        bidRank += 0.95;
                        if (hand.includes('Q' + _suit))
                            bidRank += 0.90;
                    }
                }
                else if (hand.includes('K' + _suit) && counts[_suit] > 1)
                    bidRank += 0.85;
            }
            // out of suit +1
            for (const _suit of _suits) {
                if (counts[_suit] === 0)
                    bidRank += 1.1;
            }
            // no trump and JJ counts extra if you have a long run
            if (counts['JJ'] > 0 && (counts['S'] > 3 || counts['C'] > 3 || counts['D'] > 3 || counts['H'] > 3))
                bidRank += 1;

            tricks[trumpSuit] = bidRank;
        }

        else {   // not nello, not notrump
            bidRank = 2;
            // count trump
            // Joker? +1
            if (counts['JJ'] > 0)
                bidRank += 1.1;

            if (counts['Jb'] > 0)
                bidRank += 1.1;

            if (counts['Jr'] > 0)
                bidRank += 1.1;

            if (counts['RB'] > 0)  // right bower
                bidRank += 1.0;

            if (counts['LB'] > 0)  // left bower
                bidRank += 0.9;

            if (counts['AT'] > 0)  // Ace of Trump
                bidRank += 0.75;

            if (counts['KT'] > 0)  // King of trump
                bidRank += 0.5;

            if (counts['QT'] > 0)
                bidRank += 0.2;

            // Additional tricks for aces, + kings, +queens
            for (_suit of ['S', 'C', 'D', 'H']) {
                if (hand.includes('A' + _suit)) {
                    bidRank += (trumpSuit === 'T' ? 1.0 : 0.75);
                    if (hand.includes('K' + _suit)) {
                        bidRank += (trumpSuit === 'T' ? 0.95 : 0.5);
                        if (hand.includes('Q' + _suit))
                            bidRank += (trumpSuit === 'T' ? 0.90 : 0.05);
                    }
                }
            }

            // small amount for suit length
            bidRank += counts[trumpSuit] * 0.15;

            // more than 5 trumps +1
            // more than 6 trumps +2
            // more than 7 trumps +3
            if (counts[trumpSuit] > 5)
                bidRank += 0.95 * (counts[trumpSuit] - 5);

            // out of suit +1
            for (_suit of _suits) {
                if (counts[_suit] === 0)
                    bidRank += 0.9;
            }

            // lots of high trumpcards?
            if (counts['HighTrump'] >= 4)
                bidRank += 1;

            // no trump and JJ counts extra
            if (trumpSuit === 'T' && counts['JJ'] > 0 && (
                counts['S'] > 4 || counts['C'] > 4 || counts['D'] > 4 || counts['H'] > 4))
                bidRank += 1;

            if (bidRank > 10)
                bidRank = 10;

            if (bidRank === 10 && counts['JJ'] === 0)
                bidRank = 9;

            tricks[trumpSuit] = bidRank;
        }
    }
    let topBidRank = 0;
    let topBid = '';
    for (const [trumpSuit, bidRank] of Object.entries(tricks)) {
        //console.log('  examining bid [' + bidRank.toString() + trumpSuit + '] to ' + p.username);
        if (bidRank >= topBidRank) {
            topBidRank = bidRank;
            topRank = Math.round(topBidRank);
            topBid = topRank.toString() + trumpSuit;
        }
    }
    return topBid; //tricks;
}


// compare to bids for the purpose of sorting
function CompareBids(ca, cb) {
    // same bids are equal
    if (ca === '' && cb === '')
        return 0;
    if (ca === cb)
        return 0;
    if (ca === '')
        return -1;
    if (cb === '')
        return 1;

    console.log("ca: " + ca.toString() + ', type=' + typeof ca[0]);

    // get rank
    let ra = ca[0];
    let rb = cb[0];
    switch (ra) {
        case 'T': ra = 10; break;  // ten
        case 'N': ra = -1; break;
        default: ra = parseInt(ra);
    }
    switch (rb) {
        case 'T': rb = 10; break;
        case 'N': rb = -1; break;
        default: rb = parseInt(rb);
    }

    let sa = ca.slice(-1);
    let sb = cb.slice(-1);

    // special case - nello, it's between 7S and 7C/8S and 8C/9S and 9C
    if (ra === -1) {
        if (sa === 'l') {  // regular nello
            if ((rb === 7 && sb !== 'S') || rb > 7)
                return -1;  // nello bid is above comparator
            else
                return 1;
        } else if (sa === 'o') {  // open face nello
            if ((rb === 8 && sb !== 'S') || rb > 8)
                return -1;
            else
                return 1;
        } else if (sa === 'd') {  // double nello
            if ((rb === 9 && sb !== 'S') || rb > 9)
                return -1;
            else
                return 1;
        } else {
            console.error('CompareBids() failed - a=' + ra + sa + ', b=' + rb + sb);
        }
    }
    if (rb === -1) {
        if (sb === 'l') {
            if ((ra === 7 && sa !== 'S') || ra > 7)
                return 1;
            else
                return -1;
        } else if (sb === 'o') {
            if ((ra === 8 && sb !== 'S') || ra > 8)
                return 1;
            else
                return -1;
        } else if (sb === 'd') {
            if ((ra === 9 && sa !== 'S') || ra > 9)
                return 1;
            else
                return -1;
        } else {
            console.error('CompareBids() failed - a=' + ra + sa + ', b=' + rb + sb);
        }
    }

    // if these not the same rank, return the delta
    if (ra !== rb)
        return (ra - rb);

    // same rank, check suit

    switch (sa) {
        case 'S': ra = 0; break;
        case 'C': ra = 1; break;
        case 'D': ra = 2; break;
        case 'H': ra = 3; break;
        case 'N': ra = 4; break;
    }

    switch (sb) {
        case 'S': rb = 0; break;
        case 'C': rb = 1; break;
        case 'D': rb = 2; break;
        case 'H': rb = 3; break;
        case 'N': rb = 4; break;
    }
    return (ra - rb);
}

function GetBidText(bid) {
    switch (bid) {
        case 'Nl': return 'Nello';
        case 'No': return 'Open Face Nello';
        case 'Nd': return 'Double Nello';
    }

    let bidText = '';
    switch (bid[0]) {
        case '4': bidText = 'Four '; break;
        case '5': bidText = 'Five '; break;
        case '6': bidText = 'Six '; break;
        case '7': bidText = 'Seven '; break;
        case '8': bidText = 'Eight '; break;
        case '9': bidText = 'Nine '; break;
        case 'T': bidText = 'Ten '; break;
    }

    switch (bid[1]) {
        case 'S': bidText += 'of Spades'; break;
        case 'C': bidText += 'of Clubs'; break;
        case 'D': bidText += 'of Diamonds'; break;
        case 'H': bidText += 'of Hearts'; break;
        case 'N': bidText += ' No Trump'; break;
    }

    return bidText;
}

function GetBotName(room) {
    const botNames = ['', 'Botty McBotface', 'Madam Curie', 'Albert Einstein', 'Capt. Picard', 'Slick', 'George Orwell', 'Kamala', 'Dr.Biden', 'V.Putin'];
    let botCount = room.botCount;
    if (botCount > botNames.length)
        botCount = botNames.length - 1;

    return botNames[botCount];
}

function GetRandomBotName() {
    const names = ['Botty McBotface', 'Albert Einstein', 'Capt. Picard', 'Slick Willy', 'George Orwell', 'Kamala',
        'Dr. Biden', 'V.Putin', 'Dr. Fauci', 'Jacinda Ardern', 'Benoit Mandlebrot', 'The Ghost of RGB', 'Angela Merkel', 'Greta Thunberg'];
    return names[Math.floor(Math.random() * names.length)];
}


function LogHand(msg, hand) {
    for (card of hand) {
        msg += " " + card;
    }
    console.log(msg);
}


