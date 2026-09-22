require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const tmi = require("tmi.js");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OVERLAY_DIR = path.join(ROOT, "overlay");

const SONGS_FILE = path.join(DATA_DIR, "songs.json");
const SCORES_FILE = path.join(DATA_DIR, "scores.json");

const PORT = Number(process.env.PORT || 8090);
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 60);
const REVEAL_INTERVAL_SECONDS = Number(
  process.env.REVEAL_INTERVAL_SECONDS || 5
);

const CHANNEL = (
  process.env.TWITCH_CHANNEL ||
  "frohner1"
).replace(/^#/, "").toLowerCase();

const VALID_DIFFICULTIES = [
  "easy",
  "medium",
  "hard"
];

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch (error) {
    console.error(
      `Failed to load ${filePath}:`,
      error
    );

    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");
}

function normalizeLetter(value) {
  return String(value || "")
    .toLowerCase();
}

function isLetter(character) {
  return /^[a-z]$/i.test(character);
}

function shuffle(array) {
  const result = [...array];

  for (
    let index = result.length - 1;
    index > 0;
    index -= 1
  ) {
    const randomIndex = Math.floor(
      Math.random() * (index + 1)
    );

    [
      result[index],
      result[randomIndex]
    ] = [
      result[randomIndex],
      result[index]
    ];
  }

  return result;
}

function getUniqueLetters(title) {
  const letters = [];

  for (const character of title.toLowerCase()) {
    if (!isLetter(character)) {
      continue;
    }

    if (!letters.includes(character)) {
      letters.push(character);
    }
  }

  return letters;
}

function buildMaskedTitle(title, revealedLetters) {
  return [...title]
    .map((character) => {
      if (!isLetter(character)) {
        return character;
      }

      if (
        revealedLetters.has(
          normalizeLetter(character)
        )
      ) {
        return character;
      }

      return "_";
    })
    .join("");
}

function normalizeDifficulty(value) {
  const normalized = normalizeText(value);

  if (
    VALID_DIFFICULTIES.includes(normalized)
  ) {
    return normalized;
  }

  return null;
}

class TuneQuest {
  constructor() {
    this.songs = loadJson(
      SONGS_FILE,
      []
    );

    this.scores = loadJson(
      SCORES_FILE,
      {}
    );

    this.current = null;
    this.roundNumber = 0;
    this.lastSongTitle = null;
    this.clients = new Set();
  }

  addClient(ws) {
    this.clients.add(ws);

    ws.send(
      JSON.stringify({
        type: "state",
        state: this.getPublicState()
      })
    );
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  broadcast(payload) {
    const message = JSON.stringify(payload);

    for (const client of this.clients) {
      if (
        client.readyState ===
        WebSocket.OPEN
      ) {
        client.send(message);
      }
    }
  }

  getRemainingSeconds() {
    if (!this.current) {
      return 0;
    }

    return Math.max(
      0,
      Math.ceil(
        (
          this.current.endsAt -
          Date.now()
        ) / 1000
      )
    );
  }

  getPublicState() {
    if (!this.current) {
      return {
        active: false,
        roundNumber: this.roundNumber,
        difficulty: null,
        maskedTitle: null,
        remainingSeconds: 0,
        revealedCount: 0,
        totalLetters: 0,
        maxPoints: 0,
        answer: null
      };
    }

    return {
      active: true,
      roundNumber: this.current.roundNumber,
      difficulty: this.current.difficulty,
      maskedTitle: this.getMaskedTitle(),
      remainingSeconds:
        this.getRemainingSeconds(),
      revealedCount:
        this.current.revealedLetters.size,
      totalLetters:
        this.current.uniqueLetters.length,
      maxPoints:
        this.calculatePoints(),
      answer: null
    };
  }

  getMaskedTitle() {
    if (!this.current) {
      return null;
    }

    return buildMaskedTitle(
      this.current.song.title,
      this.current.revealedLetters
    );
  }

  getSongsForDifficulty(difficulty) {
    return this.songs.filter(
      (song) =>
        normalizeDifficulty(
          song.difficulty
        ) === difficulty
    );
  }

  chooseDifficulty(requestedDifficulty) {
    if (requestedDifficulty) {
      return requestedDifficulty;
    }

    return VALID_DIFFICULTIES[
      Math.floor(
        Math.random() *
        VALID_DIFFICULTIES.length
      )
    ];
  }

  chooseSong(difficulty) {
    const availableSongs =
      this.getSongsForDifficulty(
        difficulty
      );

    if (availableSongs.length === 0) {
      return null;
    }

    let candidates =
      availableSongs.filter(
        (song) =>
          song.title !==
          this.lastSongTitle
      );

    if (candidates.length === 0) {
      candidates = availableSongs;
    }

    return candidates[
      Math.floor(
        Math.random() *
        candidates.length
      )
    ];
  }

  startRound(requestedDifficulty = null) {
    if (this.current) {
      return {
        success: false,
        message:
          "A TuneQuest round is already active."
      };
    }

    const difficulty =
      this.chooseDifficulty(
        requestedDifficulty
      );

    const song =
      this.chooseSong(difficulty);

    if (!song) {
      return {
        success: false,
        message:
          `No songs are available for ${difficulty} difficulty.`
      };
    }

    this.roundNumber += 1;
    this.lastSongTitle = song.title;

    const uniqueLetters =
      getUniqueLetters(song.title);

    const revealQueue =
      shuffle(uniqueLetters);

    this.current = {
      roundNumber: this.roundNumber,
      song,
      difficulty,
      uniqueLetters,
      revealQueue,
      revealedLetters: new Set(),
      startedAt: Date.now(),
      endsAt:
        Date.now() +
        ROUND_SECONDS * 1000,
      revealTimer: null,
      clockTimer: null,
      roundTimer: null
    };

    this.current.revealTimer =
      setInterval(
        () => this.revealNextLetter(),
        REVEAL_INTERVAL_SECONDS * 1000
      );

    this.current.clockTimer =
      setInterval(
        () => this.broadcastTimer(),
        1000
      );

    this.current.roundTimer =
      setTimeout(
        () => {
          this.endRound("timeout");
        },
        ROUND_SECONDS * 1000
      );

    this.broadcast({
      type: "round_started",
      state: this.getPublicState()
    });

    return {
      success: true,
      state: this.getPublicState()
    };
  }

  broadcastTimer() {
    if (!this.current) {
      return;
    }

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

    if (
      this.current.revealQueue.length === 0
    ) {
      this.endRound("all_letters_revealed");
      return;
    }

    const letter =
      this.current.revealQueue.shift();

    this.current.revealedLetters.add(
      letter
    );

    this.broadcast({
      type: "letter_revealed",
      letter,
      maskedTitle:
        this.getMaskedTitle(),
      revealedCount:
        this.current.revealedLetters.size,
      totalLetters:
        this.current.uniqueLetters.length,
      remainingSeconds:
        this.getRemainingSeconds()
    });

    /*
     * The final unique letter has now been revealed.
     * The round ends immediately, regardless of how
     * much time remains on the clock.
     */
    if (
      this.current.revealedLetters.size >=
      this.current.uniqueLetters.length
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
      this.current.revealedLetters.size;

    return Math.max(
      10,
      100 - revealed * 10
    );
  }

  findMatchingSongGuess(guess) {
    if (!this.current) {
      return false;
    }

    const normalizedGuess =
      normalizeText(guess);

    if (!normalizedGuess) {
      return false;
    }

    const title =
      normalizeText(
        this.current.song.title
      );

    if (
      normalizedGuess === title
    ) {
      return true;
    }

    const aliases =
      Array.isArray(
        this.current.song.aliases
      )
        ? this.current.song.aliases
        : [];

    return aliases.some(
      (alias) =>
        normalizeText(alias) ===
        normalizedGuess
    );
  }

  handleGuess(username, guess) {
    if (!this.current) {
      return {
        success: false,
        message:
          "There is no active TuneQuest round."
      };
    }

    if (!guess) {
      return {
        success: false,
        message:
          "Use !guess <song title>."
      };
    }

    if (
      !this.findMatchingSongGuess(guess)
    ) {
      return {
        success: false,
        message: null
      };
    }

    const points =
      this.calculatePoints();

    this.scores[username] =
      Number(this.scores[username] || 0) +
      points;

    saveJson(
      SCORES_FILE,
      this.scores
    );

    const answer =
      this.current.song.title;

    this.endRound(
      "guessed",
      {
        username,
        points,
        answer
      }
    );

    return {
      success: true,
      username,
      points,
      answer
    };
  }

  endRound(reason, winner = null) {
    if (!this.current) {
      return;
    }

    const round = this.current;

    if (round.revealTimer) {
      clearInterval(
        round.revealTimer
      );
    }

    if (round.clockTimer) {
      clearInterval(
        round.clockTimer
      );
    }

    if (round.roundTimer) {
      clearTimeout(
        round.roundTimer
      );
    }

    this.current = null;

    this.broadcast({
      type: "round_ended",
      reason,
      winner,
      answer: round.song.title,
      artist: round.song.artist,
      year: round.song.year,
      difficulty: round.difficulty,
      state: {
        active: false,
        roundNumber:
          round.roundNumber,
        difficulty:
          round.difficulty,
        maskedTitle:
          round.song.title,
        remainingSeconds: 0,
        revealedCount:
          round.revealedLetters.size,
        totalLetters:
          round.uniqueLetters.length,
        maxPoints: 0,
        answer: round.song.title
      }
    });
  }

  skipRound() {
    if (!this.current) {
      return {
        success: false,
        message:
          "There is no active TuneQuest round."
      };
    }

    const answer =
      this.current.song.title;

    this.endRound("skipped");

    return {
      success: true,
      answer
    };
  }

  getLeaderboard(limit = 10) {
    return Object.entries(
      this.scores
    )
      .map(
        ([username, score]) => ({
          username,
          score: Number(score) || 0
        })
      )
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(0, limit);
  }

  getPlayerScore(username) {
    return Number(
      this.scores[username] || 0
    );
  }
}

const game = new TuneQuest();

const app = express();

app.use(
  express.json()
);

app.use(
  express.static(OVERLAY_DIR)
);

app.get(
  "/api/state",
  (req, res) => {
    res.json(
      game.getPublicState()
    );
  }
);

app.get(
  "/api/scores",
  (req, res) => {
    res.json(
      game.getLeaderboard(20)
    );
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status: "ok",
      game: "TuneQuest",
      version: "0.0.5",
      activeRound:
        Boolean(game.current),
      songs:
        game.songs.length
    });
  }
);

const server =
  http.createServer(app);

const websocketServer =
  new WebSocket.Server({
    server
  });

websocketServer.on(
  "connection",
  (ws) => {
    game.addClient(ws);

    ws.on(
      "close",
      () => {
        game.removeClient(ws);
      }
    );
  }
);

const twitchClient =
  new tmi.Client({
    options: {
      debug: false
    },
    identity: {
      username:
        process.env.TWITCH_USERNAME,
      password:
        process.env.TWITCH_OAUTH_TOKEN
    },
    channels: [
      CHANNEL
    ]
  });

twitchClient.on(
  "connected",
  (
    address,
    port
  ) => {
    console.log(
      `Twitch connected to ${address}:${port}`
    );

    console.log(
      `Channel: ${CHANNEL}`
    );
  }
);

twitchClient.on(
  "message",
  async (
    channel,
    tags,
    message,
    self
  ) => {
    if (self) {
      return;
    }

    const trimmed =
      message.trim();

    if (!trimmed.startsWith("!")) {
      return;
    }

    const parts =
      trimmed.split(/\s+/);

    const command =
      parts[0]
        .toLowerCase();

    const argument =
      parts
        .slice(1)
        .join(" ")
        .trim();

    const username =
      (
        tags.username ||
        "unknown"
      ).toLowerCase();

    if (command === "!tune") {
      const requestedDifficulty =
        normalizeDifficulty(
          argument
        );

      if (
        argument &&
        !requestedDifficulty
      ) {
        await twitchClient.say(
          channel,
          "❌ Difficulty must be easy, medium, or hard."
        );

        return;
      }

      const result =
        game.startRound(
          requestedDifficulty
        );

      if (!result.success) {
        await twitchClient.say(
          channel,
          `❌ ${result.message}`
        );

        return;
      }

      await twitchClient.say(
        channel,
        `🎵 TuneQuest round #${result.state.roundNumber} started — ${result.state.difficulty.toUpperCase()} difficulty!`
      );

      return;
    }

    if (command === "!guess") {
      const result =
        game.handleGuess(
          username,
          argument
        );

      if (
        result.success
      ) {
        await twitchClient.say(
          channel,
          `🎉 ${username} guessed "${result.answer}" and earned ${result.points} points!`
        );
      }

      return;
    }

    if (command === "!score") {
      const score =
        game.getPlayerScore(
          username
        );

      await twitchClient.say(
        channel,
        `🏆 ${username}, your TuneQuest score is ${score} points.`
      );

      return;
    }

    if (command === "!scores") {
      const leaderboard =
        game.getLeaderboard(5);

      if (
        leaderboard.length === 0
      ) {
        await twitchClient.say(
          channel,
          "🏆 The TuneQuest leaderboard is empty."
        );

        return;
      }

      const text =
        leaderboard
          .map(
            (entry, index) =>
              `${index + 1}. ${entry.username} — ${entry.score}`
          )
          .join(" | ");

      await twitchClient.say(
        channel,
        `🏆 ${text}`
      );

      return;
    }

    if (command === "!skip") {
      const isBroadcaster =
        tags.badges &&
        tags.badges.broadcaster ===
          "1";

      const isModerator =
        tags.mod === true ||
        (
          tags.badges &&
          tags.badges.moderator ===
            "1"
        );

      if (
        !isBroadcaster &&
        !isModerator
      ) {
        return;
      }

      const result =
        game.skipRound();

      if (result.success) {
        await twitchClient.say(
          channel,
          `⏭️ Round skipped. The answer was "${result.answer}".`
        );
      }

      return;
    }

    if (command === "!tunehelp") {
      await twitchClient.say(
        channel,
        "🎵 !tune = random difficulty | !tune easy/medium/hard = choose difficulty | !guess <song> = guess | !score = your score | !scores = leaderboard | !skip = skip round"
      );
    }
  }
);

server.listen(
  PORT,
  () => {
    console.log(
      `TuneQuest server running on http://localhost:${PORT}`
    );
  }
);

twitchClient.connect().catch(
  (error) => {
    console.error(
      "Failed to connect to Twitch:",
      error
    );
  }
);