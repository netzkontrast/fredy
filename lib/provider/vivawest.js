/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Vivawest, a large residential landlord in North Rhine-Westphalia.
 *
 * The rental search at https://www.vivawest.de/mieten is a TYPO3 extension that renders its results
 * on the server: fifteen `.property-list-item` cards per page, each carrying the expose number, the
 * address, Kaltmiete, Wohnfläche and Zimmer. A search is addressed by its path, e.g.
 * `/mieten/results/filter/kaltmiete.to~600,query~Essen`, and further pages append `/page/N`. The
 * `cHash` query parameter the site adds is not needed to read the page, but is kept when pasted.
 *
 * robots.txt only disallows `/typo3/` (checked 2026-09-15) and the site answers plain requests
 * without any bot wall, so no browser is launched: search and detail pages are fetched directly.
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf, sleep } from '../utils.js';
import logger from '../services/logger.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.vivawest.de';

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'de-DE,de;q=0.9',
};

/** The query parameter the result list reads its order from. */
const ORDER_PARAM = 'tx_immobilien_result[order]';

/**
 * How many result pages one run reads. A search over all of NRW currently spans four pages, so the
 * cap only guards against a page that keeps linking further.
 */
const MAX_PAGES = 20;

/** Pause between two result pages, jittered. */
const PAGE_DELAY_MS = 400;
const PAGE_JITTER_MS = 300;

/**
 * Address the nth result page of a search.
 *
 * A page number already on the pasted URL is dropped first. The unfiltered `/mieten` search pages
 * under `/mieten/results/page/N`, so that segment is added when it is missing. If no order was
 * chosen, newest offers are requested first.
 *
 * @param {string} url The search URL.
 * @param {number} page The result page, one based.
 * @returns {string} The URL of that page.
 */
export function pageUrl(url, page) {
  const parsed = new URL(url);
  parsed.hash = '';
  let pathname = parsed.pathname.replace(/\/page\/\d+\/?$/, '').replace(/\/+$/, '');
  if (page > 1) {
    if (pathname === '/mieten') pathname += '/results';
    pathname += `/page/${page}`;
  }
  parsed.pathname = pathname;
  if (!parsed.searchParams.has(ORDER_PARAM)) {
    parsed.searchParams.set(ORDER_PARAM, 'lastUpdated');
  }
  return parsed.toString();
}

/**
 * Makes a site-relative link absolute.
 *
 * @param {string|undefined} href
 * @returns {string|undefined}
 */
function absolute(href) {
  if (!href) return undefined;
  return new URL(href, BASE_URL).toString();
}

/**
 * Reads the value next to a `<dt>` label inside a card or a detail table.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {any} scope
 * @param {string} label
 * @returns {string|undefined}
 */
function valueFor($, scope, label) {
  const dt = $(scope)
    .find('dt')
    .filter((_, element) => $(element).text().trim() === label)
    .first();
  const text = dt.next('dd').text().replace(/\s+/g, ' ').trim();
  return text || undefined;
}

/**
 * Parses the listing cards of one result page.
 *
 * @param {string} html
 * @returns {{listings: any[], lastPage: number}}
 */
