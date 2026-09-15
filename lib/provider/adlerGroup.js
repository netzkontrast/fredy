/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Adler Group, a residential landlord with its stock mainly in Berlin and its surroundings.
 *
 * Users paste https://www.adler-group.com/suche/wohnung. The page (a TYPO3 `adler_everreal` list)
 * renders every flat on offer server-side in one page, so a plain `fetch` is enough.
 *
 * The site's city and room filters are only reachable by submitting the search form, whose request
 * carries a signed `__trustedProperties` token; a plain URL with filter parameters is ignored. This
 * provider therefore always reads the full list, and users narrow it with Fredy's own area and spec
 * filters. There is no price parameter at all.
 *
 * adler-group.com serves no robots.txt (404, checked 2026-09-15), so nothing is disallowed.
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import logger from '../services/logger.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9',
};

/**
 * The cost rows that add up to the price on the search card. The card shows the warm rent
 * (Kaltmiete + Nebenkosten + Heizkosten), not the Kaltmiete the detail page leads with.
 */
const RENT_COMPONENTS = ['Kaltmiete', 'Nebenkosten', 'Heizkosten'];

/** Detail page sections that describe the flat itself. */
const DESCRIPTION_SECTIONS = ['Beschreibung', 'Ausstattung', 'Lage', 'Zusatzinformationen'];

/**
 * Collapse whitespace; the markup breaks values over several lines.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function cleanText(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * Fetch an adler-group.com page as text.
 *
 * @param {string} url
 * @returns {Promise<string|null>} The HTML, or null when the site did not answer with 2xx.
 */
async function fetchHtml(url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    logger.error('Error fetching Adler Group page:', response.status, response.statusText);
    return null;
  }
  return response.text();
}

/**
 * The map's marker data, keyed by listing uid. It is the only place the page carries coordinates.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Map<string, {lat?: number, lon?: number}>}
 */
function readGeodata($) {
  const byUid = new Map();
  $('[data-geodata]').each((_, el) => {
    try {
      const markers = JSON.parse($(el).attr('data-geodata') ?? '[]');
      for (const marker of Array.isArray(markers) ? markers : []) {
        if (marker?.uid != null) byUid.set(String(marker.uid), marker);
      }
    } catch {
      // unreadable marker data only costs the coordinates
    }
  });
  return byUid;
}

/**
 * Read the listing tiles out of the search page.
 *
 * Each tile holds a table: street | size, postcode and city | rooms, map link | price.
 *
 * @param {string} html
 * @returns {any[]}
 */
export function parseListings(html) {
  const $ = cheerio.load(html);
  const geodata = readGeodata($);
  return $('.single-object-tile[data-object-id]')
    .toArray()
    .map((el) => {
      const tile = $(el);
      const uid = tile.attr('data-object-id');
      const rows = tile.find('.object-content-wrapper tr').toArray();
      const cell = (row, column) => cleanText($(rows[row]).find('td').eq(column).text());
      const image = /url\(['"]?([^'")]+)['"]?\)/.exec(tile.find('.single-object-preview-image').attr('style') ?? '');
      const marker = geodata.get(String(uid));
      return {
        id: uid,
        title: cleanText(tile.find('.object-headline h3').text()),
        link: tile.find('.object-headline a').attr('href') ?? null,
        size: cell(0, 1),
        rooms: cell(1, 1),
        price: cell(2, 1),
        address: [cell(0, 0), cell(1, 0)].filter(Boolean).join(', '),
        image: image?.[1] ?? null,
        latitude: marker?.lat,
        longitude: marker?.lon,
      };
    });
}

/**
 * Read the server-rendered listing tiles of the search page.
 *
 * Invoked by the pipeline with `this` bound to the executioner; nothing run-specific is read from
 * module scope.
 *
 * @param {string} url The search page URL.
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  const html = await fetchHtml(url);
  if (!html) return [];
  return parseListings(html);
}

/**
 * Builds the description out of the exposé's text tabs.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function buildDescription($) {
  const parts = [];
  $('.object-data-specs h3').each((_, el) => {
    const heading = cleanText($(el).text());
    const text = $(el).next('p').text().trim();
    if (heading != null && DESCRIPTION_SECTIONS.includes(heading) && text) {
      parts.push(`${heading}\n${text}`);
    }
  });
  return parts.join('\n\n').trim();
}

/**
 * Enrich a listing with the exposé text and the full address from its detail page.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>} The enriched listing, or the untouched one on any failure.
 */
async function fetchDetails(listing) {
  try {
    const html = await fetchHtml(listing.link);
    if (!html) return listing;
    const $ = cheerio.load(html);
    const description = buildDescription($);
    const address = $('.single-object-map-address .location-address-text')
      .toArray()
      .map((el) => cleanText($(el).text()))
      .filter(Boolean)
      .join(', ');
    return {
      ...listing,
      address: address || listing.address,
      description: description || listing.description,
    };
  } catch (error) {
    logger.warn(`Could not fetch Adler Group detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * Reads the warm rent off an exposé by adding up its cost rows, so it matches the search card.
 *
 * @param {string} html
 * @returns {number|null}
 */
function extractPrice(html) {
  const $ = cheerio.load(html);
  const costs = new Map();
  $('.expose-spec-value-wrapper tr').each((_, row) => {
    const cells = $(row).find('td');
    const label = cleanText(cells.eq(0).text());
    if (label != null && RENT_COMPONENTS.includes(label)) {
      costs.set(label, extractNumber(cleanText(cells.eq(1).text())));
    }
  });
  if (costs.get('Kaltmiete') == null) return null;
  return RENT_COMPONENTS.reduce((sum, label) => sum + (costs.get(label) ?? 0), 0);
}

/**
 * @param {number|string|null|undefined} value
 * @returns {number|null}
 */
function toCoordinate(value) {
  const number = value == null ? NaN : Number(value);
  return Number.isFinite(number) && number !== 0 ? number : null;
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const price = extractNumber(o.price);
  return {
    id: buildHash(o.id, o.price),
    link: o.link ? new URL(o.link, metaInformation.baseUrl).href : metaInformation.baseUrl,
    title: cleanText(o.title) || '',
    price: price != null ? Math.round(price) : null,
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: cleanText(o.address),
    image: o.image ?? null,
    description: o.description,
    latitude: toCoordinate(o.latitude),
    longitude: toCoordinate(o.longitude),
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
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image'],
  url: null,
  // Tiles are parsed in getListings(); the generic container parser is not used.
  crawlContainer: null,
  crawlFields: {},
  sortByDateParam: null,
  // Filters are posted with a signed form token and never appear in the page URL.
  priceRangeParams: null,
  waitForSelector: null,
  normalize,
  getListings,
  fetchDetails,
  activityProbe: checkIfListingIsActive,
  priceTracking: { extract: extractPrice },
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
  name: 'Adler Group',
  baseUrl: 'https://www.adler-group.com/',
  id: 'adlerGroup',
};

export { config };
