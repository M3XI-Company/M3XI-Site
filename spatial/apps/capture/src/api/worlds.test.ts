/**
 * The property and world picker.
 *
 * The rules being pinned are the ones that decide whether an operator can
 * start: which versions a walkthrough may be filed against, and what a
 * property with nothing to file against says instead of just being missing
 * from the list. A property that quietly vanishes from the picker is how
 * somebody drives home.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPTURABLE_STATUSES, PROPERTY_LIMIT, buildChoices, loadChoices,
  type PropertyRow, type WorldReader, type WorldRow,
} from './worlds.js';

function property(id: string, label: string, extra: Partial<PropertyRow> = {}): PropertyRow {
  return { id, label, ref: null, postcode: null, archived_at: null, ...extra };
}

function world(id: string, propertyId: string, version: number, status: string): WorldRow {
  return { id, property_id: propertyId, version, status };
}

describe('CAPTURABLE_STATUSES', () => {
  it('excludes published, so a live listing is never changed by accident', () => {
    expect(CAPTURABLE_STATUSES.has('published')).toBe(false);
  });

  it('excludes archived, so work is not filed where nobody looks', () => {
    expect(CAPTURABLE_STATUSES.has('archived')).toBe(false);
  });

  it('includes failed, which is very often why somebody was sent back', () => {
    expect(CAPTURABLE_STATUSES.has('failed')).toBe(true);
  });
});

describe('buildChoices', () => {
  it('offers the capturable versions of a property, newest first', () => {
    const choices = buildChoices(
      [property('p1', 'Flat 2, Elm Court')],
      [world('w1', 'p1', 1, 'draft'), world('w3', 'p1', 3, 'review'), world('w2', 'p1', 2, 'failed')],
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]!.worlds.map((w) => w.version)).toEqual([3, 2, 1]);
    expect(choices[0]!.unavailable).toBeNull();
  });

  it('marks the highest version as latest, including when it is not capturable', () => {
    const choices = buildChoices(
      [property('p1', 'A')],
      [world('w2', 'p1', 2, 'published'), world('w1', 'p1', 1, 'draft')],
    );
    // v1 is offered, and it is NOT the latest -- the operator should be able
    // to see that they are adding to an older version.
    expect(choices[0]!.worlds).toEqual([{ worldId: 'w1', version: 1, status: 'draft', latest: false }]);
  });

  it('says why a property with no world cannot be walked', () => {
    const choices = buildChoices([property('p1', 'A')], []);
    expect(choices[0]!.worlds).toHaveLength(0);
    expect(choices[0]!.unavailable).toMatch(/no world yet/i);
    expect(choices[0]!.unavailable).toMatch(/console/i);
  });

  it('names the states when every version is off limits', () => {
    const choices = buildChoices(
      [property('p1', 'A')],
      [world('w1', 'p1', 1, 'published'), world('w2', 'p1', 2, 'archived')],
    );
    expect(choices[0]!.unavailable).toMatch(/archived and published/);
  });

  it('leaves archived properties out entirely', () => {
    const choices = buildChoices(
      [property('p1', 'A'), property('p2', 'B', { archived_at: '2026-01-01T00:00:00Z' })],
      [world('w1', 'p1', 1, 'draft'), world('w2', 'p2', 1, 'draft')],
    );
    expect(choices.map((c) => c.propertyId)).toEqual(['p1']);
  });

  it('puts the properties that can be walked above the ones that cannot', () => {
    const choices = buildChoices(
      [property('p1', 'Aardvark House'), property('p2', 'Beech Villa'), property('p3', 'Cedar Lodge')],
      [world('w2', 'p2', 1, 'draft')],
    );
    expect(choices.map((c) => c.propertyId)).toEqual(['p2', 'p1', 'p3']);
  });

  it('builds a subtitle from whichever of ref and postcode exist', () => {
    const choices = buildChoices(
      [property('p1', 'A', { ref: 'ELM-22', postcode: 'SW8 1AA' }),
        property('p2', 'B', { postcode: 'SE1 9XX' }),
        property('p3', 'C')],
      [],
    );
    const byId = new Map(choices.map((c) => [c.propertyId, c.subtitle]));
    expect(byId.get('p1')).toBe('ELM-22 · SW8 1AA');
    expect(byId.get('p2')).toBe('SE1 9XX');
    expect(byId.get('p3')).toBe('');
  });
});

describe('loadChoices', () => {
  it('reads only the columns it shows, and only unarchived properties', async () => {
    const queries: { table: string; query: Record<string, unknown> }[] = [];
    const client: WorldReader = {
      async select<T>(table: string, query: Record<string, unknown>): Promise<readonly T[]> {
        queries.push({ table, query });
        if (table === 'wv_property') return [property('p1', 'A')] as unknown as T[];
        return [world('w1', 'p1', 1, 'draft')] as unknown as T[];
      },
    };
    const { choices, truncated } = await loadChoices(client);
    expect(choices).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(queries[0]!.table).toBe('wv_property');
    expect(queries[0]!.query['isNull']).toEqual(['archived_at']);
    expect(queries[1]!.query['in']).toEqual({ property_id: ['p1'] });
  });

  it('does not ask for worlds when there are no properties', async () => {
    const tables: string[] = [];
    const client: WorldReader = {
      async select<T>(table: string): Promise<readonly T[]> {
        tables.push(table);
        return [] as unknown as T[];
      },
    };
    expect(await loadChoices(client)).toEqual({ choices: [], truncated: false });
    expect(tables).toEqual(['wv_property']);
  });

  it('reports a truncated portfolio rather than hiding the cap', async () => {
    const many = Array.from({ length: PROPERTY_LIMIT }, (_, i) => property(`p${i}`, `P${i}`));
    const client: WorldReader = {
      async select<T>(table: string): Promise<readonly T[]> {
        return (table === 'wv_property' ? many : []) as unknown as T[];
      },
    };
    expect((await loadChoices(client)).truncated).toBe(true);
  });
});
