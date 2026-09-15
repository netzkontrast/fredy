/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, expect } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as provider from '../../lib/provider/grandCityProperty.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testFixtures');

// Grand City Property renders its result cards server-side, so the provider reads them with plain fetch.
const TEST_TIMEOUT = 120_000;

describe('#grandCityProperty provider testsuite()', () => {
  const runConfig = provider.createConfig(providerConfig.grandCityProperty, []);
  let liveListings;

  it(
    'should test grandCityProperty provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = { id: 'grandCityProperty', notificationAdapter: null, spatialFilter: null, specFilter: null };

      const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);
      liveListings = await fredy.execute();

      if (liveListings == null || liveListings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(liveListings).toBeInstanceOf(Array);
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('grandCityProperty');
      notificationObj.payload.forEach((notify) => {
        expect(notify.id).toBeTypeOf('string');
        expect(notify.price).toContain('€');
        expect(notify.size).toContain('m²');
        expect(notify.title).not.toBe('');
        expect(notify.link).toMatch(/^https:\/\/www\.grandcityproperty\.de\/wohnungssuche\/.+/);
        expect(notify.address).toBeTypeOf('string');
        expect(notify.address).not.toBe('');
      });
    },
    TEST_TIMEOUT,
  );

  describe('getListings', () => {
    const originalFetch = globalThis.fetch;
    const listHtml = fs.readFileSync(path.join(FIXTURES, 'grandCityProperty.html'), 'utf8');

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('reads every card of the recorded page with its figures', async () => {
      globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => listHtml });

      const listings = (await provider.config.getListings(providerConfig.grandCityProperty.url)).map(
        provider.config.normalize,
      );

      expect(listings.length).toBeGreaterThan(0);
      const flat = listings.find(
        (l) =>
          l.link === 'https://www.grandcityproperty.de/wohnungssuche/koln/theodor-heuss-strasse-12/5121_00409_004_0078',
      );
      expect(flat).toMatchObject({ price: 1192, size: 120, rooms: 5, address: 'Theodor-Heuss-Straße 12, Köln' });
      // the full title from the link, not the heading cut off with "..."
      expect(flat.title).toBe('Familien Willkommen! Großzügige 5-Zimmer-Wohnung - aktuell in Renovierung!');
      expect(flat.image).toMatch(
        /^https:\/\/www\.grandcityproperty\.de\/grandcityproperty\.de\/real-estates\/.+\.jpg$/,
      );
      expect(flat.latitude).toBeTypeOf('number');
      expect(flat.longitude).toBeTypeOf('number');
    });

    it('returns nothing when the page cannot be loaded', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });

      expect(await provider.config.getListings(providerConfig.grandCityProperty.url)).toEqual([]);
    });
  });

  describe('with provider_details enabled', () => {
    it(
      'should enrich listings with the exposé text',
      async () => {
        if (!liveListings?.length) throw new Error('No listings from first test to enrich');

        const enriched = await runConfig.fetchDetails(liveListings[0]);

        expect(enriched.link).toContain('https://www.grandcityproperty.de/');
        expect(enriched.description).toBeTypeOf('string');
        expect(enriched.description).toContain('Objektbeschreibung');
      },
      TEST_TIMEOUT,
    );
  });

  describe('priceTracking', () => {
    it('reads the Kaltmiete, the figure the search card shows', () => {
      const html = fs.readFileSync(path.join(FIXTURES, 'grandCityProperty_detail.html'), 'utf8');
      expect(provider.config.priceTracking.extract(html)).toBe(1192);
    });

    it('returns null for a page without it', () => {
      expect(provider.config.priceTracking.extract('<html><body></body></html>')).toBeNull();
    });
  });
});
