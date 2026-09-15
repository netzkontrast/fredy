/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * immosuchmaschine.de provider, a meta search engine run by ImmobilienScout24.
 *
 * Users paste a search result page such as
 * https://www.immosuchmaschine.de/g/50667-koeln/wohnung-mieten, optionally narrowed with the page's
 * own filters (`price_from`, `price_to`, `size_from`, ...). The result list is server-rendered HTML,
 * so the cards are read with the regular crawlContainer/crawlFields parser.
 *
 * The site's robots.txt (checked 2026-09-15) only disallows `/merkliste`, so both the search pages and
 * the `/expose/<id>` pages the cards link to may be crawled. The expose page itself only links on to
 * the partner portal that published the ad, so there is no detail enrichment: the card already carries
 * everything the aggregator knows.
 */

import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

/** Card image shown when the partner delivered no photo. Not worth storing as the listing's image. */
const PLACEHOLDER_IMAGE = /\/resources\/img\/placeholder/;

/**
 * The card line reads `Street 1, 50825 Ehrenfeld · Wohnung mieten`; the part after the dot is the
 * object type, not the address.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function cleanAddress(raw) {
  if (!raw) return null;
  const address = raw.split('·')[0].trim();
  return address || null;
}

/**
 * Card values lead with their unit (`€ 1.989,-`), which `extractNumber` cannot read past.
 *
 * @param {string|null|undefined} raw
 * @returns {number|null}
 */
function readNumber(raw) {
  return raw == null ? null : extractNumber(String(raw).replace(/^\D+/, ''));
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const exposeId = String(o.id ?? '').replace(/^item_/, '');
  const link = o.link || `${metaInformation.baseUrl}/expose/${exposeId}`;
  return {
    id: buildHash(exposeId, o.price),
    link,
    title: o.title || '',
    price: readNumber(o.price),
    size: readNumber(o.size),
    rooms: readNumber(o.rooms),
    address: cleanAddress(o.address),
    image: o.image && !PLACEHOLDER_IMAGE.test(o.image) ? o.image : null,
    description: o.description,
  };
}

/**
 * @param {ParsedListing} o
 * @param {string[]} appliedBlackList Terms the job wants filtered out.
 * @returns {boolean}
 */
function applyBlacklist(o, appliedBlackList) {
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  return titleNotBlacklisted && descNotBlacklisted;
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  crawlContainer: 'ul.result-list > li.block_item',
  // newest first; the same spelling the page's own sort menu uses
  sortByDateParam: 'orderby=obj.created_date&sortmode=1',
  // ?price_from=500&price_to=1000
  priceRangeParams: { min: 'price_from', max: 'price_to' },
  waitForSelector: null,
  crawlFields: {
    id: '@id',
    title: '.data_title | removeNewline | trim',
    price: '.data_price dd | trim',
    size: '.data_size dd | trim',
    rooms: '.data_rooms dd | trim',
    address: '.data_zipcity | removeNewline | trim',
    description: '.data_desc | removeNewline | trim',
    image: '.data_photo img@src',
    link: 'a.objectLink[data-expose]@href',
  },
  normalize,
  // A removed expose answers with a redirect to `/expose`, which the tester reads as gone.
  activityProbe: checkIfListingIsActive,
};

/**
 * Build a run-scoped provider configuration.
 *
 * @param {{url: string, enabled?: boolean}} sourceConfig The job's entry for this provider.
 * @param {string[]} [blacklist] Terms to filter listings out by.
 * @returns {ProviderConfig} A configuration usable by a single pipeline run.
 */
export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url,
  filter: (listing) => applyBlacklist(listing, blacklist ?? []),
});

export const metaInformation = {
  countries: ['de'],
  name: 'immosuchmaschine.de',
  baseUrl: 'https://www.immosuchmaschine.de',
  id: 'immosuchmaschine',
};

export { config };
