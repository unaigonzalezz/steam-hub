import streamDeck from "@elgato/streamdeck";

/**
 * How keys show the text the plugin writes on them: a page position, a play time, a download
 * percentage, a game name.
 *
 * - `drawn`: painted into the key image, in the plugin's own style. The default.
 * - `title`: written as the Stream Deck title, so its font, size, colour and position follow
 *   whatever the user picked in the title menu.
 */
export type TextStyle = "drawn" | "title";

/** The part of the plugin's global settings this module owns. */
type WithTextStyle = { textStyle?: TextStyle };

let current: TextStyle | undefined;
let reading: Promise<TextStyle> | undefined;

/**
 * Reads the text style, cached after the first read and kept in step with the property inspector.
 * @returns The text style; `drawn` until the user picks otherwise.
 */
export function getTextStyle(): Promise<TextStyle> {
  if (current !== undefined) {
    return Promise.resolve(current);
  }

  return (reading ??= (async () => {
    streamDeck.settings.onDidReceiveGlobalSettings<WithTextStyle>((ev) => (current = textStyleOf(ev.settings)));

    return (current = textStyleOf(await streamDeck.settings.getGlobalSettings()));
  })());
}

/**
 * Resolves the text style from the plugin's global settings.
 * @param globals The global settings.
 * @returns The style chosen there, or `drawn` when none is.
 */
export function textStyleOf(globals: { textStyle?: unknown }): TextStyle {
  return globals.textStyle === "title" ? "title" : "drawn";
}
