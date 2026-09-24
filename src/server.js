require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const tmi = require("tmi.js");

const PORT = Number(process.env.PORT || 8090);
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 60);
const REVEAL_INTERVAL_SECONDS = Number(
  process.env.REVEAL_INTERVAL_SECONDS || 5
);

const RECENT_SONG_LIMIT = 50;

const DATA_DIR = path.join(__dirname, "..", "data");
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const STREAKS_FILE = path.join(DATA_DIR, "streaks.json");

function loadSongs() {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((file) => /^songs.*\.json$/i.test(file))
    .sort();

  const loadedSongs = [];
  const seenTitles = new Set();

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);

    try {
      const data = JSON.parse(
        fs.readFileSync(filePath, "utf8")
      );

      if (!Array.isArray(data)) {
        console.warn(
          `Skipping ${file}: expected an array.`
        );
        continue;
      }

      for (const song of data) {
        if (!song || !song.title) {
          continue;
        }

        const normalizedTitle = String(song.title)
          .trim()
          .toLowerCase();

        if (seenTitles.has(normalizedTitle)) {
          continue;
        }

        seenTitles.add(normalizedTitle);
        loadedSongs.push(song);
      }
    } catch (error) {
      console.error(
        `Failed to load ${file}:`,
        error.message
      );
    }
  }

  return loadedSongs;
}

function ensureDataFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      JSON.stringify(defaultValue, null, 2),
      "utf8"
    );
  }
}

ensureDataFile(SCORES_FILE, {});
ensureDataFile(STREAKS_FILE, {});

const songs = loadSongs();

const scores = JSON.parse(
  fs.readFileSync(SCORES_FILE, "utf8")
);

const streaks = JSON.parse(
  fs.readFileSync(STREAKS_FILE, "utf8")
);

function saveScores() {
  fs.writeFileSync(
    SCORES_FILE,
    JSON.stringify(scores, null, 2),
    "utf8"
  );
}

