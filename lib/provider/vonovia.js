/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Vonovia provider using the site's JSON API to retrieve listings.
 *
 * Users paste a search URL from https://www.vonovia.de/zuhause-finden/immobilien, which is
 * translated to the internal API endpoint:
 * GET /api/real-estate/list?{search parameters}
 *
 * Vonovia and Deutsche Wohnen run on the same platform: the list endpoint returns the same row shape
 * and the detail pages embed the same `data-vonovia-data` record. Only the host, the API path and
 * the detail link differ, see {@link ./deutscheWohnen.js}.
 *
 * Both the endpoint and the detail pages are allowed by vonovia.de's robots.txt (checked 2026-09-15),
 * so this provider needs no browser for the search itself.
 */

import { buildHash, isOneOf } from '../utils.js';
import logger from '../services/logger.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import puppeteerExtractor from '../services/extractor/puppeteerExtractor.js';
import * as cheerio from 'cheerio';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const API_PATH = '/api/real-estate/list';

/**
 * The largest page the list endpoint is willing to serve.
 *
 * Like Deutsche Wohnen's endpoint, a larger `limit` is not trimmed but refused with
 * `406 Not Acceptable` and an empty body, which reads exactly like being blocked.
 */
const API_MAX_LIMIT = 50;

/**
 * How many pages one run may walk before giving up, so a response whose `paging.info.count`
 * disagrees with its rows can never loop forever.
 */
const MAX_PAGES = 10;

/**
 * A page size the endpoint accepts, whatever the pasted URL asked for.
 *
 * @param {string|null} requested
 * @returns {string}
 */
function clampLimit(requested) {
  const limit = Number.parseInt(requested ?? '', 10);
  return String(Number.isFinite(limit) && limit > 0 ? Math.min(limit, API_MAX_LIMIT) : API_MAX_LIMIT);
}

/**
 * Translates a Vonovia search page URL into the JSON API endpoint.
 *
 * @param {string} url Web search URL or API URL pasted by the user.
 * @returns {string} API URL used by getListings().
 */
export function convertWebToApi(url) {
  const parsed = new URL(url);
  parsed.searchParams.delete('scroll');
  parsed.searchParams.set('limit', clampLimit(parsed.searchParams.get('limit')));

  if (parsed.pathname === API_PATH) {
    return parsed.toString();
  }
  return `${metaInformation.baseUrl}${API_PATH.slice(1)}?${parsed.searchParams.toString()}`;
}

/**
 * @param {any} item
 * @returns {string}
 */
function buildAddress(item) {
  const street = item.strasse?.trim();
  const cityLine = [item.plz, item.ort].filter(Boolean).join(' ').trim();
  return [street, cityLine].filter(Boolean).join(', ');
}

/**
 * The API reports an unknown position as 0/0, which is a point in the Atlantic, not a flat.
 *
 * @param {number | null | undefined} value
 * @returns {number | null}
 */
function normalizeCoordinate(value) {
  if (value == null || value === 0) {
    return null;
  }
  return value;
}

/**
 * Builds the description from the embedded detail record.
 *
 * The record also carries the name, e-mail and phone number of the Vonovia contact person. Those are
 * deliberately left out: they are personal data Fredy has no use for.
 *
 * @param {any} detailData
 * @returns {string}
 */
function buildDescription(detailData) {
  const parts = [];

  if (detailData.description?.trim()) {
    parts.push(`Beschreibung\n${detailData.description.trim()}`);
  }

  if (detailData.features?.length) {
    parts.push(
      `Ausstattung\n${detailData.features
        .map((f) => String(f).trim())
        .filter(Boolean)
        .join('\n')}`,
    );
  }

  if (detailData.location?.trim()) {
    parts.push(`Lage\n${detailData.location.trim()}`);
  }

  if (detailData.miscellaneous?.trim()) {
    parts.push(detailData.miscellaneous.trim());
  }

  return parts.join('\n\n').trim();
}

