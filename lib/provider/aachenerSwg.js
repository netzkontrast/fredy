/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Aachener Siedlungs- und Wohnungsgesellschaft (Aachener SWG), a housing company with flats in
 * Köln, Bonn, Aachen, Düsseldorf, Essen, Trier and more.
 *
 * The offers are server-rendered on https://www.aachener-swg.de/mieten/liste-mietobjekte (TYPO3). The
 * site filters with a POST form (`city`, `price-min`, `price-max`, `area-min`, `area-max`,
 * `rooms-min`, `rooms-max`, `move_date`, `wbs`) and pages with a POST field as well, so a filtered
 * search has no URL of its own. Users therefore paste the list URL with the form fields as query
 * parameters, e.g. `https://www.aachener-swg.de/mieten/liste-mietobjekte?city=K%C3%B6ln`, and this
 * provider posts them. The site serves no robots.txt (checked 2026-09-15), and the list needs no
 * browser.
 *
 * The list also carries parking spaces. They have neither living space nor rooms and are dropped.
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import logger from '../services/logger.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.aachener-swg.de';
const LIST_URL = `${BASE_URL}/mieten/liste-mietobjekte`;

/** The filter fields of the site's search form that may be carried over from the pasted URL. */
const FORM_FIELDS = [
  'city',
  'move_date',
  'price-min',
  'price-max',
  'area-min',
  'area-max',
  'rooms-min',
  'rooms-max',
  'wbs',
];

/** The form field the pagination buttons submit. */
const PAGE_FIELD = 'tx_aachener_exposelist[currentPage]';

/** How many result pages one run may walk. */
const MAX_PAGES = 10;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/**
 * The form body for one result page of the pasted search.
 *
 * @param {string} url The pasted search URL, carrying the form fields as query parameters.
 * @param {number} page One-based page number.
 * @returns {URLSearchParams}
 */
export function buildFormBody(url, page) {
  const params = new URL(url).searchParams;
  const body = new URLSearchParams();
  for (const field of FORM_FIELDS) {
    const value = params.get(field);
    if (value != null && value !== '') {
      body.set(field, value);
    }
  }
  if (page > 1) {
    body.set(PAGE_FIELD, String(page));
  }
  return body;
}

/**
 * A fact of a teaser card, with the site's "–" placeholder read as missing.
 *
 * @param {string|undefined} value
 * @returns {string|null}
 */
function factValue(value) {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' || trimmed === '–' || trimmed === '-' ? null : trimmed;
}

/**
 * @param {string|undefined} path
 * @returns {string|null}
 */
function absoluteUrl(path) {
  if (!path) return null;
  try {
    return new URL(path, BASE_URL).toString();
  } catch {
    return null;
  }
}

/**
 * Reads the teaser cards and the next page number out of one result page.
 *
 * @param {string} html
 * @returns {{rows: any[], nextPage: number|null}}
 */
export function parseListPage(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $('.m-property-list__item').each((_, element) => {
    const card = $(element);
    const anchor = card.find('a.m-property-teaser__link').first();
    const href = anchor.attr('href');
    if (!href) return;

    const facts = {};
    card.find('.m-property-teaser__facts details').each((__, detail) => {
      const label = $(detail).find('summary').text().trim();
      const value = $(detail).clone();
      value.find('summary').remove();
      facts[label] = factValue(value.text());
    });

    rows.push({
      id: href.split('/').filter(Boolean).pop(),
      link: absoluteUrl(href),
      title: anchor.text().replace(/\s+/g, ' ').trim(),
      address: factValue(card.find('.m-property-teaser__subtitle').text()),
      image: absoluteUrl(card.find('.m-property-teaser__media img').first().attr('src')),
      price: facts.Warmmiete ?? null,
      size: facts['Wohnfläche'] ?? null,
      rooms: facts.Zimmer ?? null,
    });
  });

  const next = Number.parseInt($('.m-pagination__next button').first().attr('value') ?? '', 10);
  return { rows, nextPage: Number.isFinite(next) ? next : null };
}

/**
 * Posts the search and walks its result pages.
 *
 * @param {string} url The pasted search URL.
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  const rows = [];
  const seen = new Set();
  let page = 1;

  for (let walked = 0; walked < MAX_PAGES; walked++) {
    const response = await fetch(LIST_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: buildFormBody(url, page).toString(),
    });
    if (!response.ok) {
      logger.error('Error fetching the Aachener SWG result page:', response.status, response.statusText);
      break;
    }

    const { rows: pageRows, nextPage } = parseListPage(await response.text());
    const fresh = pageRows.filter((row) => !seen.has(row.id));
    fresh.forEach((row) => seen.add(row.id));
    rows.push(...fresh);

    // A page with nothing new ends the walk too, so a page that ignores the page field cannot loop.
    if (fresh.length === 0 || nextPage == null || nextPage <= page) {
      break;
    }
    page = nextPage;
  }

  return rows.filter((row) => row.size != null || row.rooms != null);
}

/**
 * Builds the description out of the detail page's description columns.
 *
 * @param {string} html
 * @returns {string}
 */
export function parseDescription(html) {
  const $ = cheerio.load(html);
  const parts = [];

  $('.m-property__description h3').each((_, heading) => {
    const content = $(heading).next();
    const text = content.is('ul')
      ? content
          .find('li')
          .map((__, li) => $(li).text().trim())
          .get()
          .filter(Boolean)
          .join('\n')
      : content.text().trim();
    if (text) {
      parts.push(`${$(heading).text().trim()}\n${text}`);
    }
  });

  return parts.join('\n\n').trim();
}

/**
 * Loads the detail page for the description.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing) {
  try {
    const response = await fetch(listing.link, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
    if (!response.ok) return listing;
    const description = parseDescription(await response.text());
    return { ...listing, description: description || listing.description };
  } catch (error) {
    logger.warn(`Could not fetch Aachener SWG detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * The "Gesamt" row of the detail page's rent table, which is the figure the list shows as Warmmiete.
 *
 * @param {string} html
 * @returns {number|null}
 */
export function extractPrice(html) {
  const $ = cheerio.load(html);
  let price = null;
  $('table.m-property-details tfoot tr').each((_, row) => {
    const cells = $(row).find('td');
    if (price == null && cells.first().text().trim() === 'Gesamt') {
      price = extractNumber(cells.eq(1).text().trim());
    }
  });
  return price;
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  return {
    id: buildHash(o.id, o.price),
    link: o.link,
    title: o.title || '',
    price: extractNumber(o.price),
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: o.address,
    image: o.image,
    description: o.description,
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

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  sortByDateParam: null,
  // The site's price filter is a POST form field, not part of any URL the site produces.
  priceRangeParams: null,
  crawlContainer: '.m-property-list__item',
  crawlFields: {
    id: 'a.m-property-teaser__link@href',
    title: 'a.m-property-teaser__link | trim',
    address: '.m-property-teaser__subtitle | trim',
    image: '.m-property-teaser__media img@src',
    link: 'a.m-property-teaser__link@href',
  },
  normalize,
  getListings,
  fetchDetails,
  // A removed offer's URL answers 200 with the result list instead of a 404, so the list's sort
  // control, which no detail page carries, is what marks an offer as gone.
  activityProbe: (url) => checkIfListingIsActive(url, 'm-property-list__sort'),
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
  name: 'Aachener SWG',
  baseUrl: 'https://www.aachener-swg.de/',
  id: 'aachenerSwg',
};

export { config };
