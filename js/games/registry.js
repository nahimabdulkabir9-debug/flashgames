// registry.js: the list of games. To add a game, import it and add it to GAMES.
// A game is { id, name, emoji, blurb, minPlayers, create(container, session, api) }
// where create() returns { update(room), destroy() }.
import pictionary from './pictionary.js';
import wordCookies from './wordcookies.js';

export const GAMES = [pictionary, wordCookies];
export const getGame = (id) => GAMES.find((g) => g.id === id);