/**
 * Fetch the listing rows from the Vonovia JSON API, walking the pages the size cap leaves behind.
 *
 * Invoked by the pipeline with `this` bound to the executioner, so the run's referer is read from
 * `this._providerConfig` rather than from module state.
 *
 * @this {{_providerConfig?: {refererUrl?: string|null}}}
 * @param {string} url The API URL to query.
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  const refererUrl = this?._providerConfig?.refererUrl ?? null;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    Accept: 'application/json',
    ...(refererUrl ? { Referer: refererUrl } : {}),
  };

  const pageSize = Number.parseInt(new URL(url).searchParams.get('limit') ?? '', 10) || API_MAX_LIMIT;
  const rows = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl = new URL(url);
    if (page > 0) {
      pageUrl.searchParams.set('offset', String(page * pageSize));
    }

    const response = await fetch(pageUrl.toString(), { method: 'GET', headers });
    if (!response.ok) {
      logger.error('Error fetching data from Vonovia API:', response.status, response.statusText);
      break;
    }

    const responseBody = await response.json();
    const results = responseBody.results || [];
    rows.push(...results);

    const total = responseBody?.paging?.info?.count;
    if (results.length === 0 || total == null || rows.length >= total) {
      break;
    }
  }

  return rows
    .filter((item) => item.vermarktungsart_miete === '1')
    .map((item) => ({
      id: item.wrk_id,
      price: item.preis,
      size: item.groesse,
      rooms: item.anzahl_zimmer,
      title: item.titel,
      link: `${metaInformation.baseUrl}zuhause-finden/immobilien/${item.slug}`,
      address: buildAddress(item),
      image: item.preview_img_url,
      latitude: item.lat,
      longitude: item.lng,
    }));
}

/**
 * Reads the embedded detail record for the full description and a street address.
 *
 * @param {ParsedListing} listing
 * @param {any} [browser]
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing, browser) {
  try {
    const html = await puppeteerExtractor(listing.link, 'body', { browser, name: 'vonovia_details' });
    if (!html) return listing;

    const rawData = cheerio.load(html)('[data-vonovia-data]').attr('data-vonovia-data');
    if (!rawData) return listing;

    const detailData = JSON.parse(rawData);
    const description = buildDescription(detailData);
    const address = [detailData.streetAndHouseNumber, detailData.postCodeAndCity].filter(Boolean).join(', ');

    return {
      ...listing,
      address: address || listing.address,
      description: description || listing.description,
      latitude: normalizeCoordinate(detailData.latitude) ?? listing.latitude,
      longitude: normalizeCoordinate(detailData.longitude) ?? listing.longitude,
    };
  } catch (error) {
    logger.warn(`Could not fetch Vonovia detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const id = buildHash(o.id, o.price);
  const price = extractNumber(o.price);
  return {
    id,
    link: o.link,
    title: (o.title || '').trim(),
    price: price != null ? Math.round(price) : null,
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: o.address,
    image: o.image,
    description: o.description,
    latitude: normalizeCoordinate(o.latitude),
    longitude: normalizeCoordinate(o.longitude),
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
  // Same platform, same filter spelling as Deutsche Wohnen: ?priceMin=10&priceMax=1000
  priceRangeParams: { min: 'priceMin', max: 'priceMax' },
  crawlFields: {
    id: 'wrk_id',
    title: 'titel',
    price: 'preis',
    size: 'groesse',
    rooms: 'anzahl_zimmer',
    link: 'slug',
    address: 'strasse',
    image: 'preview_img_url',
  },
  normalize,
  getListings,
  fetchDetails,
  activityProbe: checkIfListingIsActive,
  priceTracking: {
    /**
     * `rent` is the field behind the list's `preis` (the Kaltmiete). `warmRent` sits right beside it
     * and must not be read, or every listing reports an invented increase on its first probe.
     *
     * @param {string} html
     * @returns {number|null}
     */
    extract: (html) => {
      const raw = cheerio.load(html)('[data-vonovia-data]').first().attr('data-vonovia-data');
      if (!raw) return null;
      try {
        const data = JSON.parse(raw);
        return data?.rent ?? data?.purchasePrice ?? null;
      } catch {
        return null;
      }
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
  url: convertWebToApi(sourceConfig.url),
  refererUrl: sourceConfig.url,
  filter: (listing) => applyBlacklist(listing, blacklist ?? []),
});

export const metaInformation = {
  countries: ['de'],
  name: 'Vonovia',
  baseUrl: 'https://www.vonovia.de/',
  id: 'vonovia',
};

export { config };
