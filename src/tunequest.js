const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const STREAKS_FILE = path.join(DATA_DIR, "streaks.json");

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

function loadSongs() {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter(
      (fileName) =>
        fileName.toLowerCase().startsWith("songs") &&
        fileName.toLowerCase().endsWith(".json")
    )
    .sort();

  const loadedSongs = [];
  const seenTitles = new Set();

  for (const fileName of files) {
    const filePath = path.join(DATA_DIR, fileName);

    try {
      const data = JSON.parse(
        fs.readFileSync(filePath, "utf8")
      );

      if (!Array.isArray(data)) {
        console.warn(
          `Skipping ${fileName}: expected an array.`
        );
        continue;
      }

      for (const song of data) {
        if (
          !song ||
          typeof song.title !== "string" ||
          !song.title.trim()
        ) {
          console.warn(
            `Skipping invalid song entry in ${fileName}.`
          );
          continue;
        }

        const normalizedTitle = song.title
          .trim()
          .toLowerCase();

        if (seenTitles.has(normalizedTitle)) {
          console.warn(
            `Skipping duplicate song "${song.title}" from ${fileName}.`
          );
          continue;
        }

        seenTitles.add(normalizedTitle);

        loadedSongs.push(song);
      }
    } catch (error) {
      console.error(
        `Could not load song library ${fileName}:`,
        error
      );
    }
  }

  console.log(
    `Loaded ${loadedSongs.length} songs from ${files.length} library files.`
  );

  return loadedSongs;
}

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
  return String(username || "")
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
  constructor({
    roundSeconds,
    revealIntervalSeconds,
    onBroadcast
  }) {
    this.roundSeconds = roundSeconds;
    this.revealIntervalSeconds =
      revealIntervalSeconds;

    this.onBroadcast =
      typeof onBroadcast === "function"
        ? onBroadcast
        : () => {};

    this.current = null;
    this.roundNumber = 0;
    this.lastSongTitle = null;

    this.revealTimer = null;
    this.roundTimer = null;
  }

  setBroadcaster(onBroadcast) {
    this.onBroadcast =
      typeof onBroadcast === "function"
        ? onBroadcast
        : () => {};
  }

  broadcast(message) {
    this.onBroadcast(message);
  }

  getRemainingSeconds() {
    if (!this.current) {
      return 0;
    }

    const elapsed =
      (Date.now() - this.current.startedAt) / 1000;

    return Math.max(
      0,
      Math.ceil(
        this.current.durationSeconds - elapsed
      )
    );
  }

  getMaskedTitle() {
    if (!this.current) {
      return "";
    }

    const revealed =
      this.current.revealedLetters;

    return [...this.current.song.title]
      .map((character) => {
        if (!/[a-z]/i.test(character)) {
          return character;
        }

        const normalized =
          character.toLowerCase();

        if (revealed.has(normalized)) {
          return character;
        }

        return "_";
      })
      .join("");
  }

  getPublicState() {
    if (!this.current) {
      return {
        active: false,
        roundNumber: this.roundNumber,
        difficulty: null,
        maskedTitle: "",
        revealedCount: 0,
        totalLetters: 0,
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
      revealedCount:
        this.current.revealedLetters.size,
      totalLetters:
        this.current.uniqueLetters.length,
      maxPoints: this.calculatePoints(),
      remainingSeconds:
        this.getRemainingSeconds(),
      songTitle: null
    };
  }

  getUniqueLetters(title) {
    const letters = [];

    for (const character of title.toLowerCase()) {
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

    let candidates = available.filter(
      (song) =>
        song.title !== this.lastSongTitle
    );

    if (candidates.length === 0) {
      candidates = available;
    }

    const index = Math.floor(
      Math.random() * candidates.length
    );

    return candidates[index];
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
            Math.random() * difficulties.length
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
      this.chooseSong(selectedDifficulty);

    if (!song) {
      return {
        ok: false,
        message:
          `No ${selectedDifficulty} songs are available.`
      };
    }

    const uniqueLetters =
      this.getUniqueLetters(song.title);

    this.roundNumber += 1;
    this.lastSongTitle = song.title;

    this.current = {
      song,
      difficulty: selectedDifficulty,
      startedAt: Date.now(),
      durationSeconds: this.roundSeconds,
      uniqueLetters,
      revealQueue: [...uniqueLetters].sort(
        () => Math.random() - 0.5
      ),
      revealedLetters: new Set()
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

    this.revealTimer = setInterval(() => {
      this.revealNextLetter();
    }, this.revealIntervalSeconds * 1000);

    this.roundTimer = setTimeout(() => {
      if (this.current) {
        this.endRound("timeout");
      }
    }, this.roundSeconds * 1000);
  }

  clearTimers() {
    if (this.revealTimer) {
      clearInterval(this.revealTimer);
      this.revealTimer = null;
    }

    if (this.roundTimer) {
      clearTimeout(this.roundTimer);
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

    if (
      this.current.revealQueue.length === 0
    ) {
      this.endRound(
        "all_letters_revealed"
      );
      return;
    }

    const letter =
      this.current.revealQueue.shift();

    this.current.revealedLetters.add(letter);

    const revealedCount =
      this.current.revealedLetters.size;

    const totalLetters =
      this.current.uniqueLetters.length;

    const maxPoints =
      this.calculatePoints();

    this.broadcast({
      type: "letter_revealed",
      letter,
      maskedTitle:
        this.getMaskedTitle(),
      revealedCount,
      totalLetters,
      maxPoints,
      remainingSeconds:
        this.getRemainingSeconds()
    });

    if (revealedCount >= totalLetters) {
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
      normalizedGuess === normalizedTitle
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
        message: "Invalid username."
      };
    }

    const song =
      this.findMatchingSongGuess(guess);

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
      songTitle: endedSong.title,
      state: {
        ...finalState,
        active: false,
        maxPoints: 0,
        maskedTitle: endedSong.title
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

    return Number(scores[player] || 0);
  }

  getPlayerStats(username) {
    const player =
      normalizeUsername(username);

    const streak =
      getPlayerStreak(player);

    return {
      username: player,
      score: this.getPlayerScore(player),
      streak: streak.current,
      bestStreak: streak.best
    };
  }

  getLeaderboard() {
    return getScoresSorted();
  }
}

module.exports = {
  TuneQuest,
  normalizeUsername,
  songs
};