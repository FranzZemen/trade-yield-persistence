/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Datestamp} from '@franzzemen/utility';

/**
 * Discriminator that scopes a segment / sub-trade-yield-unit row to one of the three
 * trade-yield summary contexts. Encoded as a string prefix in the row's SK so a single
 * Query prefix-scan returns "all rows in this context for owner" (or "for trade in
 * context" via the by-trade LSI).
 *
 * - `'open'` — rolling computation against current open trade state. One canonical
 *   set of segments per trade.
 * - `'asOf:YYYY-MM-DD'` — reconstitution at a historical date. Multiple sets per trade,
 *   keyed by as-of date.
 * - `'since:<epoch13>'` — gain-since-anchor reconstitution. Multiple sets per trade,
 *   keyed by the anchor epoch (zero-padded to 13 digits for lexicographic sort).
 */
export type YieldContext =
  | 'open'
  | `asOf:${string}`
  | `since:${string}`;

export const OPEN_CONTEXT: YieldContext = 'open';

/** 13-digit zero-padded millisecond epoch. Sortable lexicographically through year 2286. */
export function padEpoch(epochMs: number): string {
  return String(Math.floor(epochMs)).padStart(13, '0');
}

export function asOfContext(asOfDate: Datestamp): YieldContext {
  return `asOf:${asOfDate}`;
}

export function sinceContext(anchorEpochMs: number): YieldContext {
  return `since:${padEpoch(anchorEpochMs)}`;
}

/**
 * Discriminate a context string for downstream branching. Returns the broad kind
 * ('open' | 'asOf' | 'since') without parsing out the parameter.
 */
export function contextKind(context: YieldContext): 'open' | 'asOf' | 'since' {
  if (context === 'open') return 'open';
  if (context.startsWith('asOf:')) return 'asOf';
  return 'since';
}
