# ⚡ FlashGames

Mobile-first party games for friends anywhere in the world. Open the site on your phone, pick a nickname, create or join a room with a 5-letter code, and play in real time. No install, no signup.

- **Frontend:** plain HTML, CSS and JavaScript (ES modules). No framework, no build step.
- **Realtime + login:** Firebase Realtime Database and Firebase Anonymous Authentication.
- **Hosting:** GitHub Pages (a static site, no custom server).

See [PROGRESS.md](PROGRESS.md) for what is built so far and what comes next.

---

## Project layout

| Path | What it does |
| --- | --- |
| `index.html` | The only HTML page. JavaScript draws every screen inside it. |
| `css/style.css` | All styling: colours, light/dark mode, big touch-friendly buttons. |
| `js/config.js` | App name and your Firebase web config. |
| `js/firebase.js` | Connects to Firebase, signs in anonymously, records daily visitors, server time helper. |
| `js/ui.js` | Safe helpers for building the page (`el`, `mount`, `toast`). |
| `js/app.js` | Starts the app and picks the screen: home, lobby, or setup check. Rejoins your room after a refresh. |
| `js/check.js` | The setup check screen. Open the site with `?check=1` to run it. |
| `js/storage.js` | Remembers your nickname, avatar, theme and last room on this phone. |
| `js/filter.js` | Cleans typed text and blocks rude nicknames. |
| `js/room.js` | Creates and joins rooms, online/offline presence, kick, leave, automatic host promotion. |
| `js/home.js` | Home screen: nickname, avatar picker, create or join. |
| `js/lobby.js` | Lobby: room code, share buttons, live player list, ready, host controls. |
| `icons/` | App icon, drawn in SVG. |
| `firebase/database.rules.json` | Security rules you publish to Firebase. |
| `firebase.json` | Settings for the local Firebase Emulator. |
| `tests/rules.test.js` | Emulator-backed regression tests for the security rules. |
| `package.json` | Dev-only dependencies/scripts for those tests; the site has no build step. |

---

## Set up Firebase (one time, about 10 minutes)

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Create a project** (or **Add project**). Name it `flashgames`. Turn **Google Analytics off** (you don't need it). Click **Create project**, then **Continue**.
3. **Turn on anonymous login.** In the left menu open **Build → Authentication**, click **Get started**, open the **Sign-in method** tab, click **Anonymous**, switch it **on**, and click **Save**.
4. **Create the database.** Open **Build → Realtime Database**, click **Create Database**. For location pick the region closest to most of your players (for example **Belgium, europe-west1**). Choose **Start in locked mode** and click **Enable**.
5. **Publish the rules.** Still in Realtime Database, open the **Rules** tab. Delete what is there, paste the whole contents of `firebase/database.rules.json`, and click **Publish**. Repeat this every time that file changes.
6. **Get your web config.** Click the ⚙️ gear next to **Project Overview → Project settings**. Under **Your apps**, click the web icon **`</>`**. Give it a nickname such as `flashgames-web`, leave "Firebase Hosting" unticked, and click **Register app**. You will see a `firebaseConfig = { ... }` block. Copy its values into `js/config.js`, replacing every `PASTE_...` value.
   - If `databaseURL` is missing from that block, copy the URL shown at the top of the **Realtime Database → Data** tab (it ends in `firebasedatabase.app` or `firebaseio.com`).
7. **Allow your live website to log in.** Open **Authentication → Settings → Authorized domains**, click **Add domain**, type `nahimabdulkabir9-debug.github.io` and click **Add**.
   - Type only the domain: no `https://`, no `/flashgames` path. One entry covers every repo on that account.
   - `localhost` is already in the list, so local testing works without this step.

To check everything is connected, open the site with `?check=1` at the end of the address (for example <http://localhost:8000/?check=1>).

## Daily visitor counts

The app records a visit each time a browser loads the site. Because the key is `siteVisits/<YYYY-MM-DD>/<uid>`, each visitor is counted once per UTC day. To read it:

1. Firebase Console → Realtime Database → Data.
2. Expand `siteVisits`, then the date you want.
3. Count the keys under that date. Each key is one anonymous visitor for that day.

Only a visitor's own uid can be written, and visitors cannot read this data from the app. It stores no nickname or game data. A different device, private window, or cleared site data gets a new anonymous uid and counts as a new visitor.

Counts start from the day this version goes live; earlier visits are not available. This change updates `firebase/database.rules.json`, so publish the rules too.

### Is it safe to put the Firebase config in a public repo?

Yes. `apiKey`, `authDomain`, `databaseURL`, `projectId`, `storageBucket`, `messagingSenderId` and `appId` only tell the browser which Firebase project to talk to. Every visitor's browser downloads them anyway. Your data is protected by:

- the **security rules** in `firebase/database.rules.json`, which decide who can read and write what, and
- the **Authorized domains** list, which stops other websites from logging in to your project.

Never commit a **service account key** (a JSON file with `"private_key"` in it) or anything from **Project settings → Service accounts**. This project never needs one.

---

## Test locally

You need any simple web server, because browsers block ES modules opened straight from a file. Python is enough:

```bash
# from this folder
python -m http.server 8000
```

Then open <http://localhost:8000> in your browser. For two players, open a second tab, or a private window so it counts as a different person.

### Optional: the Firebase Emulator (no real project needed)

The emulator is a fake Firebase that runs on your computer. Good for experimenting without touching real data. It needs [Node.js](https://nodejs.org) and **Java 21 or newer** (older Java versions are rejected by current `firebase-tools`).

```bash
npm install -g firebase-tools
firebase emulators:start --project demo-flashgames
```

If you don't want a global CLI, use `npx --yes firebase-tools` in place of `firebase` in any command below. On Windows, if `java` is not recognised after installing, add the JDK's `bin` folder to your PATH.

Keep that running, start the Python server in another terminal, and open <http://localhost:8000/?emulator=1>. The `?emulator=1` switch only works on localhost, so it can never affect the live site. You can watch the data change at <http://localhost:4000>.

### Rules regression tests

The site itself still has no build step. `npm` is only needed if you want to run the security-rule tests:

```bash
npm install              # first time only
npm test                 # pure game-rule logic, no emulator needed
npm run test:rules       # with the emulator running from the command above
```

You can also run the emulator and the rules tests together:

```bash
npx --yes firebase-tools emulators:exec --project demo-flashgames --only database "npm run test:rules"
```

The tests check the important permissions: host-only game state, drawer-only secrets and solved marks, player-owned answers/stop requests, the 16-slot room cap, last-player room deletion, and stale public-room pruning. Add a case there before changing a rule.

---

## Deploying

1. Commit and push to `main`.
2. In GitHub, open **Settings → Pages**, set **Source** to **Deploy from a branch**, choose `main` and `/ (root)`, then save. The first build may take a minute.
3. The live site is <https://nahimabdulkabir9-debug.github.io/flashgames/>.
4. If `firebase/database.rules.json` changed, publish it in **Firebase Console → Realtime Database → Rules**. Rules and client code must ship together: publish the rules before/with the pushed JS. Anyone with an old tab open should refresh.

---
