const express = require('express');
//const { emit } = require('process');
const { DefaultSerializer } = require('v8');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
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

class Room {
    roomID = 0;
    teams = [{ team: 'A', tricks: 0, score: 0 }, { team: 'B', tricks: 0, score: 0 }];
    players = [];   // {'username': username, role='player|observer' team': '0', 'player': 0, hand: [], startingHand: [], handstrength: 0, 'room': room, socketID': socketID}
    deck = [
        'AS', 'KS', 'QS', 'JS', 'TS', '9S', '8S', '7S', '6S', '5S', '4S',
        'AC', 'KC', 'QC', 'JC', 'TC', '9C', '8C', '7C', '6C', '5C', '4C',
        'AD', 'KD', 'QD', 'JD', 'TD', '9D', '8D', '7D', '6D', '5D', '4D',
        'AH', 'KH', 'QH', 'JH', 'TH', '9H', '8H', '7H', '6H', '5H', '4H',
        'JJ'];

    gameStarted = false;
    currentPlay = 0;
    currentRound = 0;
    currentHand = 0;
    currentBid = '0';
    currentBidText = 'no bid (yet)';
    currentTeam = 0;
    currentPlayer = 0;
    currentDealerTeam = 0;
    currentDealer = 0;
    bidCount = 0;
    winningBid = '0';
    winningBidderTeam = -1;
    winningBidder = -1;
    winningPlayTeam = -1;
    winningPlayPlayer = -1;
    trumpSuit = '';
    highCard = '';
    firstCardPlayed = '';
    nelloTeam = -1;
    nelloPlayer = -1;
    constructor(roomID) {
        this.roomID = roomID;
    }
}

let rooms = [];


GetRandomImage(0);

//let room = new Room(1);
//console.log(room.currentBidText);

