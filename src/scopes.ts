/**
 * What an assistant can be allowed to do, as OAuth scopes. Every connection
 * has `listings`; `lists` is the reader's to give on the consent page,
 * ticked unless they untick it. A connection keeps the scopes it was given:
 * one made before a scope existed, or with it unticked, lacks it until the
 * reader connects it again, and /personalise says so.
 */
export const LISTINGS = "listings";
export const LISTS = "lists";

/** Every scope the consent page can give, beside OAuth's own. */
export const SCOPES = [LISTINGS, LISTS] as const;
