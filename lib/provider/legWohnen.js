/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * LEG Wohnen, the rental portal of LEG Immobilien, one of the largest landlords in North
 * Rhine-Westphalia.
 *
 * Users paste one of the city pages, e.g. https://www.leg-wohnen.de/mietwohnungen/koeln. The TYPO3
 * site renders every flat of that city into the page (the pagination is done client side, so a city
 * with 148 flats ships all 148), which means a plain request reads the whole search and no browser
 * is needed. Neither the city pages nor the detail pages are disallowed by robots.txt (checked
 * 2026-09-15). The site has no price filter in the URL.
 *
 * The detail page carries no contact person, only the company's general chat channels, so there is
 * no personal data to leave out.
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import logger from '../services/logger.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/**
 * @param {string} url
 * @returns {Promise<string|null>} the page's html, or null when it could not be read
 */
async function fetchHtml(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'de-DE,de;q=0.9' } });
  if (!response.ok) {
    logger.error(`Error fetching LEG Wohnen page ${url}: ${response.status} ${response.statusText}`);
    return null;
  }
  return response.text();
}

/**
 * @param {string|undefined} href
 * @returns {string|null} the absolute url
 */
function absoluteUrl(href) {
  if (!href) return null;
  return new URL(href, metaInformation.baseUrl).toString();
}

/**
 * Reads the flats out of a city page.
 *
 * The card's `data-rent` attribute is `0` for every flat, so the Kaltmiete is read from the badge the
 * card shows instead.
 *
 * @param {string|null|undefined} html the raw html of a city page
 * @returns {any[]} the raw listings
 */
export function parseListings(html) {
  if (!html) return [];
  const $ = cheerio.load(html);

  return $('.sg-estate-list-item[data-uid]')
    .map((_, element) => {
      const card = $(element);
      const street = card.find('meta[itemprop="streetAddress"]').attr('content')?.trim();
      const postalCode = card.find('meta[itemprop="postalCode"]').attr('content')?.trim();
      const locality = card.find('meta[itemprop="addressLocality"]').attr('content')?.trim();
      const badges = card
        .find('.badge')
        .map((__, badge) => $(badge).text().replace(/\s+/g, ' ').trim())
        .get();

      return {
        id: card.attr('data-uid'),
        title: card.find('.sg-estate-list-item__title').text().replace(/\s+/g, ' ').trim(),
        link: absoluteUrl(card.find('.sg-estate-list-item__title a').attr('href')),
        price: badges.find((text) => text.includes('€')) ?? null,
        size: badges.find((text) => text.includes('m²')) ?? card.attr('data-size') ?? null,
        rooms: card.attr('data-rooms') ?? null,
        address: [street, [postalCode, locality].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        image: absoluteUrl(card.find('img').attr('src')),
      };
    })
    .get();
}

/**
 * @param {string} url the city page url
 * @returns {Promise<any[]>} every flat of the city
 */
async function getListings(url) {
  try {
    return parseListings(await fetchHtml(url));
  } catch (error) {
    logger.error('Could not read LEG Wohnen listings.', error?.message || error);
    return [];
  }
}

/**
 * Reads the Kaltmiete off a detail page's cost table.
 *
 * @param {string|null|undefined} html
 * @returns {number|null}
 */
export function extractDetailPrice(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const row = $('table tr')
    .filter((_, tr) => /Kaltmiete/i.test($(tr).find('td').first().text()))
    .first();
  return row.length ? extractNumber(row.find('td').last().text().trim()) : null;
}

/**
 * The text of a detail chapter: everything between its headline and the next one.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {any} headline
 * @returns {string}
 */
function chapterText($, headline) {
  const parts = [];
  let node = headline[0]?.nextSibling;
  while (node && !(node.type === 'tag' && $(node).is('h2.sg-estate-detail-chapter-headline'))) {
    if (node.type === 'text') {
      parts.push(node.data);
    } else if (node.type === 'tag' && !$(node).is('table, .energy-efficiency, .mt-4, script')) {
      $(node).find('br').replaceWith('\n');
      parts.push($(node).text());
    } else if (node.type === 'tag' && $(node).is('br')) {
      parts.push('\n');
    }
    node = node.nextSibling;
  }
  return parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Builds the description from the detail page's text chapters.
 *
 * @param {string} html
 * @returns {string}
 */
export function buildDescription(html) {
  const $ = cheerio.load(html);
  const wanted = ['Objektbeschreibung', 'Ausstattung', 'Lage und Wohnumfeld'];
  const parts = [];

  $('h2.sg-estate-detail-chapter-headline').each((_, element) => {
    const headline = $(element);
    const name = headline.text().replace(/­/g, '').trim();
    if (!wanted.includes(name)) return;
    const text = chapterText($, headline);
    if (text) parts.push(`${name}\n${text}`);
  });

  return parts.join('\n\n').trim();
}

/**
 * Reads the description off the detail page.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing) {
  try {
    const html = await fetchHtml(listing.link);
    if (!html) return listing;
    const description = buildDescription(html);
    return { ...listing, description: description || listing.description };
  } catch (error) {
    logger.warn(`Could not fetch LEG Wohnen detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const price = extractNumber(o.price);
  return {
    id: buildHash(o.id, o.price),
    link: o.link,
    title: (o.title || '').trim(),
    price: price != null ? Math.round(price) : null,
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
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  return titleNotBlacklisted && descNotBlacklisted;
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  sortByDateParam: null,
  // The city pages take no price filter in the URL.
  priceRangeParams: null,
  crawlFields: {
    id: '.sg-estate-list-item@data-uid',
    title: '.sg-estate-list-item__title',
    price: '.badge',
    size: '.badge',
    rooms: '.sg-estate-list-item@data-rooms',
    link: '.sg-estate-list-item__title a@href',
    address: 'meta[itemprop="streetAddress"]@content',
    image: 'img@src',
  },
  normalize,
  getListings,
  fetchDetails,
  activityProbe: checkIfListingIsActive,
  priceTracking: {
    extract: extractDetailPrice,
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
  name: 'LEG Wohnen',
  baseUrl: 'https://www.leg-wohnen.de/',
  id: 'legWohnen',
};

export { config };