function saveStreaks() {
  fs.writeFileSync(
    STREAKS_FILE,
    JSON.stringify(streaks, null, 2),
    "utf8"
  );
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function normalizeSongTitle(title) {
  return String(title || "")
    .trim()
    .toLowerCase();
}

function getPlayerStreak(username) {
  const key = normalizeUsername(username);

  if (!streaks[key]) {
    streaks[key] = {
      current: 0,
      best: 0
    };
  }

  return streaks[key];
}

function addStreak(username) {
  const player = getPlayerStreak(username);

  player.current += 1;

  if (player.current > player.best) {
    player.best = player.current;
  }

  saveStreaks();

  return player;
}

function resetStreak(username) {
  const player = getPlayerStreak(username);

  player.current = 0;

  saveStreaks();

  return player;
}

function getScoresSorted() {
  return Object.entries(scores)
    .map(([username, score]) => ({
      username,
      score: Number(score) || 0,
      streak: getPlayerStreak(username).current,
      bestStreak: getPlayerStreak(username).best
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return b.bestStreak - a.bestStreak;
    });
}

class TuneQuest {
  constructor() {
    this.current = null;
    this.roundNumber = 0;
    this.lastSongTitle = null;

    this.recentSongs = [];

    this.clients = new Set();

    this.app = express();
    this.server = http.createServer(this.app);

    this.wss = new WebSocket.Server({
      server: this.server
    });

    this.app.get("/", (req, res) => {
      res.sendFile(
        path.join(__dirname, "..", "overlay", "index.html")
      );
    });

    this.app.get("/api/state", (req, res) => {
      res.json(this.getPublicState());
    });

    this.app.get("/health", (req, res) => {
      res.json({
        ok: true,
        game: "TuneQuest",
        build: "0.0.14",
        roundActive: Boolean(this.current),
        roundNumber: this.roundNumber,
        songCount: songs.length,
        recentSongCount: this.recentSongs.length,
        recentSongLimit: RECENT_SONG_LIMIT
      });
    });

    this.wss.on("connection", (socket) => {
      this.clients.add(socket);

      socket.send(
        JSON.stringify({
          type: "state",
          state: this.getPublicState()
        })
      );

      socket.on("close", () => {
        this.clients.delete(socket);
      });
    });

    this.revealTimer = null;
    this.roundTimer = null;
  }

  broadcast(message) {
    const payload = JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  getRemainingSeconds() {
    if (!this.current) {
      return 0;
    }

    const elapsed =
      (Date.now() - this.current.startedAt) / 1000;

    return Math.max(
      0,
      Math.ceil(this.current.durationSeconds - elapsed)
    );
  }

  getMaskedText(text, revealedLetters) {
    return [...String(text || "")]
      .map((character) => {
        if (!/[a-z]/i.test(character)) {
          return character;
        }

        const normalized = character.toLowerCase();

        if (revealedLetters.has(normalized)) {
          return character;
        }

        return "_";
      })
      .join("");
  }

  getMaskedTitle() {
    if (!this.current) {
      return "";
    }

    return this.getMaskedText(
      this.current.song.title,
      this.current.revealedTitleLetters
    );
  }

  getMaskedArtist() {
    if (!this.current) {
      return "";
    }

    return this.getMaskedText(
      this.current.song.artist || "",
      this.current.revealedArtistLetters
    );
  }

  getPublicState() {
    if (!this.current) {
      return {
        active: false,
        roundNumber: this.roundNumber,
        difficulty: null,
        maskedTitle: "",
        maskedArtist: "",
        year: null,
        revealedCount: 0,
        totalLetters: 0,
        artistRevealedCount: 0,
        artistTotalLetters: 0,
        maxPoints: 0,
        remainingSeconds: 0,
        songTitle: null
      };
    }

    return {
      active: true,
      roundNumber: this.roundNumber,
      difficulty: this.current.difficulty,
      maskedTitle: this.getMaskedTitle(),
      maskedArtist: this.getMaskedArtist(),
      year: this.current.song.year || null,
      revealedCount:
        this.current.revealedTitleLetters.size,
      totalLetters:
        this.current.uniqueTitleLetters.length,
      artistRevealedCount:
        this.current.revealedArtistLetters.size,
      artistTotalLetters:
        this.current.uniqueArtistLetters.length,
      maxPoints: this.calculatePoints(),
      remainingSeconds: this.getRemainingSeconds(),
      songTitle: null
    };
  }

  getUniqueLetters(text) {
    const letters = [];

    for (const character of String(text || "").toLowerCase()) {
      if (!/[a-z]/.test(character)) {
        continue;
      }

      if (!letters.includes(character)) {
        letters.push(character);
      }
    }

    return letters;
  }

  getDifficultySongs(difficulty) {
    return songs.filter(
      (song) =>
        String(song.difficulty || "").toLowerCase() ===
        difficulty.toLowerCase()
    );
  }

  chooseSong(difficulty) {
    const available =
      this.getDifficultySongs(difficulty);

    if (available.length === 0) {
      return null;
    }

    const recentTitles =
      new Set(
        this.recentSongs.map(
          (title) => normalizeSongTitle(title)
        )
      );

    let candidates =
      available.filter(
        (song) =>
          !recentTitles.has(
            normalizeSongTitle(song.title)
          )
      );

    /*
     * If the entire difficulty pool is inside the
     * 50-round protection window, allow reuse rather
     * than preventing a new round from starting.
     */
    if (candidates.length === 0) {
      candidates = available;
    }

    /*
     * Avoid immediately repeating the previous song
     * whenever another option exists.
     */
    const nonImmediateRepeat =
      candidates.filter(
        (song) =>
          normalizeSongTitle(song.title) !==
          normalizeSongTitle(this.lastSongTitle)
      );

    if (nonImmediateRepeat.length > 0) {
      candidates = nonImmediateRepeat;
    }

    const index = Math.floor(
      Math.random() * candidates.length
    );

    return candidates[index];
  }

  rememberSong(song) {
    const normalizedTitle =
      normalizeSongTitle(song.title);

    this.recentSongs =
      this.recentSongs.filter(
        (title) =>
          normalizeSongTitle(title) !==
          normalizedTitle
      );

    this.recentSongs.push(song.title);

    if (
      this.recentSongs.length >
      RECENT_SONG_LIMIT
    ) {
      this.recentSongs =
        this.recentSongs.slice(
          -RECENT_SONG_LIMIT
        );
    }
  }

  startRound(difficulty = null) {
    if (this.current) {
      return {
        ok: false,
        message:
          "A TuneQuest round is already active."
      };
    }

    const difficulties = [
      "easy",
      "medium",
      "hard"
    ];

    let selectedDifficulty = difficulty;

    if (!selectedDifficulty) {
      selectedDifficulty =
        difficulties[
          Math.floor(
            Math.random() *
            difficulties.length
          )
        ];
    }

    selectedDifficulty =
      selectedDifficulty.toLowerCase();

    if (
      !difficulties.includes(
        selectedDifficulty
      )
    ) {
      return {
        ok: false,
        message:
          "Difficulty must be easy, medium, or hard."
      };
    }

    const song =
      this.chooseSong(
        selectedDifficulty
      );

    if (!song) {
      return {
        ok: false,
        message:
          `No ${selectedDifficulty} songs are available.`
      };
    }

    const uniqueTitleLetters =
      this.getUniqueLetters(
        song.title
      );

    const uniqueArtistLetters =
      this.getUniqueLetters(
        song.artist || ""
      );

    this.roundNumber += 1;
    this.lastSongTitle = song.title;

    this.rememberSong(song);

    this.current = {
      song,
      difficulty: selectedDifficulty,
      startedAt: Date.now(),
      durationSeconds: ROUND_SECONDS,

      uniqueTitleLetters,
      uniqueArtistLetters,

      titleRevealQueue:
        [...uniqueTitleLetters].sort(
          () => Math.random() - 0.5
        ),

      artistRevealQueue:
        [...uniqueArtistLetters].sort(
          () => Math.random() - 0.5
        ),

      revealedTitleLetters:
        new Set(),

      revealedArtistLetters:
        new Set()
    };

    this.broadcast({
      type: "round_started",
      state: this.getPublicState()
    });

    this.startTimers();

    return {
      ok: true,
      roundNumber: this.roundNumber,
      difficulty: selectedDifficulty,
      songTitle: song.title
    };
  }

  startTimers() {
    this.clearTimers();

    this.revealTimer =
      setInterval(() => {
        this.revealNextLetter();
      }, REVEAL_INTERVAL_SECONDS * 1000);

    this.roundTimer =
      setTimeout(() => {
        if (this.current) {
          this.endRound("timeout");
        }
      }, ROUND_SECONDS * 1000);
  }

  clearTimers() {
    if (this.revealTimer) {
      clearInterval(
        this.revealTimer
      );

      this.revealTimer = null;
    }

    if (this.roundTimer) {
      clearTimeout(
        this.roundTimer
      );

      this.roundTimer = null;
    }
  }

  broadcastTimer() {
    this.broadcast({
      type: "timer",
      remainingSeconds:
        this.getRemainingSeconds()
    });
  }

  revealNextLetter() {
    if (!this.current) {
      return;
    }

    let titleLetter = null;
    let artistLetter = null;

    if (
      this.current.titleRevealQueue.length > 0
    ) {
      titleLetter =
        this.current.titleRevealQueue.shift();

      this.current.revealedTitleLetters.add(
        titleLetter
      );
    }

    if (
      this.current.artistRevealQueue.length > 0
    ) {
      artistLetter =
        this.current.artistRevealQueue.shift();

      this.current.revealedArtistLetters.add(
        artistLetter
      );
    }

    const revealedCount =
      this.current.revealedTitleLetters.size;

    const totalLetters =
      this.current.uniqueTitleLetters.length;

    const artistRevealedCount =
      this.current.revealedArtistLetters.size;

    const artistTotalLetters =
      this.current.uniqueArtistLetters.length;

    this.broadcast({
      type: "letter_revealed",

      letter: titleLetter,
      artistLetter,

      maskedTitle:
        this.getMaskedTitle(),

      maskedArtist:
        this.getMaskedArtist(),

      revealedCount,
      totalLetters,

      artistRevealedCount,
      artistTotalLetters,

      maxPoints:
        this.calculatePoints(),

      remainingSeconds:
        this.getRemainingSeconds()
    });

    if (
      revealedCount >= totalLetters
    ) {
      this.endRound(
        "all_letters_revealed"
      );
    }
  }

  calculatePoints() {
    if (!this.current) {
      return 0;
    }

    const revealed =
      this.current.revealedTitleLetters.size;

    const difficulty =
      this.current.difficulty.toLowerCase();

    let startingPoints;
    let penaltyPerReveal;

    if (difficulty === "easy") {
      startingPoints = 60;
      penaltyPerReveal = 15;
    } else if (difficulty === "hard") {
      startingPoints = 90;
      penaltyPerReveal = 5;
    } else {
      startingPoints = 75;
      penaltyPerReveal = 10;
    }

    return Math.max(
      10,
      startingPoints -
        revealed * penaltyPerReveal
    );
  }

  findMatchingSongGuess(guess) {
    if (!this.current) {
      return null;
    }

    const normalizedGuess =
      String(guess || "")
        .trim()
        .toLowerCase();

    if (!normalizedGuess) {
      return null;
    }

    const normalizedTitle =
      this.current.song.title
        .trim()
        .toLowerCase();

    if (
      normalizedGuess ===
      normalizedTitle
    ) {
      return this.current.song;
    }

    return null;
  }

  handleGuess(username, guess) {
    if (!this.current) {
      return {
        ok: false,
        message:
          "There is no active TuneQuest round."
      };
    }

    const player =
      normalizeUsername(username);

    if (!player) {
      return {
        ok: false,
        message:
          "Invalid username."
      };
    }

    const song =
      this.findMatchingSongGuess(
        guess
      );

    if (!song) {
      const streak =
        resetStreak(player);

      this.broadcast({
        type: "incorrect_guess",
        username: player,
        streak: streak.current
      });

      return {
        ok: false,
        correct: false,
        message:
          `${player} guessed incorrectly.`,
        streak: streak.current,
        bestStreak: streak.best
      };
    }

    const points =
      this.calculatePoints();

    if (!scores[player]) {
      scores[player] = 0;
    }

    scores[player] += points;

    const streak =
      addStreak(player);

    saveScores();

    this.endRound(
      "correct_guess",
      {
        username: player,
        points,
        streak: streak.current,
        bestStreak: streak.best
      }
    );

    return {
      ok: true,
      correct: true,
      username: player,
      songTitle: song.title,
      points,
      totalScore: scores[player],
      streak: streak.current,
      bestStreak: streak.best
    };
  }

  endRound(reason, winner = null) {
    if (!this.current) {
      return;
    }

    this.clearTimers();

    const endedSong =
      this.current.song;

    const finalState =
      this.getPublicState();

    this.current = null;

    this.broadcast({
      type: "round_ended",
      reason,
      winner,

      songTitle:
        endedSong.title,

      artist:
        endedSong.artist || "",

      year:
        endedSong.year || null,

      answer:
        endedSong.title,

      state: {
        ...finalState,

        active: false,

        maxPoints: 0,

        maskedTitle:
          endedSong.title,

        maskedArtist:
          endedSong.artist || "",

        year:
          endedSong.year || null
      }
    });
  }

  skipRound() {
    if (!this.current) {
      return {
        ok: false,
        message:
          "There is no active TuneQuest round."
      };
    }

    const title =
      this.current.song.title;

    this.endRound("skipped");

    return {
      ok: true,
      songTitle: title
    };
  }

  getPlayerScore(username) {
    const player =
      normalizeUsername(username);

    return Number(
      scores[player] || 0
    );
  }

  getPlayerStats(username) {
    const player =
      normalizeUsername(username);

    const streak =
      getPlayerStreak(player);

    return {
      username: player,
      score:
        this.getPlayerScore(player),
      streak:
        streak.current,
      bestStreak:
        streak.best
    };
  }

  getLeaderboard() {
    return getScoresSorted();
  }

  startServer() {
    this.server.listen(
      PORT,
      () => {
        console.log(
          `TuneQuest Build 0.0.14 running on port ${PORT}`
        );

        console.log(
          `Song pool ready: ${songs.length} unique songs.`
        );

        console.log(
          `Round length: ${ROUND_SECONDS}s`
        );

        console.log(
          `Letter reveal interval: ${REVEAL_INTERVAL_SECONDS}s`
        );

        console.log(
          "Scoring: Easy 60/-15 | Medium 75/-10 | Hard 90/-5"
        );

        console.log(
          `Song repeat protection: ${RECENT_SONG_LIMIT} rounds`
        );
      }
    );
  }
}

const game =
  new TuneQuest();

const twitchClient =
  new tmi.Client({
    options: {
      debug: true
    },

    identity: {
      username:
        process.env.TWITCH_USERNAME,

      password:
        process.env.TWITCH_OAUTH_TOKEN
    },

    channels: [
      process.env.TWITCH_CHANNEL ||
        "frohner1"
    ]
  });

twitchClient.connect()
  .then(() => {
    console.log(
      `Connected to Twitch channel #${
        process.env.TWITCH_CHANNEL ||
        "frohner1"
      }`
    );
  });

twitchClient.on(
  "message",
  (
    channel,
    tags,
    message,
    self
  ) => {
    if (self) {
      return;
    }

    const username =
      normalizeUsername(
        tags.username
      );

    const trimmed =
      message.trim();

    if (
      !trimmed.startsWith("!")
    ) {
      return;
    }

    const parts =
      trimmed.split(/\s+/);

    const command =
      parts[0].toLowerCase();

    if (command === "!tune") {
      const difficulty =
        parts[1]
          ? parts[1].toLowerCase()
          : null;

      const result =
        game.startRound(
          difficulty
        );

      if (!result.ok) {
        twitchClient.say(
          channel,
          result.message
        );

        return;
      }

      twitchClient.say(
        channel,
        `TuneQuest round #${result.roundNumber} started — ${result.difficulty.toUpperCase()} difficulty!`
      );

      return;
    }

    if (command === "!guess") {
      const guess =
        parts
          .slice(1)
          .join(" ");

      if (!guess) {
        twitchClient.say(
          channel,
          `${username}, use !guess <song title>.`
        );

        return;
      }

      const result =
        game.handleGuess(
          username,
          guess
        );

      if (result.ok) {
        let messageText =
          `${username} guessed "${result.songTitle}" and earned ` +
          `${result.points} points!`;

        if (
          result.streak >= 2
        ) {
          messageText +=
            ` 🔥 ${result.streak}-song streak!`;
        } else if (
          result.streak === 1
        ) {
          messageText +=
            " 🔥 1-song streak!";
        }

        if (
          result.bestStreak > 1 &&
          result.streak ===
            result.bestStreak
        ) {
          messageText +=
            ` Personal best streak: ${result.bestStreak}!`;
        }

        twitchClient.say(
          channel,
          messageText
        );

        return;
      }

      twitchClient.say(
        channel,
        result.message
      );

      return;
    }

    if (command === "!score") {
      const stats =
        game.getPlayerStats(
          username
        );

      twitchClient.say(
        channel,
        `${username}, your TuneQuest score is ${stats.score} points. ` +
        `Current streak: ${stats.streak}. ` +
        `Best streak: ${stats.bestStreak}.`
      );

      return;
    }

    if (command === "!scores") {
      const leaderboard =
        game.getLeaderboard();

      if (
        leaderboard.length === 0
      ) {
        twitchClient.say(
          channel,
          "TuneQuest has no scores yet."
        );

        return;
      }

      const topPlayers =
        leaderboard
          .slice(0, 5)
          .map(
            (
              player,
              index
            ) =>
              `${index + 1}. ${player.username} ${player.score} pts`
          )
          .join(" | ");

      twitchClient.say(
        channel,
        `TuneQuest leaderboard: ${topPlayers}`
      );

      return;
    }

    if (command === "!skip") {
      const isBroadcaster =
        tags.badges &&
        tags.badges.broadcaster ===
          "1";

      const isMod =
        tags.mod === true ||
        (
          tags.badges &&
          tags.badges.moderator ===
            "1"
        );

      if (
        !isBroadcaster &&
        !isMod
      ) {
        return;
      }

      const result =
        game.skipRound();

      if (!result.ok) {
        twitchClient.say(
          channel,
          result.message
        );

        return;
      }

      twitchClient.say(
        channel,
        `TuneQuest round skipped. The song was "${result.songTitle}".`
      );

      return;
    }

    if (
      command === "!tunehelp"
    ) {
      twitchClient.say(
        channel,
        "TuneQuest: !tune, !tune easy|medium|hard, !guess <song>, !score, !scores, !skip. Correct guesses build streaks!"
      );
    }
  }
);

setInterval(() => {
  if (game.current) {
    game.broadcastTimer();
  }
}, 1000);

game.startServer();