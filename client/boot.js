// Entry point: in the app, restore saved settings / the profile key from native storage first,
// then start the game (main.js reads localStorage as soon as it loads). Never wait more than 2 s.
import { restoreNative } from './platform.js';
Promise.race([restoreNative(), new Promise((r) => setTimeout(r, 2000))]).finally(() => import('./main.js'));