export function parseResultPage(html) {
  const $ = cheerio.load(html);
  const listings = [];

  $('.property-list-item[data-expose-nr]').each((_, card) => {
    const titleLink = $(card).find('a[rel="property-detail"]').first();
    const href = titleLink.attr('href');
    if (!href) return;

    // The card heading is the address, written as street and postcode/district on two lines.
    const addressLines = (titleLink.html() ?? '')
      .split(/<br\s*\/?>/i)
      .map((line) => cheerio.load(line).text().replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const address = addressLines.join(', ');
    const link = absolute(href.split('?')[0]);

    listings.push({
      id: $(card).attr('data-expose-nr'),
      link,
      title: address,
      address,
      price: valueFor($, card, 'Kaltmiete'),
      size: valueFor($, card, 'Wohnfläche'),
      rooms: valueFor($, card, 'Zimmer'),
      image: absolute($(card).find('.card-property-image img').first().attr('src')),
    });
  });

  let lastPage = 1;
  $('a[href*="/page/"]').each((_, anchor) => {
    const match = /\/page\/(\d+)/.exec($(anchor).attr('href') ?? '');
    if (match) lastPage = Math.max(lastPage, Number(match[1]));
  });

  return { listings, lastPage };
}

/**
 * Reads every result page of a search.
 *
 * A page number past the last one is answered with the last page again, so a page that brings no
 * new expose number ends the walk as well.
 *
 * @param {string} url The search URL.
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  const listings = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await sleep(PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS);

    const response = await fetch(pageUrl(url, page), { headers: REQUEST_HEADERS });
    if (!response.ok) {
      logger.error(`Error fetching Vivawest search page ${page}: ${response.status} ${response.statusText}`);
      break;
    }

    const { listings: cards, lastPage } = parseResultPage(await response.text());
    const fresh = cards.filter((card) => card.id && !seen.has(card.id));
    for (const card of fresh) seen.add(card.id);
    listings.push(...fresh);

    if (fresh.length === 0 || page >= lastPage) break;
  }

  return listings;
}

/**
 * Reads the text of one accordion section of the detail page, list items on their own lines.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} selector
 * @returns {string}
 */
function sectionText($, selector) {
  const section = $(selector).first();
  if (!section.length) return '';
  const parts = [];
  section.children().each((_, element) => {
    if (element.tagName === 'ul' || element.tagName === 'ol') {
      $(element)
        .find('li')
        .each((__, li) => {
          const text = $(li).text().replace(/\s+/g, ' ').trim();
          if (text) parts.push(`- ${text}`);
        });
    } else {
      const text = $(element).text().replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    }
  });
  return parts.join('\n');
}

/**
 * Reads the Kaltmiete from a detail page, the same figure the result card shows.
 *
 * @param {string} html
 * @returns {number|null}
 */
export function extractColdRent(html) {
  const $ = cheerio.load(html);
  return extractNumber(valueFor($, $('#property-price-table'), 'Kaltmiete') ?? valueFor($, $('body'), 'Kaltmiete'));
}

/**
 * Reads the JSON-LD record of a detail page.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {any|null}
 */
function readJsonLd($) {
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(script).text());
      if (data?.identifier || data?.address) return data;
    } catch {
      // not the record, try the next one
    }
  }
  return null;
}

/**
 * Enriches a listing with the description, the title and the position from its detail page.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing) {
  try {
    const response = await fetch(listing.link, { headers: REQUEST_HEADERS });
    if (!response.ok) return listing;

    const $ = cheerio.load(await response.text());
    const record = readJsonLd($);

    const parts = [
      ['Beschreibung', sectionText($, '#object-description-body')],
      ['Ausstattung', sectionText($, '#furniture-description-body')],
      ['Lage', sectionText($, '#location-description-body')],
    ]
      .filter(([, text]) => text)
      .map(([heading, text]) => `${heading}\n${text}`);
    const description = parts.join('\n\n').trim();

    const latitude = Number.parseFloat(record?.geo?.latitude);
    const longitude = Number.parseFloat(record?.geo?.longitude);

    return {
      ...listing,
      title: record?.name?.trim() || listing.title,
      description: description || listing.description,
      image: record?.image || listing.image,
      latitude: Number.isFinite(latitude) && latitude !== 0 ? latitude : listing.latitude,
      longitude: Number.isFinite(longitude) && longitude !== 0 ? longitude : listing.longitude,
    };
  } catch (error) {
    logger.warn(`Could not fetch Vivawest detail page for listing '${listing.id}'.`, error?.message || error);
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
    latitude: o.latitude,
    longitude: o.longitude,
  };
}

/**
 * @param {ParsedListing} o
 * @param {string[]} appliedBlackList Terms the job wants filtered out.
 * @returns {boolean}
 */
function applyBlacklist(o, appliedBlackList) {
  return !isOneOf(o.title, appliedBlackList) && !isOneOf(o.description, appliedBlackList);
}

/**
 * Reads the Kaltmiete bounds out of the filter path segment, e.g. `kaltmiete.to~600,query~Essen`.
 *
 * @param {string} url
 * @returns {{min: string|null, max: string|null}}
 */
function parsePriceRange(url) {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const from = /(?:^|[/,])kaltmiete\.from~(\d+(?:[.,]\d+)?)/.exec(pathname);
  const to = /(?:^|[/,])kaltmiete\.to~(\d+(?:[.,]\d+)?)/.exec(pathname);
  return { min: from?.[1] ?? null, max: to?.[1] ?? null };
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  // The order is set on the page URL by getListings, which also pages the search.
  sortByDateParam: null,
  priceRangeParams: { parse: parsePriceRange },
  crawlContainer: '.property-list-item[data-expose-nr]',
  crawlFields: {
    id: '@data-expose-nr',
    title: 'a[rel="property-detail"] | removeNewline | trim',
    link: 'a[rel="property-detail"]@href',
    address: 'a[rel="property-detail"] | removeNewline | trim',
    image: '.card-property-image img@src',
  },
  normalize,
  getListings,
  fetchDetails,
  activityProbe: checkIfListingIsActive,
  priceTracking: {
    extract: (html) => extractColdRent(html),
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
  name: 'Vivawest',
  baseUrl: 'https://www.vivawest.de/',
  id: 'vivawest',
};

export { config };
