/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * GAG Immobilien AG, Cologne's municipal housing company.
 *
 * Users paste https://www.gag-koeln.de/immobiliensuche/wohnung-mieten. The page (a TYPO3
 * `mindshape_real_estate` list) renders its first page of flats server-side, so a plain `fetch`
 * is enough and no browser is needed. The WBS landing page (/wbs-wohnungen) is editorial content
 * only and links to this very search, so it is not a listing source of its own.
 *
 * Filters, sorting and paging are only reachable through the page's `realestate.json` XHR, whose
 * URLs carry a `cHash` and are disallowed by gag-koeln.de's robots.txt (checked 2026-09-15). This
 * provider therefore reads the server-rendered first page only and leaves the XHR alone. Detail
 * pages (/immobiliensuche/<objectnumber>) are allowed.
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import logger from '../services/logger.js';
import { extractNumber } from '../utils/extract-number.js';
import { parse } from '../services/extractor/parser/parser.js';
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
 * Description sections of the detail page that are about the flat. "Sonstiges" is the same
 * company blurb on every listing and would only feed the blacklist noise.
 */
const DESCRIPTION_SECTIONS = ['Beschreibung', 'Ausstattung', 'Lage'];

/**
 * Collapse whitespace; the markup breaks addresses over several lines.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function cleanText(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * Fetch a gag-koeln.de page as text.
 *
 * @param {string} url
 * @returns {Promise<string|null>} The HTML, or null when the site did not answer with 2xx.
 */
async function fetchHtml(url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    logger.error('Error fetching GAG Köln page:', response.status, response.statusText);
    return null;
  }
  return response.text();
}

/**
 * Read the server-rendered listing cards of the search page.
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
  return parse(config.crawlContainer, config.crawlFields, html, url) ?? [];
}

/**
 * The value cells of the "Objektdaten" entry with the given label.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} label
 * @returns {string[]}
 */
function objectData($, label) {
  const item = $('.nbp__info__item')
    .filter((_, el) => cleanText($(el).find('.nbp__info__label').text()) === label)
    .first();
  return item
    .find('.nbp__info__text')
    .toArray()
    .map((el) => cleanText($(el).text()))
    .filter(Boolean);
}

/**
 * Builds the description out of the detail page's "Objektbeschreibung" block.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function buildDescription($) {
  const parts = [];
  $('.ad__description > div').each((_, el) => {
    const heading = cleanText($(el).find('h3').first().text());
    const text = $(el).find('p').text().trim();
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
    const address = objectData($, 'Adresse').join(', ');
    const district = objectData($, 'Bezirk')[0];

    return {
      ...listing,
      address: address ? [address, district].filter(Boolean).join(' ') : listing.address,
      description: [description, listing.description].filter(Boolean).join('\n\n') || listing.description,
    };
  } catch (error) {
    logger.warn(`Could not fetch GAG Köln detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const price = extractNumber(o.price);
  const facilities = cleanText(o.description);
  return {
    id: buildHash(o.id, o.price),
    link: o.link ? new URL(o.link, metaInformation.baseUrl).href : metaInformation.baseUrl,
    title: cleanText(o.title) || '',
    price: price != null ? Math.round(price) : null,
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: cleanText(o.address),
    image: o.image ? new URL(o.image, metaInformation.baseUrl).href : null,
    description: facilities ? `Merkmale: ${facilities}` : null,
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
  crawlContainer: '.af__grid > .appartment',
  // The list is already ordered "Aktuellste zuerst"; sorting is only reachable through the XHR.
  sortByDateParam: null,
  // The price filter is posted to the robots-disallowed XHR, never spelled in the page URL.
  priceRangeParams: null,
  waitForSelector: null,
  crawlFields: {
    id: 'a.btn@href',
    link: 'a.btn@href',
    title: '.appartment__header | trim',
    // Gesamtmiete (warm rent) is the only price the card shows.
    price: '.appartment__details__item:has(small:contains("Gesamtmiete")) .h4 | trim',
    size: '.appartment__details__item:has(small:contains("Wohnfläche")) .h4 | trim',
    rooms: '.appartment__details__item:has(small:contains("Zimmer")) .h4 | trim',
    address: '.appartment__address | trim',
    image: '.appartment__img img@data-src',
    description: '.appartment__facilities | trim',
  },
  normalize,
  getListings,
  fetchDetails,
  activityProbe: checkIfListingIsActive,
  priceTracking: {
    /**
     * The detail page lists Nettokaltmiete, Nebenkosten, Heizkosten and Gesamtmiete; only
     * Gesamtmiete matches the figure on the search card.
     *
     * @param {string} html
     * @returns {number|null}
     */
    extract: (html) => {
      const [raw] = objectData(cheerio.load(html), 'Gesamtmiete');
      return extractNumber(raw ?? null);
    },
  },
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
  name: 'GAG Köln',
  baseUrl: 'https://www.gag-koeln.de/',
  id: 'gagKoeln',
};

export { config };