//app.set('view engine', 'ejs')
app.use(express.static(__dirname + '/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
    //res.redirect('/${uuidV4()}');
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
        // remove player associated with this socket from players list
        let room = null;
        for (r of rooms) {
            for (p of r.players) {
                if (p.socketID === socket.id) {
                    room = r;
                    break;
                }
            }
            if (room !== null)
                break;
        }

        // did we find the room/socket?  If so, remove the player disconnecting
        if (room === null)
            return;

        let leaving = '';
        let team = 0;
        let player = 0;
        let role = '';
        // remove player from room's player list
        for (var i = 0; i < room.players.length; i++) {
            if (room.players[i].socketID === socket.id) {
                leaving = room.players[i].username;
                team = room.players[i].team;
                player = room.players[i].player;
                role = room.players[i].role;
                room.players.splice(i, 1);
                break;
            }
        }
        let remaining = [];
        for (p of room.players)
            if (p.role === 'player')
                remaining.push(p.username);

        socket.to(room.roomID).emit('user disconnected', team, player, leaving, role);
        console.log('player ' + leaving + ' disconnected.  Remaining players: ' + remaining.join());

        if (room.players.length === 0) {
            for (i = 0; i < rooms.length; i++) {
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

    // log the chat message (done)
    socket.on('chat message', (roomID, msg) => {
        io.to(roomID).emit('chat message', msg);
    });

    // joining a room 
    ///socket.on('join room', (roomID, userID) => {
    ///    console.log('joining room' + roomID + ' ' + userID);
    ///    socket.join(roomID);  // connect socket to room 
    ///    // tell everyone else in the room we connected
    ///    socket.to(roomID).broadcast.emit('user connected', userID);
    ///});

    // a new player has joined - send the current teams list (done)
    socket.on('new player', (roomID, playerInfo) => {
        // get next open player slot for this room
        let room = GetRoom(roomID);
        if (room === null) {
            console.log('Unable to find room ' + playerInfo.room);
            return;
        }

        // get count of current players in this room
        let playerCount = 0;
        for (const p of room.players) {
            if (p.role === 'player')
                playerCount++;
        }

        let team = -1;
        let player = -1;

        if (playerInfo.role === 'player') {
            if (playerCount > 4) {
                console.log('Error: player count exceeds 4!!!!');
                return;
            }

            let t0p0 = false;
            let t0p1 = false;
            let t1p0 = false;
            let t1p1 = false;
            for (const p of room.players) {
                if (p.role === 'player') {
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
                team = 0;
                player = 0;
            } else if (t0p1 === false) {
                team = 0;
                player = 1;
            } else if (t1p0 === false) {
                team = 1;
                player = 0;
            } else if (t1p1 === false) {
                team = 1;
                player = 1;
            }
            console.log('Player ' + playerInfo.username + ' has joined a game');
        }
        else
            console.log('Observer ' + playerInfo.username + ' has joined a game');

        socket.join(roomID);  // connect socket to room 

        room.players.push({
            username: playerInfo.username,
            role: playerInfo.role,
            team: team,  // 0,1
            player: player,
            startingHand: [],
            hand: [],
            handstrength: 0,
            room: roomID,
            socketID: socket.id
        });

        // player added === user-connected
        io.to(roomID).emit('player added', team, player, playerInfo.username, playerInfo.role, room.players);
        //io.to(roomID).emit('players', room.players);
        io.emit('update rooms');
    });

    socket.on('update team', (roomID, socketID, team, player) => {
        let room = GetRoom(roomID);
        if (room === null) {
            console.log('Unable to find room ' + playerInfo.room);
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

    // request to start a game (done)
    socket.on('start game', (roomID, restart) => {
        let room = GetRoom(roomID);

        if (restart)
            room.gameStarted = false;

        if (room.gameStarted)
            return;

        // to start a game, 
        // 1) reset round counter to 0 and team scores to 0
        // 2) run rounds until score of 500 achieved
        room.currentHand = 0;
        room.currentRound = 0;
        room.currentDealer = 0;
        room.currentDealerTeam = 0;
        room.winningBidderTeam = -1;
        room.winningBidder = -1;
        room.trumpSuit = '';
        room.teams[0].score = 0;
        room.teams[1].score = 0;
        io.to(roomID).emit('game started');
        room.gameStarted = true;
        console.log('starting game in room ' + roomID);

        for (p of room.players) {
            p.handStrength = 0;
        }

        StartHand(room);
    });

    // request to place bid (done)
    socket.on('place bid', (roomID, bid, bidText) => {
        let room = GetRoom(roomID);

        let pass = false;

        if (bid === 'pass') {
            pass = true;
        }
        else {  // e.g. '6C'
            room.currentBid = bid;
            room.currentBidText = bidText;
            room.currentBidText = bidText;
            room.winningBid = bid;
            room.winningBidderTeam = room.currentTeam;
            room.winningBidder = room.currentPlayer;
            room.trumpSuit = bid[1];
        }

        //console.log('Bid placed: ' + bidText + ' (' + bidText + '), current Winning Bid is ' + room.winningBid + ' (' + room.currentBidText + ')');
        room.bidCount++;

        // end of bidding?
        if (room.bidCount === 4) {
            room.bidCount = 0;
            io.to(roomID).emit('bidding complete', room.winningBid, room.currentBidText, room.winningBidderTeam, room.winningBidder);
            let socketID = GetSocketID(room, room.winningBidderTeam, room.winningBidder);
            room.winningPlayerName = GetUsername(room, room.winningBidderTeam, room.winningBidder);
            //console.log('Bidding completed.  Final Bid is ' + bidText + ', placed by ' + room.winningPlayerName);

            let middle = room.deck.slice(40);
            //console.log('Sending middle (' + middle.join() + ') to ' + room.winningPlayerName);

            // send updated hand for winning player (with middle)
            let i = 0;
            let hand = null;
            for (const p of room.players) {
                if (p.role === 'player') {
                    if (p.socketID === socketID) {
                        io.to(socketID).emit('sending middle', middle);

                        // send to any observers of this player as well
                        for (const obs of room.players) {
                            if (obs.role === 'observer' && obs.team === p.team && obs.player === p.player)
                                io.to(obs.socketID).emit('sending middle', middle);
                        }
                        break;
                    }
                    i += 10;
                }
            }
            io.to(room.roomID).emit('selecting middle', socketID, room.winningPlayerName, bid, bidText);
            room.currentTeam = room.winningBidderTeam;
            room.currentPlayer = room.winningBidder;
            return;
        }
        // move to next bidder
        [room.currentTeam, room.currentPlayer] = GetNextPlayer(room.currentTeam, room.currentPlayer);

        // get the socketID for the next bidder and request a new bid
        for (const p of room.players) {
            if (p.role === 'player' && p.team === room.currentTeam && p.player === room.currentPlayer) {
                room.winningPlayerName = GetUsername(room, room.winningBidderTeam, room.winningBidder);
                io.to(room.roomID).emit('request bid', p.socketID, room.currentBid, room.currentBidText, pass, p.username, room.winningBidderTeam, room.winningBidderPlayer, room.winningPlayerName);
                console.log('Bid requested from ' + p.username);
                break;
            }
        }
    });

    // indicates middle selection is complete (done)
    socket.on('middle complete', (roomID) => {
        let room = GetRoom(roomID);

        console.log('Middle selection complete, starting round');
        room.currentRound = 0;

        // send observers updated hand?
        //for (const obs of room.players) {
        //    if (obs.team === p.team && obs.player === p.player)
        //        io.to(obs.socketID).emit('new hand', hand);

        // note - currentTeam/Player already set to winningBidderTeam/Player        
        StartRound(room);
    });

    // indicates first card of a round has been played) (done)
    socket.on('first card played', (roomID, card) => {
        console.log('first card played: ' + card);
        io.to(roomID).emit('first card played', card);  // send back to all clients
    });

    // a card was played in this room
    socket.on('card played', (roomID, cardID) => {
        let room = GetRoom(roomID);

        // remove card from players hand
        for (const p of room.players) {
            let found = false;
            if (p.role === 'player' && p.team === room.currentTeam && p.player === room.currentPlayer) {
                found = true;
                for (let i=0; i < p.hand.length; i++) {
                    if (p.hand[i] === cardID) {
                        p.hand.splice(i, 1);
                        break;
                    }
                }
            }
            if (found === true)
                break;
        }

        if (room.currentPlay === 0) {
            room.firstCardPlayed = cardID;
            room.highCard = cardID;
            room.winningPlayTeam = room.currentTeam;
            room.winningPlayPlayer = room.currentPlayer;
        }
        else if (IsHighCard(cardID, room.highCard, room.firstCardPlayed[1], room.winningBid[1])) {
            room.highCard = cardID;
            room.winningPlayTeam = room.currentTeam;
            room.winningPlayPlayer = room.currentPlayer;
        }
        // transfer card to play area
        //for (const p of room.players) {
        //    if (p.role === 'player' && p.team === room.currentTeam && p.player === room.currentPlayer) {
                io.to(roomID).emit('transfer card', room.currentTeam, room.currentPlayer, cardID);
                //console.log(p.username + ' played card ' + cardID);
        //        break;
        //    }
        //}

        room.currentPlay++;  // indicate hand has been played

        if (room.currentPlay < 4) { // still playing this play? 
            [room.currentTeam, room.currentPlayer] = GetNextPlayer(room.currentTeam, room.currentPlayer);

            for (const p of room.players) {
                if (p.role === 'player' && p.team === room.currentTeam && p.player === room.currentPlayer) {
                    io.to(roomID).emit('play card', room.currentRound, p.socketID, p.username);
                    //console.log('Play ' + room.currentPlay + ' starting for ' + p.username);
                    break;
                }
            }
        }
        else {  // four cards played, move to next round
            RoundComplete(room);
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

                // find current record for this user (key = username, value=dictionary of stats)
                if (users[username]) {
                    let user = users[username];
                    user['Games']++;
                    if (row['Won'] === 1)
                        user['Games Won']++;
                    user['AHS'] += row['HandStrength'];
                }
                else {  // user not found, so add them
                    users[username] = {
                        'Games': 1,
                        'Games Won': row['Won'],
                        '% Won': 0,
                        'AHS': row['HandStrength']
                    };
                }

            })
            .on('end', () => {
                // at this point, the 'users' dictionary contains entries for each user
                // in the database.  Clean up are return
                for (let username in users) {
                    let user = users[username];
                    user['% Won'] = user['Games Won'] / user['Games'];
                    user['AHS'] = user['AHS'] / user['Games'];
                }
                fn(users);
            }); 
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

    //   rank:  6   7   8   9  10
    // spades: 40/140/240/340/440
    // clubs: 60/160/260...
    // diamonds: 80/180/280...
    // hearts: 100/200/300...
    // notrump: 120/220/320...

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

function GetSocketID(room, team, player) {
    for (const p of room.players) {
        if (p.team === team && p.player === player)
            return p.socketID;
    }
    return null;
}

function GetUsername(room, team, player) {
    for (const p of room.players) {
        if (p.role === 'player' && p.team === team && p.player === player)
            return p.username;
    }
}

function IsHighCard(cardID, highCardID, firstPlaySuit, trumpSuit) {
    // joker always wins
    if (cardID[1] === 'J')
        return true;

    if (highCardID === '')  // ????? first card  NEED TO RESET BEFORE EACH HAND
        return true;

    let cs, cr, hs, hr;
    [cr, cs] = GetRankAndSuit(cardID, trumpSuit);   // card play
    [hr, hs] = GetRankAndSuit(highCardID, trumpSuit);  // current high card

    // bid is no trump, only following suit and rank matters
    if (trumpSuit === 'N')
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
    io.to(room.roomID).emit('start hand', room.currentHand);
    console.log('starting hand' + room.currentHand);

    room.currentBid = '0';
    room.currentBidText = 'no bid (yet)';
    room.trumpSuit = '';
    room.teams[0].tricks = 0;
    room.teams[1].tricks = 0;

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
    }

    // deal cards
    let i = 0;
    for (const p of room.players) {
        if (p.role === 'player') {
            let hand = room.deck.slice(i, i + 10);
            p.startingHand = hand;
            p.hand = hand;

            io.to(p.socketID).emit('new hand', hand);
            //console.log('Dealing ' + hand.join() + ' to ' + p.username + '(trump=' + room.trumpSuit + ')');

            // send to any observers of this player as well
            for (const pp of room.players) {
                if (pp.role === 'observer' && pp.team === p.team && pp.player === p.player)
                    io.to(p.socketID).emit('new hand', hand);
            }

            let handStrength = GetHandStrength(hand);
            p.handstrength += handStrength;

            i += 10;
        }
    }

    // cards delt, start bidding
    io.to(room.roomID).emit('start bidding');
    room.currentBid = '';
    room.currentBidText = 'no bid (yet)';
    room.winningBidderTeam = 0;
    room.winningBidder = 0;
    // bidding starts with first player after dealer
    [room.currentTeam, room.currentPlayer] = GetNextPlayer(room.currentDealerTeam, room.currentDealer);

    // request a bid from the current team/player
    for (const p of room.players) {
        if (p.role === 'player' && p.team === room.currentTeam && p.player === room.currentPlayer) {
            io.to(room.roomID).emit('request bid', p.socketID, room.currentBid,
                room.currentBidText, true, p.username, -1, -1, null);

            console.log('Bidding started by ' + p.username);
            break;
        }
    }
}

// start a round of four cards to be played (done)
function StartRound(room) {
    // starts a new round (play four cards), currentTeam/currentPlayer start
    room.currentPlay = 0;
    room.highCard = '';

    io.to(room.roomID).emit('start round', room.currentRound);

    for (const p of room.players) {
        if (p.role ==='player' && p.team === room.currentTeam && p.player === room.currentPlayer) {
            io.to(room.roomID).emit('play card', room.currentRound, p.socketID, p.username);
            //console.log('Play starting for ' + p.username);
            break;
        }
    }
}

function RoundComplete(room) {
    //console.log('Completed Round ' + room.currentRound);

    // find winner of this round (high card played)
    room.teams[room.winningPlayTeam].tricks += 1;

    let winningUser = GetUsername(room, room.winningPlayTeam, room.winningPlayPlayer);
    io.to(room.roomID).emit('round complete', room.currentRound, winningUser, room.teams[0].tricks, room.teams[1].tricks);

    // update game state to start new round (of four plays)
    room.currentRound++;
    room.currentPlay = 0;

    // do we need to do more rounds
    if (room.currentRound < 10) {
        room.currentTeam = room.winningPlayTeam;
        room.currentPlayer = room.winningPlayPlayer;
        room.currentPlay = 0;

        StartRound(room);
    }
    else {
        HandComplete(room);
    }
}

// a hand has finished - check for game over, and start new hand if not 
function HandComplete(room) {
    // check to see if there is a winner.  If so, finish game; 
    // otherwise, do another round.

    // did the winning bidder make the bid?
    let biddingTeam = room.winningBidderTeam;
    let biddingTeamTricks = room.teams[biddingTeam].tricks;
    let biddingTeamPts = GetScoreFromBid(room.winningBid);
    let bidMade = false;
    let bidRank = room.currentBid[0];

    // did the bidder get enough tricks to make bid?
    if (biddingTeamTricks >= bidRank) {
        bidMade = true;
    }
    else {
        biddingTeamPts *= -1;
        bidMade = false;
    }
    room.teams[room.winningBidderTeam].score += biddingTeamPts;

    if (biddingTeam === 0)
        room.teams[1].score += 10 * room.teams[1].tricks;
    else
        room.teams[0].score += 10 * room.teams[0].tricks;

    const imgURL = GetRandomImage(0);
    console.log("imgURL= " + imgURL);
    io.to(room.roomID).emit('hand complete', room.currentHand, biddingTeam, bidMade,
        biddingTeamTricks, biddingTeamPts, room.teams[0].score, room.teams[1].score, imgURL);

    SaveHandData(room, biddingTeamTricks);

    let gameWinner = -1;
    if (room.teams[0].score >= 500 && room.teams[0].score > room.teams[1].score)
        gameWinner = 0;
    else if (room.teams[1].score >= 500 && room.teams[1].score > room.teams[0].score)
        gameWinner = 1;
    else if (room.teams[0].score >= 500 && (room.teams[0].score === room.teams[1].score))
        gameWinner = 2;  // tie!

    // end of game reached?
    if (gameWinner >= 0) {
        [teamA, teamB] = GetTeams(room);
        io.to(room.roomID).emit('game complete', gameWinner, room.teams[0].score, room.teams[1].score, teamA, teamB);
        GameComplete(room);
    }
    else {
        room.currentHand++;
        [room.currentDealerTeam, room.currentDealer] = GetNextPlayer(room.currentDealerTeam, room.currentDealer);
        StartHand(room);
    }
}


function GameComplete(room) {
    room.gameStarted = false;

    for (p of room.players) {
        if ( room.currentHand > 0)
            p.handStrength /= room.currentHand;  // average hand strength for game
    }
    SaveGameData(room);
}


function GetRandomImage(flag) {
    const directoryPath = path.join(__dirname, '/public/Animations');
    const files = fs.readdirSync(directoryPath);
    const file = files[Math.floor(Math.random() * files.length)];
    console.log('Getting random file: ' + file);
    return 'Animations/' + file;
}

// Fisher-Yates verion
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
    // joker?
    if (card === 'JJ')
        return [17, (trumpSuit === '') ? 'J' : trumpSuit];

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

    // joker?
    if (card[1] === 'J')
        return true;

    // jack and trump defined?
    if (card[0] === 'J') {
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
    return misdeal;
}

function GetHandStrength(hand) {
    // <= 10 count 0 pt
    // Q = 1pt
    // K = 2pts
    // A = 3pt
    // Jack = 4pts
    // Joker = 5pts
    // out of suite = 2 pts
    // 1 pt for count of suite > 4
    // 2 pt for count of suite > 5
    // 3 pts for count of suite > 6 etc

    let strength = 0;
    let spadeCount = 0;
    let clubCount = 0;
    let heartCount = 0;
    let diamondCount = 0;
    for (card of hand) {
        switch (card[0]) {
            case 'J': strength += card[1] === 'J' ? 5 : 2; break;
            case 'Q': strength += 1; break;
            case 'K': strength += 2; break;
            case 'A': strength += 3; break;

        }
        switch (card[1]) {
            case 'C': clubCount++; break;
            case 'S': spadeCount++; break;
            case 'D': diamondCount++; break;
            case 'H': heartCount++; break;
        }
    }
    if (clubCount > 4)
        strength += clubCount - 4;

    if (spadeCount > 4)
        strength += spadeCount - 4;

    if (diamondCount > 4)
        strength += diamondCount - 4;

    if (heartCount > 4)
        strength += heartCount - 4;

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
    let i = 0;
    for (const p of room.players) {
        if (p.role === 'player') {
            if (p.team === room.winningBidderTeam && p.player === room.winningBidder) {
                hand = p.startingHand;
                username = GetUsername(room, p.team, p.player);
                break;
            }
            else
                i += 10;
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
        header12: room.currentBid,
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
                header3: winningTeam === p.team ? 1: 0,
                header4: winningTeam === p.team ? margin : -margin,
                header5: p.handstrength
            });
        }
    }
    writer.end();
}
