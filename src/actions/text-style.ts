/**
 * How the "Show installed games" keys show the text they write on themselves: a game name, a play
 * time, a download percentage. Every other key always draws its text; these are the one place a
 * Stream Deck title, styled from the title menu, is still offered instead.
 *
 * - `drawn`: painted into the key image, in the plugin's own style. The default.
 * - `title`: written as the Stream Deck title, so its font, size, colour and position follow
 *   whatever the user picked in the title menu.
 */
export type TextStyle = "drawn" | "title";

/**
 * Resolves the text style from the plugin's global settings.
 * @param globals The global settings.
 * @returns The style chosen there, or `drawn` when none is.
 */
export function textStyleOf(globals: { textStyle?: unknown }): TextStyle {
  return globals.textStyle === "title" ? "title" : "drawn";
}
