// registry.js: the list of games. To add a game, import it and add it to GAMES.
// A game is { id, name, emoji, blurb, minPlayers, maxPlayers, create(container, session, api) }
// where create() returns { update(room), destroy() }.
//
// The extra display fields below (category, time, accent, featured) are used
// by the homepage cards. Keeping them here avoids changing game logic.
import pictionary from './pictionary.js';
import wordCookies from './wordcookies.js';
import npat from './npat.js';
import spotTheLiar from './spot-the-liar.js';

const DETAILS = {
  pictionary: {
    category: 'Drawing', shortName: 'Pictionary', players: '2–16', time: '5–15 min',
    accent: 'violet', featured: true,
  },
  'word-cookies': {
    category: 'Word', shortName: 'Word Cookies', players: '1–16', time: '3–8 min',
    accent: 'amber', featured: false,
  },
  npat: {
    category: 'Party', shortName: 'NPAT', players: '1–16', time: '10–20 min',
    accent: 'coral', featured: true,
  },
  'spot-the-liar': {
    category: 'Party', shortName: 'Spot the Liar', players: '3–12', time: '5–15 min',
    accent: 'violet', featured: true,
  },
};

export const GAMES = [pictionary, wordCookies, npat, spotTheLiar]
  .map((game) => ({ ...game, ...(DETAILS[game.id] || {}) }));

export const CATEGORIES = ['All', ...new Set(GAMES.map((game) => game.category))];
export const getGame = (id) => GAMES.find((g) => g.id === id);
