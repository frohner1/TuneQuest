require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const tmi = require("tmi.js");

const {
  TuneQuest,
  normalizeUsername,
  songs
} = require("./tunequest");

const PORT = Number(
  process.env.PORT || 8090
);

const ROUND_SECONDS = Number(
  process.env.ROUND_SECONDS || 60
);

const REVEAL_INTERVAL_SECONDS = Number(
  process.env.REVEAL_INTERVAL_SECONDS || 5
);

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server
});

const clients = new Set();

const game = new TuneQuest({
  roundSeconds: ROUND_SECONDS,
  revealIntervalSeconds:
    REVEAL_INTERVAL_SECONDS,
  onBroadcast: broadcast
});

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "..",
      "overlay",
      "index.html"
    )
  );
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    game: "TuneQuest",
    build: "0.0.11",
    roundActive: Boolean(
      game.current
    ),
    roundNumber:
      game.roundNumber
  });
});

wss.on("connection", (socket) => {
  clients.add(socket);

  socket.send(
    JSON.stringify({
      type: "state",
      state: game.getPublicState()
    })
  );

  socket.on("close", () => {
    clients.delete(socket);
  });
});

function broadcast(message) {
  const payload =
    JSON.stringify(message);

  for (const client of clients) {
    if (
      client.readyState ===
      WebSocket.OPEN
    ) {
      client.send(payload);
    }
  }
}

function isBroadcaster(tags) {
  return Boolean(
    tags.badges &&
    tags.badges.broadcaster === "1"
  );
}

function isModerator(tags) {
  return (
    tags.mod === true ||
    Boolean(
      tags.badges &&
      tags.badges.moderator === "1"
    )
  );
}

function sendTuneHelp(channel) {
  twitchClient.say(
    channel,
    "TuneQuest: !tune, !tune easy|medium|hard, !guess <song>, !score, !scores, !skip. Correct guesses build streaks!"
  );
}

function handleTuneCommand(
  channel,
  username,
  parts
) {
  const difficulty = parts[1]
    ? parts[1].toLowerCase()
    : null;

  const result =
    game.startRound(difficulty);

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
}

function handleGuessCommand(
  channel,
  username,
  parts
) {
  const guess =
    parts.slice(1).join(" ");

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

    if (result.streak >= 2) {
      messageText +=
        ` 🔥 ${result.streak}-song streak!`;
    } else if (result.streak === 1) {
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
}

function handleScoreCommand(
  channel,
  username
) {
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
}

function handleScoresCommand(channel) {
  const leaderboard =
    game.getLeaderboard();

  if (leaderboard.length === 0) {
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
        (player, index) =>
          `${index + 1}. ${player.username} ${player.score} pts`
      )
      .join(" | ");

  twitchClient.say(
    channel,
    `TuneQuest leaderboard: ${topPlayers}`
  );
}

function handleSkipCommand(
  channel,
  tags
) {
  if (
    !isBroadcaster(tags) &&
    !isModerator(tags)
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
}

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

twitchClient.connect().then(() => {
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

    if (!trimmed.startsWith("!")) {
      return;
    }

    const parts =
      trimmed.split(/\s+/);

    const command =
      parts[0].toLowerCase();

    if (command === "!tune") {
      handleTuneCommand(
        channel,
        username,
        parts
      );
      return;
    }

    if (command === "!guess") {
      handleGuessCommand(
        channel,
        username,
        parts
      );
      return;
    }

    if (command === "!score") {
      handleScoreCommand(
        channel,
        username
      );
      return;
    }

    if (command === "!scores") {
      handleScoresCommand(
        channel
      );
      return;
    }

    if (command === "!skip") {
      handleSkipCommand(
        channel,
        tags
      );
      return;
    }

    if (command === "!tunehelp") {
      sendTuneHelp(channel);
    }
  }
);

setInterval(() => {
  if (game.current) {
    game.broadcastTimer();
  }
}, 1000);

server.listen(PORT, () => {
  console.log(
    `TuneQuest Build 0.0.11 running on port ${PORT}`
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
});