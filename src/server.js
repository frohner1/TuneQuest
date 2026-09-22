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

const ROUND_SECONDS = Math.max(
  10,
  Number(process.env.ROUND_SECONDS || 60)
);

const REVEAL_INTERVAL_SECONDS = Math.max(
  1,
  Number(process.env.REVEAL_INTERVAL_SECONDS || 5)
);

const CHANNEL = String(
  process.env.TWITCH_CHANNEL || "frohner1"
).replace(/^#/, "");

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify(fallback, null, 2),
        "utf8"
      );

      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to load ${file}:`, error);
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeLetter(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function isLetter(character) {
  return /^\p{L}$/u.test(character);
}

function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

function getUniqueLetters(title) {
  const letters = [];

  for (const character of title) {
    if (!isLetter(character)) {
      continue;
    }

    const normalized = normalizeLetter(character);

    if (!letters.includes(normalized)) {
      letters.push(normalized);
    }
  }

  return letters;
}

function buildMaskedTitle(title, revealedLetters) {
  const words = title.split(" ");

  return words
    .map((word) => {
      return [...word]
        .map((character) => {
          if (!isLetter(character)) {
            return character;
          }

          const normalized = normalizeLetter(character);

          if (revealedLetters.has(normalized)) {
            return character.toUpperCase();
          }

          return "_";
        })
        .join(" ");
    })
    .join("   ");
}

class TuneQuest {
  constructor() {
    this.songs = loadJson(SONGS_FILE, []);
    this.scores = loadJson(SCORES_FILE, {});

    this.current = null;

    this.roundNumber = 0;
    this.lastSongTitle = null;

    this.clients = new Set();
  }

  addClient(socket) {
    this.clients.add(socket);

    socket.send(
      JSON.stringify({
        type: "state",
        state: this.getPublicState()
      })
    );
  }

  removeClient(socket) {
    this.clients.delete(socket);
  }

  broadcast(message) {
    const payload = JSON.stringify(message);

    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  getRemainingSeconds() {
    if (!this.current) {
      return 0;
    }

    const elapsedSeconds =
      (Date.now() - this.current.startedAt) / 1000;

    return Math.max(
      0,
      Math.ceil(ROUND_SECONDS - elapsedSeconds)
    );
  }

  getPublicState() {
    if (!this.current) {
      return {
        game: "TuneQuest",
        version: "0.0.2",
        status: "idle",
        roundNumber: this.roundNumber,
        maskedTitle: "",
        revealedUniqueLetters: 0,
        totalUniqueLetters: 0,
        maxPoints: 100,
        remainingSeconds: 0,
        allLettersRevealed: false
      };
    }

    return {
      game: "TuneQuest",
      version: "0.0.2",
      status: "playing",
      roundNumber: this.roundNumber,
      maskedTitle: this.getMaskedTitle(),
      revealedUniqueLetters:
        this.current.revealedLetters.size,
      totalUniqueLetters:
        this.current.uniqueLetters.length,
      maxPoints: this.calculatePoints(),
      remainingSeconds:
        this.getRemainingSeconds(),
      allLettersRevealed:
        this.current.revealedLetters.size >=
        this.current.uniqueLetters.length
    };
  }

  getMaskedTitle() {
    if (!this.current) {
      return "";
    }

    return buildMaskedTitle(
      this.current.song.title,
      this.current.revealedLetters
    );
  }

  chooseSong() {
    if (!this.songs.length) {
      return null;
    }

    let available = this.songs.filter(
      (song) =>
        normalizeText(song.title) !==
        normalizeText(this.lastSongTitle)
    );

    if (!available.length) {
      available = [...this.songs];
    }

    return available[
      Math.floor(Math.random() * available.length)
    ];
  }

  startRound() {
    if (this.current) {
      return {
        success: false,
        message: "A TuneQuest round is already running."
      };
    }

    const song = this.chooseSong();

    if (!song) {
      return {
        success: false,
        message: "There are no songs configured."
      };
    }

    this.roundNumber += 1;
    this.lastSongTitle = song.title;

    const uniqueLetters =
      getUniqueLetters(song.title);

    this.current = {
      song,
      startedAt: Date.now(),
      uniqueLetters,
      remainingLetters:
        shuffle(uniqueLetters),
      revealedLetters: new Set(),
      revealTimer: null,
      roundTimer: null,
      clockTimer: null
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
        () => this.endRound("timeout"),
        ROUND_SECONDS * 1000
      );

    this.broadcast({
      type: "round_started",
      state: this.getPublicState()
    });

    return {
      success: true,
      song
    };
  }

  broadcastTimer() {
    if (!this.current) {
      return;
    }

    const remainingSeconds =
      this.getRemainingSeconds();

    this.broadcast({
      type: "timer",
      remainingSeconds
    });
  }

  revealNextLetter() {
    if (!this.current) {
      return {
        success: false,
        message: "There is no active TuneQuest round."
      };
    }

    if (
      this.current.remainingLetters.length === 0
    ) {
      if (this.current.revealTimer) {
        clearInterval(
          this.current.revealTimer
        );

        this.current.revealTimer = null;
      }

      return {
        success: false,
        message: "All letters have already been revealed."
      };
    }

    const letter =
      this.current.remainingLetters.shift();

    this.current.revealedLetters.add(letter);

    const maskedTitle =
      this.getMaskedTitle();

    this.broadcast({
      type: "letter_revealed",
      letter,
      maskedTitle,
      revealedUniqueLetters:
        this.current.revealedLetters.size,
      totalUniqueLetters:
        this.current.uniqueLetters.length,
      maxPoints:
        this.calculatePoints(),
      allLettersRevealed:
        this.current.remainingLetters.length === 0
    });

    if (
      this.current.remainingLetters.length === 0 &&
      this.current.revealTimer
    ) {
      clearInterval(
        this.current.revealTimer
      );

      this.current.revealTimer = null;
    }

    return {
      success: true,
      letter
    };
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

    const possibleAnswers = [
      this.current.song.title,
      ...(this.current.song.aliases || [])
    ];

    return possibleAnswers.some(
      (answer) =>
        normalizeText(answer) ===
        normalizedGuess
    );
  }

  handleGuess(username, guess) {
    if (!this.current) {
      return {
        success: false,
        message: "There is no active TuneQuest round."
      };
    }

    if (!guess.trim()) {
      return {
        success: false,
        message:
          "Usage: !guess <song title>"
      };
    }

    if (!this.findMatchingSongGuess(guess)) {
      return {
        success: false,
        message: null
      };
    }

    const points =
      this.calculatePoints();

    const answer =
      this.current.song.title;

    const artist =
      this.current.song.artist;

    if (!this.scores[username]) {
      this.scores[username] = {
        points: 0,
        wins: 0
      };
    }

    this.scores[username].points +=
      points;

    this.scores[username].wins += 1;

    saveJson(
      SCORES_FILE,
      this.scores
    );

    this.endRound(
      "guessed",
      {
        username,
        answer,
        artist,
        points
      }
    );

    return {
      success: true,
      points,
      answer,
      artist
    };
  }

  endRound(reason, winner = null) {
    if (!this.current) {
      return;
    }

    const round =
      this.current;

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

    const answer =
      round.song.title;

    const artist =
      round.song.artist;

    this.current = null;

    this.broadcast({
      type: "round_ended",
      reason,
      answer,
      artist,
      winner,
      maskedTitle:
        buildMaskedTitle(
          answer,
          new Set(
            getUniqueLetters(answer)
          )
        ),
      leaderboard:
        this.getLeaderboard()
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

  getLeaderboard() {
    return Object.entries(
      this.scores
    )
      .sort((a, b) => {
        if (
          b[1].points !==
          a[1].points
        ) {
          return (
            b[1].points -
            a[1].points
          );
        }

        return (
          b[1].wins -
          a[1].wins
        );
      })
      .slice(0, 10)
      .map(
        ([username, stats], index) => ({
          rank: index + 1,
          username,
          points: stats.points,
          wins: stats.wins
        })
      );
  }

  getPlayerScore(username) {
    const stats =
      this.scores[username];

    if (!stats) {
      return {
        username,
        points: 0,
        wins: 0
      };
    }

    return {
      username,
      points: stats.points,
      wins: stats.wins
    };
  }
}

const game =
  new TuneQuest();

const app =
  express();

app.use(
  express.json()
);

app.use(
  express.static(
    OVERLAY_DIR
  )
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
      game.getLeaderboard()
    );
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      game: "TuneQuest",
      version: "0.0.2",
      twitchChannel: CHANNEL
    });
  }
);

const server =
  http.createServer(app);

const wss =
  new WebSocket.Server({
    server
  });

wss.on(
  "connection",
  (socket) => {
    console.log(
      "Overlay connected."
    );

    game.addClient(socket);

    socket.on(
      "close",
      () => {
        game.removeClient(
          socket
        );

        console.log(
          "Overlay disconnected."
        );
      }
    );
  }
);

server.listen(
  PORT,
  () => {
    console.log(
      `TuneQuest server running at http://localhost:${PORT}`
    );

    console.log(
      `TuneQuest overlay: http://localhost:${PORT}/`
    );

    console.log(
      `Reveal interval: ${REVEAL_INTERVAL_SECONDS}s`
    );

    console.log(
      `Round duration: ${ROUND_SECONDS}s`
    );
  }
);

