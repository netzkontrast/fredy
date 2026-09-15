/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, expect } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as provider from '../../lib/provider/vebowag.js';

// VEBOWAG's offers come from Immomio's homepage GraphQL endpoint (fetch-based, no browser).
const TEST_TIMEOUT = 120_000;

describe('#vebowag provider testsuite()', () => {
  it(
    'should test vebowag provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = { id: 'vebowag', notificationAdapter: null, spatialFilter: null, specFilter: null };
      const runConfig = provider.createConfig(providerConfig.vebowag, []);

      const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);
      const listings = await fredy.execute();

      if (listings == null || listings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(listings).toBeInstanceOf(Array);
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('vebowag');
      notificationObj.payload.forEach((notify) => {
        expect(notify.id).toBeTypeOf('string');
        expect(notify.price).toContain('€');
        expect(notify.size).toContain('m²');
        expect(notify.title).not.toBe('');
        expect(notify.link).toMatch(/^https:\/\/tenant\.immomio\.com\/apply\//);
        expect(notify.address).toBeTypeOf('string');
        expect(notify.address).not.toBe('');
      });
    },
    TEST_TIMEOUT,
  );

  describe('tokenFromUrl', () => {
    it('uses the token vebowag.de embeds when the search page is pasted', () => {
      expect(provider.tokenFromUrl('https://www.vebowag.de/wohnungen/wohnungssuche/')).toBe(provider.VEBOWAG_TOKEN);
    });

    it('reads the token of a pasted widget url', () => {
      expect(provider.tokenFromUrl('https://homepage.immomio.com/de/properties?token=abc.def.ghi')).toBe('abc.def.ghi');
    });
  });

  describe('getListings', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** One node in the shape the endpoint returns it. */
    const node = (index, overrides = {}) => ({
      name: `Wohnung ${index}`,
      totalRooms: 2,
      size: 60.5,
      totalRentGross: 799.5,
      externalId: `ext-${index}`,
      applicationLink: `https://tenant.immomio.com/apply/uuid-${index}`,
      marketingType: 'RENT',
      titleImage: { url: `https://img.example/${index}.jpg` },
      address: {
        city: 'Bonn',
        street: 'Kolpingstr.',
        houseNumber: '12',
        zipCode: '53121',
        district: 'Bonn',
        coordinates: { lat: 50.73, lon: 7.06 },
      },
      showAddress: true,
      ...overrides,
    });

    const answer = (nodes, page, totalPages) => ({
      ok: true,
      json: async () => ({ data: { propertyList: { page: { page, totalPages }, nodes } } }),
    });

    it('walks every page the endpoint reports', async () => {
      const pages = [];
      globalThis.fetch = async (url, init) => {
        const { page } = JSON.parse(init.body).variables.input;
        pages.push(page);
        return answer([node(page)], page, 2);
      };

      const listings = await provider.config.getListings('https://www.vebowag.de/wohnungen/wohnungssuche/');

      expect(pages).toEqual([0, 1]);
      expect(listings.map((listing) => listing.id)).toEqual(['ext-0', 'ext-1']);
    });

    it('sends the token of the pasted url', async () => {
      let token;
      globalThis.fetch = async (url, init) => {
        token = JSON.parse(init.body).variables.input.token;
        return answer([], 0, 0);
      };

      await provider.config.getListings('https://homepage.immomio.com/de/properties?token=abc.def.ghi');

      expect(token).toBe('abc.def.ghi');
    });

    it('stops on a GraphQL error instead of throwing', async () => {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'nope' }] }) });

      await expect(provider.config.getListings('https://www.vebowag.de/')).resolves.toEqual([]);
    });

    it('leaves the street out when the landlord hides it', async () => {
      globalThis.fetch = async () => answer([node(0), node(1, { showAddress: false })], 0, 1);

      const [shown, hidden] = await provider.config.getListings('https://www.vebowag.de/');

      expect(shown.address).toBe('Kolpingstr. 12, 53121 Bonn');
      expect(hidden.address).toBe('53121 Bonn');
    });
  });

  describe('normalize', () => {
    it('rounds the gross rent and keeps the coordinates', () => {
      const listing = provider.config.normalize({ id: 'x', price: 818.85, latitude: 50.7, longitude: 7.1 });

      expect(listing.price).toBe(819);
      expect(listing.latitude).toBe(50.7);
      expect(listing.longitude).toBe(7.1);
    });
  });
});
