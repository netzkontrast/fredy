/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as provider from '../../lib/provider/legWohnen.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testFixtures');

// LEG Wohnen serves its city pages without a fight, so this is a plain fetch, no browser.
const TEST_TIMEOUT = 120_000;

describe('#legWohnen provider testsuite()', () => {
  const runConfig = provider.createConfig(providerConfig.legWohnen, []);
  let liveListings;

  it(
    'should test legWohnen provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = { id: 'legWohnen', notificationAdapter: null, spatialFilter: null, specFilter: null };

      const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);
      liveListings = await fredy.execute();

      if (liveListings == null || liveListings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(liveListings).toBeInstanceOf(Array);
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('legWohnen');
      notificationObj.payload.forEach((notify) => {
        expect(notify.id).toBeTypeOf('string');
        expect(notify.price).toContain('€');
        expect(notify.size).toContain('m²');
        expect(notify.title).not.toBe('');
        expect(notify.link.startsWith('https://www.leg-wohnen.de/immobilien/detail/')).toBe(true);
        expect(notify.address).not.toBe('');
      });
    },
    TEST_TIMEOUT,
  );

  describe('parseListings', () => {
    it('reads price, size, rooms, address and image off the city page cards', () => {
      if (process.env.TEST_MODE !== 'offline') return;
      const listings = provider.parseListings(fs.readFileSync(path.join(FIXTURES, 'legWohnen.html'), 'utf8'));
      const listing = listings.find((l) => l.id === '477619');

      expect(listing).toBeTruthy();
      const normalized = provider.config.normalize(listing);
      expect(normalized.price).toBe(623);
      expect(normalized.size).toBe(51.95);
      expect(normalized.rooms).toBe(2);
      expect(normalized.link).toBe('https://www.leg-wohnen.de/immobilien/detail/1347-499-M');
      expect(normalized.address).toBe('Buschweg 41, 50829 Köln');
      expect(normalized.image).toMatch(/^https:\/\/www\.leg-wohnen\.de\/typo3temp\//);
    });

    it('returns nothing for a page without cards', () => {
      expect(provider.parseListings('<html><body></body></html>')).toEqual([]);
      expect(provider.parseListings(null)).toEqual([]);
    });
  });

  describe('detail page', () => {
    it('reads the Kaltmiete, not the Gesamtmiete, for price tracking', () => {
      if (process.env.TEST_MODE !== 'offline') return;
      const html = fs.readFileSync(path.join(FIXTURES, 'legWohnen_detail.html'), 'utf8');
      expect(provider.config.priceTracking.extract(html)).toBe(623);
    });

    it('builds the description from the text chapters', () => {
      if (process.env.TEST_MODE !== 'offline') return;
      const html = fs.readFileSync(path.join(FIXTURES, 'legWohnen_detail.html'), 'utf8');
      const description = provider.buildDescription(html);
      expect(description).toMatch(/^Objektbeschreibung\n/);
      expect(description).toContain('Lage und Wohnumfeld');
      expect(description).not.toContain('Gesamtmiete');
    });

    it(
      'should enrich listings with details',
      async () => {
        if (!liveListings?.length) throw new Error('No listings from first test to enrich');
        const enriched = await runConfig.fetchDetails(liveListings[0]);
        expect(enriched.link).toContain('https://www.leg-wohnen.de/');
        expect(enriched.description).toBeTypeOf('string');
        expect(enriched.description).not.toBe('');
      },
      TEST_TIMEOUT,
    );
  });
});
