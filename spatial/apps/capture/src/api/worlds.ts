/**
 * Choosing what this walk is a walk OF.
 *
 * A capture is filed against a world, a world belongs to a property, and both
 * are readable under RLS by any member of the owning org (`wv_property_rw` and
 * `wv_world_rw` in the RLS migration both test `wv_is_member`). So the app
 * reads them directly over PostgREST as the signed-in operator rather than
 * asking an edge function to read them on its behalf: there is nothing to
 * decide, the database already knows who may see what, and a round trip
 * through a function would only add a place for the answer to disagree.
 *
 * WHY THE APP WILL NOT CREATE A WORLD. `authenticated` does hold INSERT on
 * `wv_world`, so this app COULD make one. It does not, because `wv_world`
 * carries a `version` that is unique per property and a `supersedes_id` that
 * carries entity ids forward across a rescan — deciding that a walk is version
 * 3 of a property rather than a new draft is a portfolio decision made in the
 * console with the previous versions in view, not something to guess on a
 * doorstep from a list of two. A property with no world is therefore reported
 * as exactly that, with the sentence that says where to fix it, rather than
 * quietly given one.
 */

export interface PropertyRow {
  readonly id: string;
  readonly label: string;
  readonly ref: string | null;
  readonly postcode: string | null;
  readonly archived_at: string | null;
}

export interface WorldRow {
  readonly id: string;
  readonly property_id: string;
  readonly version: number;
  readonly status: string;
}

export interface WorldChoice {
  readonly worldId: string;
  readonly version: number;
  readonly status: string;
  /** True when this is the newest version of its property. */
  readonly latest: boolean;
}

export interface PropertyChoice {
  readonly propertyId: string;
  /** What the operator sees. Label, then reference or postcode to disambiguate. */
  readonly title: string;
  readonly subtitle: string;
  readonly worlds: readonly WorldChoice[];
  /** Set when there is nothing here to capture against, and says why. */
  readonly unavailable: string | null;
}

/** The reader this needs. Narrow, so a test supplies an object literal. */
export interface WorldReader {
  select<T>(table: string, query: {
    readonly select: string;
    readonly eq?: Readonly<Record<string, string | number | boolean>>;
    readonly in?: Readonly<Record<string, readonly string[]>>;
    readonly isNull?: readonly string[];
    readonly order?: { readonly column: string; readonly ascending: boolean };
    readonly limit?: number;
  }): Promise<readonly T[]>;
}

/**
 * Statuses a new walkthrough may be filed against.
 *
 * Two of the seven in `wv_world_status` are left out, each for its own reason.
 *
 * `published` is a world on the open internet on somebody's listing. Dropping
 * a fresh walkthrough into it would change what the public sees without anyone
 * approving it, and the console's rescan flow exists precisely so that a new
 * walk becomes a new VERSION which is then published on purpose.
 *
 * `archived` is a version somebody deliberately retired. Filing new work
 * against it would be filing it where nobody will look.
 *
 * The remaining five are all pre-publication states where another capture is a
 * normal thing to add — including `failed`, which is very often exactly why
 * somebody has been sent back to the property.
 */
export const CAPTURABLE_STATUSES: ReadonlySet<string> = new Set([
  'draft', 'capturing', 'processing', 'review', 'failed',
]);

/**
 * Join the two lists into what the picker shows.
 *
 * Pure, because this is the part with rules in it: which world is the latest,
 * which property has nothing to capture against and why, and what order they
 * appear in. The two selects above are plumbing.
 */
export function buildChoices(
  properties: readonly PropertyRow[], worlds: readonly WorldRow[],
): readonly PropertyChoice[] {
  const byProperty = new Map<string, WorldRow[]>();
  for (const w of worlds) {
    const list = byProperty.get(w.property_id);
    if (list) list.push(w); else byProperty.set(w.property_id, [w]);
  }

  const choices: PropertyChoice[] = [];
  for (const p of properties) {
    if (p.archived_at !== null) continue;
    const all = (byProperty.get(p.id) ?? []).slice().sort((a, b) => b.version - a.version);
    const highest = all[0]?.version ?? null;
    const capturable = all
      .filter((w) => CAPTURABLE_STATUSES.has(w.status))
      .map((w): WorldChoice => ({
        worldId: w.id, version: w.version, status: w.status, latest: w.version === highest,
      }));

    let unavailable: string | null = null;
    if (all.length === 0) {
      unavailable = 'This property has no world yet. Create one in the console before walking it; '
        + 'a walkthrough has to be filed against a version.';
    } else if (capturable.length === 0) {
      const states = Array.from(new Set(all.map((w) => w.status))).sort().join(' and ');
      unavailable = `Every version of this property is ${states}. Start a new version in the `
        + 'console — adding a walkthrough to a live listing, or to a retired one, is a decision '
        + 'rather than a default.';
    }

    choices.push({
      propertyId: p.id,
      title: p.label,
      subtitle: [p.ref, p.postcode].filter((x): x is string => typeof x === 'string' && x.length > 0)
        .join(' · '),
      worlds: capturable,
      unavailable,
    });
  }

  // Properties that can be walked first, then alphabetically. An operator
  // standing outside the address is scrolling this one-handed, and the entries
  // they cannot use should not be in the way of the one they can.
  return choices.sort((a, b) => {
    const usable = Number(a.unavailable !== null) - Number(b.unavailable !== null);
    return usable !== 0 ? usable : a.title.localeCompare(b.title, 'en-GB');
  });
}

/**
 * Read the portfolio the signed-in member can see.
 *
 * Capped at 200 properties: a phone in a hallway is not a place to page
 * through a national portfolio, and an agency with more than that will search
 * rather than scroll. The cap is stated on screen when it bites, because a
 * silently truncated list is how an operator concludes a property does not
 * exist and drives home.
 */
export const PROPERTY_LIMIT = 200;

export async function loadChoices(client: WorldReader): Promise<{
  readonly choices: readonly PropertyChoice[];
  readonly truncated: boolean;
}> {
  const properties = await client.select<PropertyRow>('wv_property', {
    select: 'id,label,ref,postcode,archived_at',
    isNull: ['archived_at'],
    order: { column: 'created_at', ascending: false },
    limit: PROPERTY_LIMIT,
  });
  if (properties.length === 0) return { choices: [], truncated: false };

  const worlds = await client.select<WorldRow>('wv_world', {
    select: 'id,property_id,version,status',
    in: { property_id: properties.map((p) => p.id) },
    order: { column: 'version', ascending: false },
  });
  return {
    choices: buildChoices(properties, worlds),
    truncated: properties.length >= PROPERTY_LIMIT,
  };
}
