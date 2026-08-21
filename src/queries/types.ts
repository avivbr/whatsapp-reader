/** Shared result shapes and errors for the query layer. */

export interface Chat {
  id: number;
  name: string;
  kind: string;
  messages: number;
  last: string | null;
}

export interface Message {
  date: string;
  chat: string;
  sender: string;
  kind: string;
  text: string | null;
  media: string | null;
  starred: boolean;
}

export class ChatNotFoundError extends Error {}

export class AmbiguousChatError extends Error {
  readonly matches: string[];
  constructor(term: string, matches: string[]) {
    const shown = matches.slice(0, 8).join(", ");
    super(
      `${matches.length} chats match ${JSON.stringify(term)}: ${shown}` +
        (matches.length > 8 ? "…" : ""),
    );
    this.matches = matches;
  }
}
