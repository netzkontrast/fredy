/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Wunderflats, a portal for furnished flats rented for a limited time (Wohnen auf Zeit).
 *
 * Users paste a city search such as https://wunderflats.com/de/moeblierte-wohnungen-auf-zeit/koeln
 * (the English https://wunderflats.com/de/furnished-apartments/koeln redirects there), optionally
 * with the site's own filters, e.g. `?minPrice=800&maxPrice=1500&minSize=40`.
 *
 * The search page is rendered on the server and carries its results as JSON in
 * `<script id="data-hydrant">`, so a plain request is enough and no browser is needed. The JSON API
 * behind the site is not used: robots.txt disallows `/api/*` (checked 2026-09-15). It also
 * disallows URLs with `from=`, `accommodates` or `minAccommodates`, so search URLs carrying a move-in
 * date or a guest count should not be used with this provider.
 *
 * Only the first result page is read. Wunderflats orders by relevance and offers no "newest first"
 * sort in the URL, so narrow searches (price, size) work best.
 *
 * Prices in the payload are in cents and are the all-inclusive monthly rent.
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://wunderflats.com/';

/** The path every listing page lives under; the slug in front of the id is required, see readLinks. */
const LISTING_PATH = 'de/moebliertes-apartment/';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/**
 * Parse the `data-hydrant` JSON the server embeds in every page.
 *
 * @param {cheerio.CheerioAPI} $
 * @returns {any|null}
 */
function readHydrant($) {
  const payload = $('script#data-hydrant').first().text();
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch (error) {
    logger.error('Could not parse Wunderflats data-hydrant.', error?.message || error);
    return null;
  }
}

/**
 * Map listing ids to the links of the result cards.
 *
 * The payload has no slug, and a link with a made-up slug is answered with a 301 to the canonical
 * one, which the activity probe (it does not follow redirects) would read as a dead listing. The
 * cards in the same page carry the canonical link, so that one is used.
 *
 * @param {cheerio.CheerioAPI} $
 * @returns {Map<string, string>}
 */
function readLinks($) {
  const links = new Map();
  $(`a[href*="/${LISTING_PATH}"]`).each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const url = new URL(href, BASE_URL);
    const id = url.pathname.split('/').filter(Boolean).pop();
    if (id && !links.has(id)) {
      links.set(id, `${url.origin}${url.pathname}`);
    }
  });
  return links;
}

/**
 * A price in cents as whole euros.
 *
 * @param {number|null|undefined} cents
 * @returns {number|null}
 */
function centsToEuro(cents) {
  return typeof cents === 'number' && Number.isFinite(cents) ? Math.round(cents / 100) : null;
}

/**
 * @param {{street?: string, zipCode?: string, city?: string}|undefined} address
 * @returns {string}
 */
function buildAddress(address) {
  const cityLine = [address?.zipCode, address?.city].filter(Boolean).join(' ');
  return [address?.street, cityLine].filter(Boolean).join(', ');
}

/**
 * Fetch the search page and read the listings out of its embedded JSON.
 *
 * @param {string} url The job's search URL.
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'de-DE,de;q=0.9' },
  });
  if (!response.ok) {
    logger.error(`Error fetching data from Wunderflats: ${response.status} ${response.statusText}`);
    return [];
  }

  const $ = cheerio.load(await response.text());
  const items = readHydrant($)?.pageData?.listingResults?.items;
  if (!Array.isArray(items)) {
    logger.error('Wunderflats returned a page without listing results. The search URL may be wrong.');
    return [];
  }

  const links = readLinks($);
  return items.map((item) => {
    const [longitude, latitude] = item.address?.location?.coordinates ?? [];
    return {
      id: item._id,
      title: item.title?.de || item.title?.en,
      link: links.get(item._id) ?? null,
      price: centsToEuro(item.price),
      size: item.area,
      rooms: item.rooms,
      address: buildAddress(item.address),
      image: item.coverImage?.urls?.large ?? item.coverImage?.urls?.original ?? null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
    };
  });
}

/**
 * Read the full description and the postcode from the listing page's embedded JSON.
 *
 * The record also holds landlord and contact person ids; those are not read.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing) {
  if (!listing.link) return listing;
  try {
    const response = await fetch(listing.link, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'de-DE,de;q=0.9' },
    });
    if (!response.ok) return listing;

    const detail = readHydrant(cheerio.load(await response.text()))?.pageData?.listing;
    if (!detail) return listing;

    const description = (detail.descriptionV2?.de || detail.descriptionV2?.en || '').trim();
    const address = buildAddress(detail.address);
    return {
      ...listing,
      description: description || listing.description,
      address: address || listing.address,
    };
  } catch (error) {
    logger.warn(`Could not fetch Wunderflats detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  return {
    id: buildHash(o.id, o.price),
    link: o.link,
    title: (o.title || '').trim(),
    price: extractNumber(o.price),
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: o.address,
    image: o.image,
    description: o.description,
    latitude: o.latitude ?? null,
    longitude: o.longitude ?? null,
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
  url: null,
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address'],
  // The results come from the embedded JSON rather than the markup, so there is nothing to crawl.
  crawlContainer: null,
  crawlFields: {},
  // Wunderflats has no date sort in the URL.
  sortByDateParam: null,
  // ?minPrice=800&maxPrice=1500, in whole euros.
  priceRangeParams: { min: 'minPrice', max: 'maxPrice' },
  getListings,
  normalize,
  fetchDetails,
  activityProbe: checkIfListingIsActive,
  priceTracking: {
    /**
     * `price` is the monthly rent in cents, the same figure the search shows.
     *
     * @param {string} html
     * @returns {number|null}
     */
    extract: (html) => centsToEuro(readHydrant(cheerio.load(html))?.pageData?.listing?.price),
  },
};

export const metaInformation = {
  countries: ['de'],
  name: 'Wunderflats',
  baseUrl: BASE_URL,
  id: 'wunderflats',
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

export { config };