const twitchUsername =
  process.env.TWITCH_USERNAME;

const twitchToken =
  process.env.TWITCH_OAUTH_TOKEN;

if (
  !twitchUsername ||
  !twitchToken
) {
  console.warn(
    "Twitch credentials are missing. Web server will still run."
  );
} else {
  const client =
    new tmi.Client({
      options: {
        debug: true
      },

      identity: {
        username:
          twitchUsername,

        password:
          twitchToken
      },

      channels: [
        CHANNEL
      ]
    });

  client.on(
    "connected",
    (address, port) => {
      console.log(
        `Twitch connected to ${address}:${port}`
      );

      console.log(
        `Channel: ${CHANNEL}`
      );
    }
  );

  client.on(
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

      if (
        !trimmed.startsWith("!")
      ) {
        return;
      }

      const parts =
        trimmed.split(
          /\s+/
        );

      const command =
        parts[0].toLowerCase();

      const argument =
        parts
          .slice(1)
          .join(" ")
          .trim();

      const username =
        tags.username ||
        "unknown";

      if (
        command === "!tune"
      ) {
        const result =
          game.startRound();

        if (result.success) {
          await client.say(
            channel,
            "🎵 TuneQuest round started! Guess the song with !guess <song title>"
          );
        } else {
          await client.say(
            channel,
            `❌ ${result.message}`
          );
        }

        return;
      }

      if (
        command === "!guess"
      ) {
        const result =
          game.handleGuess(
            username,
            argument
          );

        if (result.success) {
          await client.say(
            channel,
            `🎉 ${username} guessed "${result.answer}" by ${result.artist} and earned ${result.points} points!`
          );
        }

        return;
      }

      if (
        command === "!score"
      ) {
        const score =
          game.getPlayerScore(
            username
          );

        await client.say(
          channel,
          `${username}: ${score.points} points, ${score.wins} wins.`
        );

        return;
      }

      if (
        command === "!scores"
      ) {
        const leaderboard =
          game.getLeaderboard();

        if (
          !leaderboard.length
        ) {
          await client.say(
            channel,
            "No scores yet."
          );

          return;
        }

        const text =
          leaderboard
            .slice(0, 5)
            .map(
              (entry) =>
                `${entry.rank}. ${entry.username} ${entry.points} pts`
            )
            .join(" | ");

        await client.say(
          channel,
          `🏆 ${text}`
        );

        return;
      }

      if (
        command === "!skip"
      ) {
        const isBroadcaster =
          tags.badges &&
          tags.badges.broadcaster ===
            "1";

        const isModerator =
          tags.mod === true;

        if (
          !isBroadcaster &&
          !isModerator
        ) {
          return;
        }

        const result =
          game.skipRound();

        if (result.success) {
          await client.say(
            channel,
            `⏭️ Round skipped. The answer was "${result.answer}".`
          );
        }

        return;
      }

      if (
        command === "!tunehelp"
      ) {
        await client.say(
          channel,
          "🎵 !tune = start | !guess <song> = guess | !score = your score | !scores = leaderboard | !skip = skip round"
        );

        return;
      }
    }
  );

  client.on(
    "disconnected",
    (reason) => {
      console.log(
        "Twitch disconnected:",
        reason
      );
    }
  );

  client.connect()
    .catch((error) => {
      console.error(
        "Twitch connection failed:",
        error
      );
    });
}