import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etDate, espnScoreboardUrl, normalizeTeam, parseEspnScoreboard, findFinal, gradeEdge, unitsFor } from './grading.js';

const competitor = (homeAway, displayName, location, name, score) => ({
  homeAway,
  score,
  team: { displayName, location, name },
});
const espnEvent = (date, completed, home, away) => ({
  date,
  competitions: [{ status: { type: { completed } }, competitors: [home, away] }],
});
const SCOREBOARD = {
  events: [
    espnEvent(
      '2026-09-25T00:15Z',
      true,
      competitor('home', 'Green Bay Packers', 'Green Bay', 'Packers', '27'),
      competitor('away', 'Atlanta Falcons', 'Atlanta', 'Falcons', '20')
    ),
    espnEvent(
      '2026-09-25T02:30Z',
      false,
      competitor('home', 'Hawaii Rainbow Warriors', 'Hawaii', 'Rainbow Warriors', '14'),
      competitor('away', 'San José State Spartans', 'San José State', 'Spartans', '10')
    ),
    espnEvent(
      '2026-09-25T03:00Z',
      true,
      competitor('home', "Hawai'i Rainbow Warriors", "Hawai'i", 'Rainbow Warriors', '31'),
      competitor('away', 'San José State Spartans', 'San José State', 'Spartans', '31')
    ),
  ],
};

test('etDate files a late-night UTC kickoff under the previous Eastern date', () => {
  assert.equal(etDate('2026-09-25T00:15:00Z'), '20260924');
  assert.equal(etDate('2026-09-27T17:00:00Z'), '20260927');
  assert.equal(etDate('2026-12-01T04:30:00Z'), '20261130'); // EST, -5h
});

test('espnScoreboardUrl covers edge sports and asks for all FBS games in college', () => {
  assert.equal(
    espnScoreboardUrl('americanfootball_nfl', '20260924'),
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260924'
  );
  assert.ok(espnScoreboardUrl('americanfootball_ncaaf', '20260924').endsWith('dates=20260924&groups=80&limit=300'));
  assert.equal(espnScoreboardUrl('soccer_epl', '20260924'), null);
});

test('normalizeTeam ignores accents, punctuation and case', () => {
  assert.equal(normalizeTeam('San José State Spartans'), normalizeTeam('San Jose State Spartans'));
  assert.equal(normalizeTeam("Hawai'i Rainbow Warriors"), normalizeTeam('Hawaii Rainbow Warriors'));
});

test('parseEspnScoreboard keeps completed games only, with numeric scores', () => {
  const games = parseEspnScoreboard(SCOREBOARD);
  assert.equal(games.length, 2);
  assert.deepEqual([games[0].homeScore, games[0].awayScore], [27, 20]);
  assert.deepEqual(parseEspnScoreboard(null), []);
  assert.deepEqual(parseEspnScoreboard({ events: [{}] }), []);
});

test('findFinal matches on both team names and kickoff time', () => {
  const games = parseEspnScoreboard(SCOREBOARD);
  const gb = findFinal(games, { game: 'Atlanta Falcons @ Green Bay Packers', commence_time: '2026-09-25T00:15:00Z' });
  assert.equal(gb.homeScore, 27);
  const hawaii = findFinal(games, { game: 'San Jose State Spartans @ Hawaii Rainbow Warriors', commence_time: '2026-09-25T03:00:00Z' });
  assert.equal(hawaii.homeScore, 31);
  // Home/away reversed is a different game.
  assert.equal(findFinal(games, { game: 'Green Bay Packers @ Atlanta Falcons', commence_time: '2026-09-25T00:15:00Z' }), null);
  // Same teams a week later isn't this game.
  assert.equal(findFinal(games, { game: 'Atlanta Falcons @ Green Bay Packers', commence_time: '2026-10-02T00:15:00Z' }), null);
});

const RESULT = { home_team: 'Green Bay Packers', away_team: 'Atlanta Falcons', home_score: 27, away_score: 20 };

test('gradeEdge settles moneylines', () => {
  assert.equal(gradeEdge({ market: 'h2h', outcome: 'Green Bay Packers', point: null }, RESULT), 'win');
  assert.equal(gradeEdge({ market: 'h2h', outcome: 'Atlanta Falcons', point: null }, RESULT), 'loss');
  assert.equal(gradeEdge({ market: 'h2h', outcome: 'Atlanta Falcons' }, { ...RESULT, away_score: 27 }), 'push');
});

test('gradeEdge settles spreads including pushes', () => {
  assert.equal(gradeEdge({ market: 'spreads', outcome: 'Green Bay Packers', point: -6.5 }, RESULT), 'win');
  assert.equal(gradeEdge({ market: 'spreads', outcome: 'Green Bay Packers', point: -7 }, RESULT), 'push');
  assert.equal(gradeEdge({ market: 'spreads', outcome: 'Green Bay Packers', point: -7.5 }, RESULT), 'loss');
  assert.equal(gradeEdge({ market: 'spreads', outcome: 'Atlanta Falcons', point: 7.5 }, RESULT), 'win');
});

test('gradeEdge settles totals', () => {
  assert.equal(gradeEdge({ market: 'totals', outcome: 'Over', point: 46.5 }, RESULT), 'win');
  assert.equal(gradeEdge({ market: 'totals', outcome: 'Under', point: 46.5 }, RESULT), 'loss');
  assert.equal(gradeEdge({ market: 'totals', outcome: 'Under', point: 47 }, RESULT), 'push');
});

test('gradeEdge returns null for anything it cannot settle', () => {
  assert.equal(gradeEdge({ market: 'h2h', outcome: 'Chicago Bears' }, RESULT), null);
  assert.equal(gradeEdge({ market: 'spreads', outcome: 'Green Bay Packers', point: null }, RESULT), null);
  assert.equal(gradeEdge({ market: 'totals', outcome: 'Over', point: null }, RESULT), null);
  assert.equal(gradeEdge({ market: 'player_props', outcome: 'Over', point: 1 }, RESULT), null);
});

test('unitsFor pays decimal odds on a win, -1 on a loss, 0 on a push', () => {
  assert.equal(unitsFor('win', 2.5), 1.5);
  assert.equal(unitsFor('loss', 2.5), -1);
  assert.equal(unitsFor('push', 2.5), 0);
});
