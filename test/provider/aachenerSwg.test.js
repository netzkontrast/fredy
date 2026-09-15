/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFile } from 'fs/promises';
import { afterEach, expect } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as provider from '../../lib/provider/aachenerSwg.js';

// The result page is server-rendered but filtered and paged by POST, so it is fetched, not browsed.
const TEST_TIMEOUT = 120_000;

const fixture = (name) => readFile(new URL(`../testFixtures/${name}`, import.meta.url), 'utf-8');

describe('#aachenerSwg provider testsuite()', () => {
  it(
    'should test aachenerSwg provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = { id: 'aachenerSwg', notificationAdapter: null, spatialFilter: null, specFilter: null };
      const runConfig = provider.createConfig(providerConfig.aachenerSwg, []);

      const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);
      const listings = await fredy.execute();

      if (listings == null || listings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(listings).toBeInstanceOf(Array);
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('aachenerSwg');
      notificationObj.payload.forEach((notify) => {
        expect(notify.id).toBeTypeOf('string');
        expect(notify.size).toContain('m²');
        expect(notify.title).not.toBe('');
        expect(notify.link).toMatch(/^https:\/\/www\.aachener-swg\.de\/mieten\/liste-mietobjekte\/[0-9a-f-]+$/);
        expect(notify.address).toContain('Köln');
      });
    },
    TEST_TIMEOUT,
  );

  describe('buildFormBody', () => {
    it('carries the form fields of the pasted url over and nothing else', () => {
      const body = provider.buildFormBody(
        'https://www.aachener-swg.de/mieten/liste-mietobjekte?city=K%C3%B6ln&price-max=900&utm_source=x',
        1,
      );

      expect(body.get('city')).toBe('Köln');
      expect(body.get('price-max')).toBe('900');
      expect(body.has('utm_source')).toBe(false);
      expect(body.has('tx_aachener_exposelist[currentPage]')).toBe(false);
    });

    it('asks for later pages with the pagination field', () => {
      const body = provider.buildFormBody('https://www.aachener-swg.de/mieten/liste-mietobjekte?city=Bonn', 2);

      expect(body.get('tx_aachener_exposelist[currentPage]')).toBe('2');
    });
  });

  describe('parseListPage', () => {
    it('reads the cards and the next page out of the recorded page', async () => {
      const { rows, nextPage } = provider.parseListPage(await fixture('aachenerSwg.html'));

      expect(rows).toHaveLength(20);
      expect(nextPage).toBe(2);
      const flat = rows.find((row) => row.id === 'b41b8856-e095-4e31-986f-8ac49cdc9eec');
      expect(flat).toMatchObject({
        link: 'https://www.aachener-swg.de/mieten/liste-mietobjekte/b41b8856-e095-4e31-986f-8ac49cdc9eec',
        title: 'Schöne 3-Zimmerwohnung in Köln-Holweide',
        price: '885,00 €',
        rooms: '3',
      });
      expect(flat.image).toMatch(/^https:\/\/www\.aachener-swg\.de\/fileadmin\//);
    });

    it('reads the "–" placeholder as a missing fact', async () => {
      const { rows } = provider.parseListPage(await fixture('aachenerSwg.html'));
      const parking = rows.find((row) => /stellplatz/i.test(row.title));

      expect(parking.price).toBeNull();
      expect(parking.size).toBeNull();
      expect(parking.rooms).toBeNull();
    });
  });

  describe('getListings', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    const card = (id, facts) => `
      <div class="m-property-list__item"><div class="m-property-teaser">
        <span class="m-property-teaser__subtitle">Ringenstr. 36, 51067 Köln</span>
        <h2><a class="m-property-teaser__link" href="/mieten/liste-mietobjekte/${id}">Wohnung ${id}</a></h2>
        <div class="m-property-teaser__facts">${facts}</div>
      </div></div>`;
    const flatFacts =
      '<details><summary>Wohnfläche</summary>50 m²</details><details><summary>Zimmer</summary>2</details><details><summary>Warmmiete</summary>700,00 €</details>';
    const parkingFacts =
      '<details><summary>Wohnfläche</summary>–</details><details><summary>Zimmer</summary>–</details>';
    const page = (cards, next) =>
      `<html><body>${cards.join('')}${next ? `<ul><li class="m-pagination__next"><button value="${next}">Nächste</button></li></ul>` : ''}</body></html>`;

    it('walks the pages by posting the page field and drops parking spaces', async () => {
      const requested = [];
      globalThis.fetch = async (url, init) => {
        const body = new URLSearchParams(init.body);
        const number = body.get('tx_aachener_exposelist[currentPage]') ?? '1';
        requested.push({ url, city: body.get('city'), number });
        const html =
          number === '1' ? page([card('a', flatFacts), card('p', parkingFacts)], 2) : page([card('b', flatFacts)]);
        return { ok: true, text: async () => html };
      };

      const listings = await provider.config.getListings(
        'https://www.aachener-swg.de/mieten/liste-mietobjekte?city=K%C3%B6ln',
      );

      expect(requested.map((r) => r.number)).toEqual(['1', '2']);
      expect(requested.every((r) => r.url === 'https://www.aachener-swg.de/mieten/liste-mietobjekte')).toBe(true);
      expect(requested.every((r) => r.city === 'Köln')).toBe(true);
      expect(listings.map((listing) => listing.id)).toEqual(['a', 'b']);
    });

    it('stops when a page brings nothing new', async () => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return { ok: true, text: async () => page([card('a', flatFacts)], calls + 1) };
      };

      const listings = await provider.config.getListings('https://www.aachener-swg.de/mieten/liste-mietobjekte');

      expect(calls).toBe(2);
      expect(listings).toHaveLength(1);
    });
  });

  describe('detail page', () => {
    it('builds the description from the description columns', async () => {
      const description = provider.parseDescription(await fixture('aachenerSwg_detail.html'));

      expect(description).toContain('Ausstattung\nBad mit Tageslichtfenster');
      expect(description).toContain('Lage\nZentrale, überwiegend wohngeprägte Lage');
    });

    it('tracks the total rent, the figure the list shows as Warmmiete', async () => {
      expect(provider.extractPrice(await fixture('aachenerSwg_detail.html'))).toBe(885);
    });

    it('enriches a listing through the pipeline hook', async () => {
      const listing = {
        id: 'x',
        link: 'https://www.aachener-swg.de/mieten/liste-mietobjekte/b41b8856-e095-4e31-986f-8ac49cdc9eec',
        title: 'Schöne 3-Zimmerwohnung in Köln-Holweide',
      };
      const originalFetch = globalThis.fetch;
      const html = await fixture('aachenerSwg_detail.html');
      globalThis.fetch = async () => ({ ok: true, text: async () => html });
      try {
        const enriched = await provider.config.fetchDetails(listing);
        expect(enriched.description).toContain('Objekt');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
