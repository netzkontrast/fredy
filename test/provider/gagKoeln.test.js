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
import * as provider from '../../lib/provider/gagKoeln.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testFixtures');

// GAG Köln renders its first result page server-side, so the provider reads it with plain fetch.
const TEST_TIMEOUT = 120_000;

describe('#gagKoeln provider testsuite()', () => {
  const runConfig = provider.createConfig(providerConfig.gagKoeln, []);
  let liveListings;

  it(
    'should test gagKoeln provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = { id: 'gagKoeln', notificationAdapter: null, spatialFilter: null, specFilter: null };

      const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);
      liveListings = await fredy.execute();

      if (liveListings == null || liveListings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(liveListings).toBeInstanceOf(Array);
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('gagKoeln');
      notificationObj.payload.forEach((notify) => {
        expect(notify.id).toBeTypeOf('string');
        expect(notify.price).toBeTypeOf('string');
        expect(notify.price).toContain('€');
        expect(notify.size).toBeTypeOf('string');
        expect(notify.size).toContain('m²');
        expect(notify.title).not.toBe('');
        expect(notify.link).toMatch(/^https:\/\/www\.gag-koeln\.de\/immobiliensuche\/[\d-]+$/);
        expect(notify.address).toBeTypeOf('string');
        expect(notify.address).not.toBe('');
      });
    },
    TEST_TIMEOUT,
  );

  describe('getListings', () => {
    const originalFetch = globalThis.fetch;
    const listHtml = fs.readFileSync(path.join(FIXTURES, 'gagKoeln.html'), 'utf8');

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('reads every card of the recorded page with its figures', async () => {
      globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => listHtml });

      const listings = (await provider.config.getListings(providerConfig.gagKoeln.url)).map(provider.config.normalize);

      expect(listings.length).toBeGreaterThan(0);
      const niehl = listings.find((l) => l.link === 'https://www.gag-koeln.de/immobiliensuche/8110-00073-001-003');
      expect(niehl).toMatchObject({
        price: 810,
        size: 52,
        rooms: 2,
        address: 'Boltensternstr. 118, 50735 Köln Niehl',
      });
      expect(niehl.title).toContain('Zweizimmerwohnung');
      expect(niehl.image).toMatch(/^https:\/\/www\.gag-koeln\.de\/fileadmin\/.+\.jpg$/);
      expect(niehl.description).toContain('Balkon');
    });

    it('returns nothing when the page cannot be loaded', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });

      expect(await provider.config.getListings(providerConfig.gagKoeln.url)).toEqual([]);
    });
  });

  describe('with provider_details enabled', () => {
    it(
      'should enrich listings with the exposé text',
      async () => {
        if (!liveListings?.length) throw new Error('No listings from first test to enrich');

        const enriched = await runConfig.fetchDetails(liveListings[0]);

        expect(enriched.link).toContain('https://www.gag-koeln.de/');
        expect(enriched.address).not.toBe('');
        expect(enriched.description).toBeTypeOf('string');
        expect(enriched.description).not.toContain('Mehr als 45.000 vermietete Wohnungen');
      },
      TEST_TIMEOUT,
    );
  });

  describe('priceTracking', () => {
    it('reads the Gesamtmiete, the figure the search card shows', () => {
      const html = fs.readFileSync(path.join(FIXTURES, 'gagKoeln_detail.html'), 'utf8');
      expect(Math.round(provider.config.priceTracking.extract(html))).toBe(810);
    });

    it('returns null for a page without it', () => {
      expect(provider.config.priceTracking.extract('<html><body></body></html>')).toBeNull();
    });
  });
});
