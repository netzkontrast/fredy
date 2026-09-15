/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Grand City Property (GCP), a large German residential landlord.
 *
 * Users run a search on https://www.grandcityproperty.de/wohnungssuche and paste the resulting URL,
 * e.g. `/wohnungssuche?city=Köln&cityText=Städte|Köln|Köln&type=M`. The result page renders every
 * card server-side (paging is done in the browser over those cards), so a plain `fetch` is enough.
 *
 * The city filter is keyed on `cityText`, the full autocomplete entry (`Städte|Köln|Köln`), and not on
 * `city`: a URL carrying only `city` gets unfiltered results back. The page renders at most 50 cards.
 *
 * grandcityproperty.de's robots.txt disallows nothing (checked 2026-09-15).
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

/** Detail page sections that describe the flat itself. */
const DESCRIPTION_SECTIONS = ['Objektbeschreibung', 'Ausstattung', 'Lage'];

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
 * Fetch a grandcityproperty.de page as text.
 *
 * @param {string} url
 * @returns {Promise<string|null>} The HTML, or null when the site did not answer with 2xx.
 */
async function fetchHtml(url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    logger.error('Error fetching Grand City Property page:', response.status, response.statusText);
    return null;
  }
  return response.text();
}

/**
 * The value of the card's "Fläche"/"Zimmer" entry.
 *
 * @param {import('cheerio').Cheerio<any>} card
 * @param {string} label
 * @returns {string|null}
 */
function cardValue(card, label) {
  const entry = card
    .find('.info-mid .additional-wrapper')
    .filter((_, el) => cleanText(card.find(el).find('.title').text()) === label)
    .first();
  return cleanText(entry.find('.value').text());
}

/**
 * Read the listing cards out of a search result page.
 *
 * @param {string} html
 * @returns {any[]}
 */
export function parseListings(html) {
  const $ = cheerio.load(html);
  return $('.real-estate-item[data-id]')
    .toArray()
    .map((el) => {
      const card = $(el);
      const titleLink = card.find('.info-top-left a').first();
      return {
        id: card.attr('data-id'),
        // The heading is cut off after ~45 characters, the link title carries it in full.
        title: cleanText(titleLink.attr('title')) ?? cleanText(card.find('.name_property').text()),
        link: cleanText(titleLink.attr('href') ?? card.attr('data-nice-url')),
        price: cleanText(card.find('.price').text()) ?? card.attr('data-price'),
        size: cardValue(card, 'Fläche'),
        rooms: cardValue(card, 'Zimmer'),
        address: cleanText(card.find('.address').text()),
        image: cleanText(card.attr('data-img')),
        latitude: cleanText(card.attr('data-lat')),
        longitude: cleanText(card.attr('data-lng')),
      };
    });
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
  return parseListings(html);
}

/**
 * Builds the description out of the detail page's text sections.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function buildDescription($) {
  const parts = [];
  $('.real-estate-detail-section .content').each((_, el) => {
    const heading = cleanText($(el).find('h2').first().text());
    const text = $(el)
      .find('p')
      .toArray()
      .map((p) =>
        $(p)
          .text()
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .join('\n'),
      )
      .filter(Boolean)
      .join('\n');
    if (heading != null && DESCRIPTION_SECTIONS.includes(heading) && text) {
      parts.push(`${heading}\n${text}`);
    }
  });
  return parts.join('\n\n').trim();
}

/**
 * Enrich a listing with the exposé text from its detail page.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>} The enriched listing, or the untouched one on any failure.
 */
async function fetchDetails(listing) {
  try {
    const html = await fetchHtml(listing.link);
    if (!html) return listing;
    const description = buildDescription(cheerio.load(html));
    return { ...listing, description: description || listing.description };
  } catch (error) {
    logger.warn(
      `Could not fetch Grand City Property detail page for listing '${listing.id}'.`,
      error?.message || error,
    );
    return listing;
  }
}

/**
 * Reads the Kaltmiete off a detail page, the figure the search card shows as "pro Monat kalt".
 *
 * @param {string} html
 * @returns {number|null}
 */
function extractPrice(html) {
  const $ = cheerio.load(html);
  const label = $('label')
    .filter((_, el) => cleanText($(el).text()) === 'Kaltmiete')
    .first();
  if (label.length === 0) return null;
  return extractNumber(cleanText(label.closest('.row').find('.col-5 label').first().text()));
}

/**
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
function toCoordinate(value) {
  const number = value == null ? NaN : Number.parseFloat(value);
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
    image: o.image ? new URL(o.image, metaInformation.baseUrl).href : null,
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
  // Cards are parsed in getListings(); the generic container parser is not used.
  crawlContainer: null,
  crawlFields: {},
  sortByDateParam: null,
  // The search form only has an upper rent bound: ?price=700
  priceRangeParams: { max: 'price' },
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
  name: 'Grand City Property',
  baseUrl: 'https://www.grandcityproperty.de/',
  id: 'grandCityProperty',
};

export { config };
