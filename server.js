// server.js – Fulton County Property Owner Lookup API

const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

/**
 * Normalize a street address by uppercasing, removing punctuation,
 * mapping long forms to USPS abbreviations, and stripping city/state/zip.
 */
function normalizeAddress(address) {
  const ABBREVIATIONS = {
    STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR',
    ROAD: 'RD', LANE: 'LN', COURT: 'CT', CIRCLE: 'CIR',
    PLACE: 'PL', PARKWAY: 'PKWY', TRAIL: 'TRL', TERRACE: 'TER',
    PLAZA: 'PLZ', ALLEY: 'ALY', BRIDGE: 'BRG', BYPASS: 'BYP',
    CAUSEWAY: 'CSWY', CENTER: 'CTR', CENTRE: 'CTR', CROSSING: 'XING',
    EXPRESSWAY: 'EXPY', EXTENSION: 'EXT', FREEWAY: 'FWY', GROVE: 'GRV',
    HEIGHTS: 'HTS', HIGHWAY: 'HWY', HOLLOW: 'HOLW', JUNCTION: 'JCT',
    MOTORWAY: 'MTWY', SKWY: 'SKWY', SQUARE: 'SQ', TURNPIKE: 'TPKE',
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
    NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
    'MARTIN LUTHER KING JR': 'M L KING JR',
    'MARTIN LUTHER KING': 'M L KING', MLK: 'M L KING',
  };

  let s = address.toUpperCase().replace(/[.,#]/g, ' ');
  for (const [longForm, abbr] of Object.entries(ABBREVIATIONS)) {
    const re = new RegExp(`\\b${longForm}\\b`, 'g');
    s = s.replace(re, abbr);
  }
  // remove trailing city/state/zip
  s = s.replace(/\b(ATLANTA|AUGUSTA|COLUMBUS|MACON|SAVANNAH|ATHENS|GA|GEORGIA)\b.*$/, '').trim();
  return s.replace(/\s+/g, ' ');
}

/**
 * Scrape Fulton County site for owner name and mailing address.
 */
async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    // 1. Navigate to search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );

    // 2. Accept terms if present
    const agree = await page.$('input[value*="agree" i], button:contains("Agree")');
    if (agree) await agree.click();

    // 3. Wait a moment for page to settle
    await page.waitForTimeout(2000);

    // 4. Locate the “Search by Location Address” input
    let selector = 'input[placeholder*="Enter address"]';
    if (!await page.$(selector)) {
      selector = '#SearchTextBox';
    }
    await page.waitForSelector(selector, { timeout: 10000 });
    const street = normalizeAddress(address);
    await page.click(selector, { clickCount: 3 });
    await page.type(selector, street);

    // 5. Submit the search
    const btn = await page.$('input[value="Search"], button:contains("Search")');
    if (btn) {
      await btn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // 6. Wait for results link and click first result
    await page.waitForSelector('table.searchResultsGrid a', { timeout: 15000 });
    await page.click('table.searchResultsGrid a');

    // 7. Wait for owner section
    await page.waitForSelector('td:contains("Most Current Owner")', { timeout: 15000 });

    // 8. Extract owner & mailing address
    const data = await page.evaluate(() => {
      const clean = txt => txt.replace(/\s+/g, ' ').trim();
      let owner = 'Not found', mailing = 'Not found';

      // Owner
      const ownerLabel = Array.from(document.querySelectorAll('td'))
        .find(td => /Most Current Owner/i.test(td.textContent));
      if (ownerLabel && ownerLabel.nextElementSibling) {
        owner = clean(ownerLabel.nextElementSibling.textContent);
      }

      // Mailing
      const mailLabel = Array.from(document.querySelectorAll('td'))
        .find(td => /Mailing Address/i.test(td.textContent));
      if (mailLabel && mailLabel.nextElementSibling) {
        mailing = clean(mailLabel.nextElementSibling.textContent);
      }

      return { owner, mailing };
    });

    return { success: true, owner_name: data.owner, mailing_address: data.mailing };
  } catch (err) {
    console.error('Scrape error:', err);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// API endpoints
app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ success: false, error: 'address field required' });
  const result = await fetchOwnerData(address);
  res.json(result);
});

app.get('/', (req, res) => res.send('Fulton Scraper API is running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
