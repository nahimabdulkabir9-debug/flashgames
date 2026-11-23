// registry.js: the list of games. To add a game, import it and add it to GAMES.
// A game is { id, name, emoji, blurb, minPlayers, create(container, session, api) }
// where create() returns { update(room), destroy() }.
import pictionary from './pictionary.js';

export const GAMES = [pictionary];
export const getGame = (id) => GAMES.find((g) => g.id === id);
