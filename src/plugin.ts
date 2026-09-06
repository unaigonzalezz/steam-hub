import streamDeck from "@elgato/streamdeck";

import { GamePage } from "./actions/game-page";
import { LaunchGame } from "./actions/launch-game";
import { LibraryDial } from "./actions/library-dial";
import { NowPlaying } from "./actions/now-playing";
import { PlayTimer } from "./actions/play-timer";
import { RandomGame } from "./actions/random-game";
import { ShowInstalled } from "./actions/show-installed";
import { SteamShortcut } from "./actions/steam-shortcut";
import { SteamStatus } from "./actions/steam-status";

// "info" keeps the library scan and launch decisions in the log without recording every frame of
// WebSocket traffic; switch to "trace" when diagnosing a problem.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new LaunchGame());
streamDeck.actions.registerAction(new RandomGame());
streamDeck.actions.registerAction(new ShowInstalled());
streamDeck.actions.registerAction(new SteamShortcut());
streamDeck.actions.registerAction(new SteamStatus());
streamDeck.actions.registerAction(new NowPlaying());
streamDeck.actions.registerAction(new PlayTimer());
streamDeck.actions.registerAction(new GamePage());
streamDeck.actions.registerAction(new LibraryDial());

streamDeck.connect();
