/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * VEBOWAG, the municipal housing company of Bonn.
 *
 * vebowag.de does not list its flats itself. The page https://www.vebowag.de/wohnungen/wohnungssuche/
 * embeds Immomio's homepage widget (https://homepage.immomio.com/de/properties?token=…), a single
 * page app that reads the offers from Immomio's public GraphQL endpoint:
 * POST https://gql-hp.immomio.com/homepage/graphql, query `propertyList`.
 *
 * The widget token is public - it is printed into vebowag.de's page and only names the customer
 * whose offers are shown. Neither vebowag.de nor the Immomio hosts disallow crawling in robots.txt
 * (checked 2026-09-15), so the search needs no browser.
 *
 * Users paste either the vebowag.de search page (the embedded token is used) or the widget URL with
 * its `token` parameter. The widget keeps every filter in its own state rather than in the URL, so
 * there is nothing else to read out of the pasted URL.
 */

import { buildHash, isOneOf } from '../utils.js';
import logger from '../services/logger.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const GRAPHQL_ENDPOINT = 'https://gql-hp.immomio.com/homepage/graphql';

/** The widget token vebowag.de embeds on its search page (checked 2026-09-15). */
export const VEBOWAG_TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJjdXN0b21lcklkIjoyMDI4MDE4NTQ5LCJjcmVhdGVkIjoxNzU5ODM1ODMxNTA0LCJpZCI6MjAzOTQzNDY1Mn0.jRpCH6Di2DhRWIrgL0YSav6eWOdl8pe0ERudFAbwmSI';

/** Rows per request. The widget asks for 1000 on its map view, so 100 is well within what is served. */
const PAGE_SIZE = 100;

/** How many pages one run may walk, so a response whose paging disagrees with its rows cannot loop. */
const MAX_PAGES = 10;

/** The fields the widget itself requests, minus the ones Fredy has no use for. */
const PROPERTY_LIST_QUERY = `query propertyList($input: HomepagePropertySearchRequest!) {
  propertyList(input: $input) {
    page { totalElements totalPages page size }
    nodes {
      name
      totalRooms
      size
      totalRentGross
      propertyType
      externalId
      wbs
      applicationLink
      floor
      status
      marketingType
      availableFrom { dateAvailable stringAvailable }
      titleImage { url }
      address { city street houseNumber zipCode district coordinates { lat lon } }
      showAddress
    }
  }
}`;

/**
 * Reads the Immomio widget token out of a pasted search URL.
 *
 * @param {string} url The vebowag.de search page or the Immomio widget URL.
 * @returns {string} The token to query with; vebowag.de's own token when the URL carries none.
 */
export function tokenFromUrl(url) {
  try {
    return new URL(url).searchParams.get('token') || VEBOWAG_TOKEN;
  } catch {
    return VEBOWAG_TOKEN;
  }
}

/**
 * The GraphQL request body for one page of offers, newest first.
 *
 * @param {string} token
 * @param {number} page Zero-based page number.
 * @returns {string}
 */
export function buildRequestBody(token, page) {
  return JSON.stringify({
    operationName: 'propertyList',
    query: PROPERTY_LIST_QUERY,
    variables: { input: { page, size: PAGE_SIZE, token, sort: ['created,desc'], marketingType: 'RENT' } },
  });
}

/**
 * The address the widget would show. Immomio lets a landlord hide the street, which `showAddress`
 * reports; the town is shown either way.
 *
 * @param {any} node
 * @returns {string}
 */
function buildAddress(node) {
  const address = node.address ?? {};
  const street = node.showAddress ? [address.street, address.houseNumber].filter(Boolean).join(' ').trim() : '';
  const cityLine = [address.zipCode, address.city].filter(Boolean).join(' ').trim();
  const district = address.district && address.district !== address.city ? ` (${address.district})` : '';
  return [street, cityLine ? `${cityLine}${district}` : ''].filter(Boolean).join(', ');
}

/**
 * Fetch every offer of the widget, walking the pages.
 *
 * @param {string} url The pasted search URL.
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  const token = tokenFromUrl(url);
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://homepage.immomio.com',
    Referer: 'https://homepage.immomio.com/',
  };

  const nodes = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetch(GRAPHQL_ENDPOINT, { method: 'POST', headers, body: buildRequestBody(token, page) });
    if (!response.ok) {
      logger.error('Error fetching data from the Immomio homepage API:', response.status, response.statusText);
      break;
    }

    const body = await response.json();
    if (body?.errors?.length) {
      logger.error('Immomio homepage API answered with errors:', JSON.stringify(body.errors).slice(0, 500));
      break;
    }

    const list = body?.data?.propertyList;
    const rows = list?.nodes ?? [];
    nodes.push(...rows);

    const totalPages = list?.page?.totalPages;
    if (rows.length === 0 || totalPages == null || page + 1 >= totalPages) {
      break;
    }
  }

  return nodes
    .filter((node) => node.marketingType == null || node.marketingType === 'RENT')
    .map((node) => ({
      id: node.externalId || node.applicationLink,
      title: node.name,
      price: node.totalRentGross,
      size: node.size,
      rooms: node.totalRooms,
      link: node.applicationLink,
      address: buildAddress(node),
      image: node.titleImage?.url ?? null,
      latitude: node.address?.coordinates?.lat ?? null,
      longitude: node.address?.coordinates?.lon ?? null,
    }));
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
    latitude: o.latitude || null,
    longitude: o.longitude || null,
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
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image'],
  url: null,
  sortByDateParam: null,
  // The widget keeps its rent filter in app state, never in the URL.
  priceRangeParams: null,
  crawlFields: {
    id: 'externalId',
    title: 'name',
    price: 'totalRentGross',
    size: 'size',
    rooms: 'totalRooms',
    link: 'applicationLink',
    address: 'address',
    image: 'titleImage.url',
  },
  normalize,
  getListings,
  // The apply link is Immomio's tenant app, a single page app whose shell is served for any path,
  // so this probe only notices an offer as gone once the link fails on the HTTP level.
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
  name: 'VEBOWAG Bonn',
  baseUrl: 'https://www.vebowag.de/',
  id: 'vebowag',
};

export { config };
