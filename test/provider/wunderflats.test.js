/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as provider from '../../lib/provider/wunderflats.js';

/**
 * Wunderflats reads its results out of the page's `data-hydrant` JSON, so these tests pin the shape
 * of that payload. Assertions are structural, because the same file runs against the fixture and
 * against the live portal.
 */
const TEST_TIMEOUT = 120_000;

describe('#wunderflats provider testsuite()', () => {
  /** @type {any[]} */
  let listings;
  let runConfig;

  beforeAll(async () => {
    const Fredy = await mockFredy();
    runConfig = provider.createConfig(providerConfig.wunderflats, []);
    const job = { id: 'wunderflats', notificationAdapter: null, spatialFilter: null, specFilter: null };

    const fredy = new Fredy(runConfig, job, provider.metaInformation.id, similarityCache, undefined);
    listings = await fredy.execute();
  }, TEST_TIMEOUT);

  it('finds listings and notifies about them', () => {
    expect(listings).toBeInstanceOf(Array);
    expect(listings.length).toBeGreaterThan(0);

    const notificationObj = get();
    expect(notificationObj.serviceName).toBe('wunderflats');
    for (const notify of notificationObj.payload) {
      expect(notify.id).toBeTypeOf('string');
      expect(notify.price).toContain('€');
      expect(notify.size).toContain('m²');
      expect(notify.title).not.toBe('');
      expect(notify.address).not.toBe('');
    }
  });

  it('reads the rent in euros, not in cents', () => {
    for (const listing of listings) {
      expect(listing.price, `price of ${listing.id}`).toBeGreaterThan(100);
      expect(listing.price, `price of ${listing.id}`).toBeLessThan(20_000);
      expect(listing.size).toBeGreaterThan(0);
    }
  });

  it('links to the canonical listing page', () => {
    for (const listing of listings) {
      expect(listing.link, `link of ${listing.id}`).toMatch(
        /^https:\/\/wunderflats\.com\/de\/moebliertes-apartment\/[^/?]+\/[0-9a-f]{24}$/,
      );
    }
  });

  it(
    'enriches a listing with its description',
    async () => {
      const enriched = await runConfig.fetchDetails(listings[0]);

      expect(enriched.link).toBe(listings[0].link);
      expect(enriched.description).toBeTypeOf('string');
      expect(enriched.description).not.toBe('');
      expect(enriched.address).not.toBe('');
    },
    TEST_TIMEOUT,
  );

  describe('getListings', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** A search page with one listing, shaped like the real one. */
    const page = (item, anchor = '') =>
      `<script id="data-hydrant" type="application/json">${JSON.stringify({
        pageData: { listingResults: { total: 1, items: [item] } },
      })}</script>${anchor}`;

    const item = {
      _id: 'abcdefabcdefabcdefabcdef',
      title: { de: 'Wohnung', en: 'Flat' },
      price: 123456,
      area: 40,
      rooms: 2,
      address: { street: 'Venloer Str.', city: 'Köln', location: { coordinates: [6.9, 50.9] } },
      coverImage: { urls: { large: 'https://listingimages.wunderflats.com/x-large.jpg' } },
    };

    it('converts cents, takes the card link and swaps the GeoJSON coordinate order', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        text: async () => page(item, `<a href="/de/moebliertes-apartment/wohnung/${item._id}?dataLayerKey=x">card</a>`),
      });

      const [listing] = await provider.config.getListings(
        'https://wunderflats.com/de/moeblierte-wohnungen-auf-zeit/koeln',
      );

      expect(listing.price).toBe(1235);
      expect(listing.link).toBe(`https://wunderflats.com/de/moebliertes-apartment/wohnung/${item._id}`);
      expect(listing.address).toBe('Venloer Str., Köln');
      expect(listing.latitude).toBe(50.9);
      expect(listing.longitude).toBe(6.9);
    });

    it('returns nothing for a page without the embedded results', async () => {
      globalThis.fetch = async () => ({ ok: true, text: async () => '<html></html>' });

      expect(await provider.config.getListings('https://wunderflats.com/de/x')).toEqual([]);
    });
  });

  it('reads the tracked price from the detail page in euros', () => {
    const html = `<script id="data-hydrant" type="application/json">{"pageData":{"listing":{"price":249000}}}</script>`;

    expect(provider.config.priceTracking.extract(html)).toBe(2490);
  });
});
