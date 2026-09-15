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
import * as provider from '../../lib/provider/adlerGroup.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testFixtures');

// Adler Group renders its whole offer on one server-side page, so the provider reads it with plain fetch.
const TEST_TIMEOUT = 120_000;

describe('#adlerGroup provider testsuite()', () => {
  const runConfig = provider.createConfig(providerConfig.adlerGroup, []);
  let liveListings;

  it(
    'should test adlerGroup provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = { id: 'adlerGroup', notificationAdapter: null, spatialFilter: null, specFilter: null };

      const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);
      liveListings = await fredy.execute();

      if (liveListings == null || liveListings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(liveListings).toBeInstanceOf(Array);
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('adlerGroup');
      notificationObj.payload.forEach((notify) => {
        expect(notify.id).toBeTypeOf('string');
        expect(notify.price).toContain('€');
        expect(notify.size).toContain('m²');
        expect(notify.title).not.toBe('');
        expect(notify.link).toMatch(/^https:\/\/www\.adler-group\.com\/expose\?.+/);
        expect(notify.address).toBeTypeOf('string');
        expect(notify.address).not.toBe('');
      });
    },
    TEST_TIMEOUT,
  );

  describe('getListings', () => {
    const originalFetch = globalThis.fetch;
    const listHtml = fs.readFileSync(path.join(FIXTURES, 'adlerGroup.html'), 'utf8');

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('reads every tile of the recorded page with its figures and position', async () => {
      globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => listHtml });

      const listings = (await provider.config.getListings(providerConfig.adlerGroup.url)).map(
        provider.config.normalize,
      );

      expect(listings).toHaveLength(25);
      const flat = listings.find((l) => l.link.includes('tx_adlereverreal_show%5Blisting%5D=639&'));
      expect(flat).toMatchObject({
        price: 2283,
        size: 129.54,
        rooms: 4,
        address: 'Röbellweg 4/6, 13125 Berlin',
        latitude: 52.6325588,
        longitude: 13.4775758,
      });
      expect(flat.link).toMatch(/^https:\/\/www\.adler-group\.com\/expose\?.*&cHash=[0-9a-f]+$/);
      expect(flat.title).toContain('4-Zimmer-Wohnung');
      expect(flat.image).toMatch(/^https:\/\/resources\.everreal\.co\/.+\.jpe?g$/);
    });

    it('returns nothing when the page cannot be loaded', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });

      expect(await provider.config.getListings(providerConfig.adlerGroup.url)).toEqual([]);
    });
  });

  describe('with provider_details enabled', () => {
    it(
      'should enrich listings with the exposé text',
      async () => {
        if (!liveListings?.length) throw new Error('No listings from first test to enrich');

        const enriched = await runConfig.fetchDetails(liveListings[0]);

        expect(enriched.link).toContain('https://www.adler-group.com/');
        expect(enriched.address).not.toBe('');
        expect(enriched.description).toBeTypeOf('string');
        // not every exposé fills every tab, listing 639 starts at Ausstattung
        expect(enriched.description).toMatch(/^(Beschreibung|Ausstattung|Lage|Zusatzinformationen)\n/);
      },
      TEST_TIMEOUT,
    );
  });

  describe('priceTracking', () => {
    it('adds the cost rows up to the warm rent the search tile shows', () => {
      const html = fs.readFileSync(path.join(FIXTURES, 'adlerGroup_detail.html'), 'utf8');
      // Kaltmiete 1.943 + Nebenkosten 220 + Heizkosten 120
      expect(provider.config.priceTracking.extract(html)).toBe(2283);
    });

    it('returns null for a page without a Kaltmiete', () => {
      expect(provider.config.priceTracking.extract('<html><body></body></html>')).toBeNull();
    });
  });
});
