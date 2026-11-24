# FlashGames progress

This file is the hand-over note. Anyone (or any new Claude session) picking up the work should read it first.

## Working rules

- Build one milestone at a time. After each one: commit, then stop and give exact two-tab / two-phone test steps.
- Manual steps (Firebase console, GitHub settings) get exact step-by-step instructions, then wait for the owner.
- Whot and Ayo: list the planned rules and get the owner's confirmation before coding.
- Drawing games are allowed (Pictionary). No song lyrics. No secrets in the repo.
- User text is only ever displayed with `textContent`.

## Milestones

- [x] **(a) Project setup and Firebase connection.** Static page, theme, Firebase SDK from CDN, anonymous sign-in, live connection check, server time, emulator support, setup check screen.
- [x] **(b) Home, rooms and lobby.** Nickname + emoji avatar, nickname filter, create/join with 5-letter code, `?room=` links, copy/WhatsApp/native share, live player list, ready status, kick (kicked players can't rejoin), presence, host promotion after 6 s offline, rejoin after refresh, room rules.
- [x] **(b2) Public rooms.** Private or public choice, public list, Quick play, host can switch type. Needs `publicRooms` rules published.
- [x] **(c, first part) Game system + Pictionary.** `js/games/registry.js`, host game picker, `rooms/<CODE>/game` node, Pictionary (hashed secret word, shared canvas, timer, scores). Still to do: how-to-play popup, sound toggle, play again.
- [ ] **(c, rest)** `games/registry.js`, game interface, game picker with categories, host-referee engine, shared timer, scoreboard, winner screen, play again, sound toggle, how-to-play popup.
- [ ] **(d) Game 1: Herd Mentality.** 60+ questions in JSON, answer normalising and fuzzy matching.
- [ ] **(e) Solo mode and bots.**
- [ ] **(f) Security rules and cleanup.** Full rules, room-creation rate limit, inactive room deletion, profanity filter.
  - [x] **(f, integrity pass)** Host-authoritative game writes, per-player subtrees, strict validation, drawer-validated Pictionary guesses and secrets, fair NPAT stop/votes, reconnect handling, room/public-listing cleanup, emulator-verified rules regression tests. Still later: creation rate limit and full TTL cleanup.
- [ ] **(g) PWA and polish.** Manifest, service worker under a subpath, PNG icons.
- [ ] **(h) Deploy to GitHub Pages.** README deploy + redeploy steps, live link.
- [ ] **(i) Remaining games**, 2 or 3 at a time (see list below).

## Game list (in order)

1. Herd Mentality
2. Most Likely To
3. Guess the Emoji (no song lyrics)
4. Imposter
5. Name, Place, Animal, Thing
6. Typing Race
7. Who Said It?
8. Bluff
9. Word Chain
10. Hangman, Would You Rather, Trivia Battle, Speed Math Race, Category Rush
11. Tic-Tac-Toe, Connect 4
12. Whot (confirm rules first)
13. Ludo
14. Ayo (confirm rules first)
15. Word Cookies (solo levels and race mode), Memory Match

## Notes for whoever continues

- Data model: `rooms/<CODE>/meta` (hostUid, createdAt, status, gameId, settings), `rooms/<CODE>/slots/1..16` (claimed slot per player, so the cap is enforced by rules), `rooms/<CODE>/players/<uid>` (includes its slot), `rooms/<CODE>/kicked/<uid>`. Only room members can read a room; only the host can change meta.
- Game state is host-authoritative: the host writes phases/timers/scores; players write only their own answers, votes, checks, guesses and stop requests; the current Pictionary drawer writes strokes/hints, secret words and solved marks. The word lives in `gameSecrets/<CODE>/<round>` so guessers cannot read it during a round.
- Host promotion is client-side: the earliest-joined online human takes over when the host has been offline for 6 s (`HOST_GRACE_MS` in room.js); the rules allow taking over only when the host is offline or gone.
- Firebase project: `flashgames-5b774` (database in europe-west1). Rules must be re-published in the console every time `firebase/database.rules.json` changes.
- Repo: `nahimabdulkabir9-debug/flashgames`, work happens on branch `main`.
- Live site: `https://nahimabdulkabir9-debug.github.io/flashgames/`.
- Firebase SDK version is pinned in `js/firebase.js` (10.12.2). Change all three import URLs together.
- Local emulator: `firebase emulators:start --project demo-flashgames`, then open `http://localhost:8000/?emulator=1`.
