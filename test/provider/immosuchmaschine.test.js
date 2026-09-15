/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { get } from '../mocks/mockNotification.js';
import { mockFredy, providerConfig } from '../utils.js';
import { expect } from 'vitest';
import * as provider from '../../lib/provider/immosuchmaschine.js';

describe('#immosuchmaschine testsuite()', () => {
  it('should test immosuchmaschine provider', async () => {
    const Fredy = await mockFredy();
    const mockedJob = {
      id: 'immosuchmaschine',
      notificationAdapter: null,
      spatialFilter: null,
      specFilter: null,
    };
    const runConfig = provider.createConfig(providerConfig.immosuchmaschine, []);

    const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);

    const listing = await fredy.execute();

    if (listing == null || listing.length === 0) {
      throw new Error('Listings is empty!');
    }

    expect(listing).toBeInstanceOf(Array);
    const notificationObj = get();
    expect(notificationObj).toBeTypeOf('object');
    expect(notificationObj.serviceName).toBe('immosuchmaschine');
    notificationObj.payload.forEach((notify) => {
      expect(notify.id).toBeTypeOf('string');
      expect(notify.price).toBeTypeOf('string');
      expect(notify.price).toContain('€');
      expect(notify.size).toBeTypeOf('string');
      expect(notify.size).toContain('m²');
      expect(notify.title).toBeTypeOf('string');
      expect(notify.title).not.toBe('');
      expect(notify.link).toMatch(/^https:\/\/www\.immosuchmaschine\.de\/expose\/\d+$/);
      expect(notify.address).toBeTypeOf('string');
      expect(notify.address).not.toBe('');
      expect(notify.address).not.toContain('·');
    });
  });

  describe('normalize', () => {
    it('strips the object type from the address and drops the placeholder image', () => {
      const listing = provider.config.normalize({
        id: 'item_59442445',
        title: 'Helle Wohnung',
        price: '€ 1.989,-',
        size: '45 m²',
        rooms: '2',
        address: 'Vogelsanger Straße 185, 50825 Ehrenfeld · Wohnung mieten',
        image: 'https://www.immosuchmaschine.de/resources/img/placeholder-img-03.png',
        link: 'https://www.immosuchmaschine.de/expose/59442445',
        description: 'Text',
      });

      expect(listing.address).toBe('Vogelsanger Straße 185, 50825 Ehrenfeld');
      expect(listing.image).toBeNull();
      expect(listing.price).toBe(1989);
      expect(listing.size).toBe(45);
      expect(listing.rooms).toBe(2);
      expect(listing.link).toBe('https://www.immosuchmaschine.de/expose/59442445');
    });
  });
});
