/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFile } from 'fs/promises';
import { afterEach, expect } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as provider from '../../lib/provider/vivawest.js';

// Vivawest pages are fetched directly (no browser).
const TEST_TIMEOUT = 120_000;

const fixture = (name) => readFile(new URL(`../testFixtures/${name}`, import.meta.url), 'utf-8');

describe('#vivawest provider testsuite()', () => {
  const runConfig = provider.createConfig(providerConfig.vivawest, []);
  let liveListings;

  it(
    'should test vivawest provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = { id: 'vivawest', notificationAdapter: null, spatialFilter: null, specFilter: null };
      const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);

      liveListings = await fredy.execute();

      if (liveListings == null || liveListings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(liveListings).toBeInstanceOf(Array);
      const notificationObj = get();
      expect(notificationObj.serviceName).toBe('vivawest');
      notificationObj.payload.forEach((notify) => {
        expect(notify.id).toBeTypeOf('string');
        expect(notify.price).toContain('€');
        expect(notify.size).toContain('m²');
        expect(notify.title).not.toBe('');
        expect(notify.link).toMatch(/^https:\/\/www\.vivawest\.de\/mieten\/objekt\/[^/]+\/show$/);
        expect(notify.address).not.toBe('');
      });
    },
    TEST_TIMEOUT,
  );

  describe('pageUrl', () => {
    it('keeps the filter path and asks for the newest offers first', () => {
      const url = new URL(provider.pageUrl('https://www.vivawest.de/mieten/results/filter/query~Essen?cHash=abc', 1));

      expect(url.pathname).toBe('/mieten/results/filter/query~Essen');
      expect(url.searchParams.get('cHash')).toBe('abc');
      expect(url.searchParams.get('tx_immobilien_result[order]')).toBe('lastUpdated');
    });

    it('appends the page, replacing one already pasted', () => {
      expect(
        new URL(provider.pageUrl('https://www.vivawest.de/mieten/results/filter/query~Essen/page/2', 3)).pathname,
      ).toBe('/mieten/results/filter/query~Essen/page/3');
    });

    it('pages the unfiltered search under /results', () => {
      expect(new URL(provider.pageUrl('https://www.vivawest.de/mieten', 2)).pathname).toBe('/mieten/results/page/2');
    });

    it('leaves a chosen order alone', () => {
      const url = new URL(
        provider.pageUrl('https://www.vivawest.de/mieten?tx_immobilien_result%5Border%5D=kaltmieteASC', 1),
      );
      expect(url.searchParams.get('tx_immobilien_result[order]')).toBe('kaltmieteASC');
    });
  });

  describe('parseResultPage', () => {
    it('reads the cards and the last page of the recorded search', async () => {
      const { listings, lastPage } = provider.parseResultPage(await fixture('vivawest.html'));

      expect(listings).toHaveLength(15);
      expect(lastPage).toBe(2);
      const [first] = listings;
      expect(first.id).toMatch(/^[\d-]+-M$/);
      expect(first.link).toBe(`https://www.vivawest.de/mieten/objekt/${first.id}/show`);
      expect(first.address).toMatch(/^.+, \d{5} .+$/);
      expect(provider.config.normalize(first).price).toBeGreaterThan(0);
      expect(provider.config.normalize(first).size).toBeGreaterThan(0);
      expect(first.image).toMatch(/^https:\/\/www\.vivawest\.de\//);
    });
  });

  describe('getListings', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('stops when a page past the last one repeats the listings', async () => {
      const html = await fixture('vivawest.html');
      const requested = [];
      globalThis.fetch = async (url) => {
        requested.push(String(url));
        // Serve the same page twice, as the site does for a page past the end, and claim more pages.
        return { ok: true, text: async () => html.replaceAll('/page/2', '/page/9') };
      };

      const listings = await provider.config.getListings('https://www.vivawest.de/mieten/results/filter/query~Essen');

      expect(requested).toHaveLength(2);
      expect(listings).toHaveLength(15);
    });
  });

  describe('price', () => {
    it('reads the Kaltmiete off the detail page', async () => {
      expect(provider.config.priceTracking.extract(await fixture('vivawest_detail.html'))).toBe(533);
    });

    it('reads the Kaltmiete bounds out of the filter path', () => {
      expect(
        provider.config.priceRangeParams.parse(
          'https://www.vivawest.de/mieten/results/filter/kaltmiete.to~600,query~Essen?cHash=x',
        ),
      ).toEqual({ min: null, max: '600' });
    });
  });

  describe('with provider_details enabled', () => {
    it(
      'should enrich listings with details',
      async () => {
        if (!liveListings?.length) throw new Error('No listings from first test to enrich');

        const enriched = await runConfig.fetchDetails(liveListings[0]);

        expect(enriched.link).toContain('https://www.vivawest.de/');
        expect(enriched.title).not.toBe('');
        expect(enriched.description).toBeTypeOf('string');
        expect(enriched.description).toContain('Beschreibung');
      },
      TEST_TIMEOUT,
    );
  });
});
