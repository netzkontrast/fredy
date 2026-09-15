/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, expect } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as provider from '../../lib/provider/vonovia.js';

/** Run-scoped provider config, built per test via createConfig(). */
let runConfig;

// Vonovia uses a JSON API (fetch-based, no browser), like Deutsche Wohnen on the same platform.
const TEST_TIMEOUT = 120_000;

describe('#vonovia provider testsuite()', () => {
  runConfig = provider.createConfig(providerConfig.vonovia, [], []);

  let liveListings;

  it(
    'should test vonovia provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = {
        id: 'vonovia',
        notificationAdapter: null,
        spatialFilter: null,
        specFilter: null,
      };

      const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);

      liveListings = await fredy.execute();

      if (liveListings == null || liveListings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(liveListings).toBeInstanceOf(Array);
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('vonovia');

      const hasValidNotification = notificationObj.payload.some((notify) => {
        return (
          typeof notify.id === 'string' &&
          typeof notify.price === 'string' &&
          notify.price.includes('€') &&
          typeof notify.size === 'string' &&
          notify.size.includes('m²') &&
          typeof notify.title === 'string' &&
          notify.title !== '' &&
          typeof notify.link === 'string' &&
          notify.link.startsWith('https://www.vonovia.de/zuhause-finden/immobilien/') &&
          typeof notify.address === 'string' &&
          notify.address !== ''
        );
      });

      expect(hasValidNotification).toBe(true);
    },
    TEST_TIMEOUT,
  );

  describe('convertWebToApi', () => {
    it('turns the search page into the list endpoint, keeping the search', () => {
      const api = new URL(
        provider.convertWebToApi(
          'https://www.vonovia.de/zuhause-finden/immobilien?rentType=miete&city=K%C3%B6ln&perimeter=5&immoType=wohnung',
        ),
      );

      expect(api.origin + api.pathname).toBe('https://www.vonovia.de/api/real-estate/list');
      expect(api.searchParams.get('city')).toBe('Köln');
      expect(api.searchParams.get('rentType')).toBe('miete');
    });

    it('caps the page size at what the endpoint accepts', () => {
      const api = new URL(
        provider.convertWebToApi('https://www.vonovia.de/zuhause-finden/immobilien?city=Köln&limit=100'),
      );

      expect(api.searchParams.get('limit')).toBe('50');
    });

    it('caps it on a pasted API url too, which is passed through otherwise', () => {
      const api = new URL(provider.convertWebToApi('https://www.vonovia.de/api/real-estate/list?city=Köln&limit=100'));

      expect(api.pathname).toBe('/api/real-estate/list');
      expect(api.searchParams.get('limit')).toBe('50');
    });

    it('leaves a page size below the cap alone', () => {
      const api = new URL(
        provider.convertWebToApi('https://www.vonovia.de/zuhause-finden/immobilien?city=Köln&limit=15'),
      );

      expect(api.searchParams.get('limit')).toBe('15');
    });
  });

  describe('getListings', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** A page of rows in the shape the API returns them. */
    const rows = (from, count, overrides = {}) =>
      Array.from({ length: count }, (_, index) => ({
        wrk_id: `wrk-${from + index}`,
        vermarktungsart_miete: '1',
        titel: 'Wohnung',
        preis: 700,
        groesse: 60,
        anzahl_zimmer: 2,
        slug: `slug-${from + index}`,
        strasse: 'Riehler Str. 1',
        plz: '50735',
        ort: 'Köln OT Riehl',
        lat: 0,
        lng: 0,
        ...overrides,
      }));

    const apiUrl = () => provider.convertWebToApi('https://www.vonovia.de/zuhause-finden/immobilien?city=Köln');

    it('walks the pages the cap leaves behind', async () => {
      const offsets = [];
      globalThis.fetch = async (url) => {
        const offset = Number.parseInt(new URL(url).searchParams.get('offset') ?? '0', 10);
        offsets.push(offset);
        return {
          ok: true,
          json: async () => ({ paging: { info: { count: 62, limit: 50 } }, results: rows(offset, offset ? 12 : 50) }),
        };
      };

      const listings = await provider.config.getListings(apiUrl());

      expect(offsets).toEqual([0, 50]);
      expect(listings).toHaveLength(62);
    });

    it('keeps the pages it already has when a later one fails', async () => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return calls === 1
          ? { ok: true, json: async () => ({ paging: { info: { count: 62, limit: 50 } }, results: rows(0, 50) }) }
          : { ok: false, status: 406, statusText: 'Not Acceptable' };
      };

      const listings = await provider.config.getListings(apiUrl());

      expect(listings).toHaveLength(50);
    });

    it('drops rows that are not offered for rent', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          paging: { info: { count: 2, limit: 50 } },
          results: [...rows(0, 1), ...rows(1, 1, { vermarktungsart_miete: '0' })],
        }),
      });

      const listings = await provider.config.getListings(apiUrl());

      expect(listings.map((listing) => listing.id)).toEqual(['wrk-0']);
    });

    it('builds the detail link and the address from the row', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ paging: { info: { count: 1, limit: 50 } }, results: rows(0, 1) }),
      });

      const [listing] = await provider.config.getListings(apiUrl());

      expect(listing.link).toBe('https://www.vonovia.de/zuhause-finden/immobilien/slug-0');
      expect(listing.address).toBe('Riehler Str. 1, 50735 Köln OT Riehl');
    });
  });

  describe('normalize', () => {
    it('treats the 0/0 position the API sends for unknown coordinates as no position', () => {
      const listing = provider.config.normalize({ id: 'x', price: 704.06, latitude: 0, longitude: 0 });

      expect(listing.price).toBe(704);
      expect(listing.latitude).toBeNull();
      expect(listing.longitude).toBeNull();
    });
  });

  describe('with provider_details enabled', () => {
    it(
      'should enrich listings with details',
      async () => {
        if (!liveListings?.length) throw new Error('No listings from first test to enrich');

        const enriched = await runConfig.fetchDetails(liveListings[0]);

        expect(enriched).toBeTruthy();
        expect(enriched.link).toContain('https://www.vonovia.de/');
        expect(enriched.address).toBeTypeOf('string');
        expect(enriched.address).not.toBe('');
        if (enriched.description != null) {
          expect(enriched.description).toBeTypeOf('string');
          expect(enriched.description).not.toMatch(/contactPhone|contactEmail/);
        }
      },
      TEST_TIMEOUT,
    );
  });
});
