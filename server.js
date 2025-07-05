// server.js – Fulton County Property Owner Lookup API

const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

/** Normalize address to USPS abbreviations and strip city/state/zip */
function normalizeAddress(address) {
  const ABBREV = {
    'STREET':'ST','AVENUE':'AVE','BOULEVARD':'BLVD','DRIVE':'DR',
    'ROAD':'RD','LANE':'LN','COURT':'CT','CIRCLE':'CIR','PLACE':'PL',
    'PARKWAY':'PKWY','TRAIL':'TRL','TERRACE':'TER','PLAZA':'PLZ',
    'ALLEY':'ALY','BRIDGE':'BRG','BYPASS':'BYP','CAUSEWAY':'CSWY',
    'CENTER':'CTR','CENTRE':'CTR','CROSSING':'XING','EXPRESSWAY':'EXPY',
    'EXTENSION':'EXT','FREEWAY':'FWY','GROVE':'GRV','HEIGHTS':'HTS',
    'HIGHWAY':'HWY','HOLLOW':'HOLW','JUNCTION':'JCT','MOTORWAY':'MTWY',
    'OVERPASS':'OPAS','PARK':'PARK','POINT':'PT','ROUTE':'RTE',
    'SKYWAY':'SKWY','SQUARE':'SQ','TURNPIKE':'TPKE',
    'NORTH':'N','SOUTH':'S','EAST':'E','WEST':'W',
    'NORTHEAST':'NE','NORTHWEST':'NW','SOUTHEAST':'SE','SOUTHWEST':'SW',
    'MARTIN LUTHER KING JR':'M L KING JR','MARTIN LUTHER KING':'M L KING',
    'MLK':'M L KING'
  };
  let s = address.toUpperCase().replace(/[.,#]/g,' ');
  for (let [k,v] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  }
  // Strip trailing GA/ZIP/city
  s = s.replace(/\b(ATLANTA|AUGUSTA|COLUMBUS|MACON|SAVANNAH|ATHENS|GA|GEORGIA)\b.*$/,'').trim();
  return s.replace(/\s+/g,' ');
}

/** Scrape qPublic Fulton County site for owner info */
async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    // 1) Navigate to search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil:'networkidle2', timeout:30000 }
    );

    // 2) Wait for page to fully load
    await page.waitForTimeout(3000);

    // 3) Find the "Search by Location Address" input field
    // Based on current site structure, we need to find the address input under the "Search by Location Address" section
    const addressInputSelector = 'input[type="text"]';
    await page.waitForSelector(addressInputSelector, { timeout: 10000 });

    // Get all text inputs and find the one for address search
    const addressInput = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"]');
      // Look for the input that's in the "Search by Location Address" section
      for (let input of inputs) {
        const parentText = input.closest('div, section, form')?.textContent || '';
        if (parentText.includes('Location Address') || parentText.includes('Enter address')) {
          return input;
        }
      }
      // Fallback to second input (usually the address one based on page structure)
      return inputs[1] || inputs[0];
    });

    if (!addressInput) {
      throw new Error('Could not find address input field');
    }

    // 4) Type normalized address
    const norm = normalizeAddress(address);
    console.log(`Searching for normalized address: ${norm}`);
    
    await page.evaluate((selector, value) => {
      const inputs = document.querySelectorAll('input[type="text"]');
      const input = inputs[1] || inputs[0]; // Usually second input is address
      if (input) {
        input.value = '';
        input.focus();
        input.value = value;
      }
    }, addressInputSelector, norm);

    // 5) Find and click the corresponding Search button
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('input[type="submit"], button');
      for (let button of buttons) {
        const buttonText = button.value || button.textContent || '';
        const parentText = button.closest('div, section, form')?.textContent || '';
        if ((buttonText.includes('Search') || button.type === 'submit') && 
            parentText.includes('Location Address')) {
          button.click();
          return;
        }
      }
      // Fallback - click any search button
      const searchBtn = [...buttons].find(btn => 
        (btn.value && btn.value.includes('Search')) || 
        (btn.textContent && btn.textContent.includes('Search'))
      );
      if (searchBtn) searchBtn.click();
    });

    // 6) Wait for results and click first parcel
    await page.waitForSelector('table a, .searchResultsGrid a', { timeout: 15000 });
    await page.click('table a, .searchResultsGrid a');

    // 7) Wait for property details page
    await page.waitForTimeout(5000);

    // 8) Extract owner & mailing address
    const { owner, mailing } = await page.evaluate(() => {
      const clean = txt => txt.replace(/\s+/g,' ').trim();
      let o='Not found', m='Not found';
      
      // Look for owner information in table cells
      const allCells = document.querySelectorAll('td, th, div');
      
      for (let cell of allCells) {
        const text = cell.textContent || '';
        
        // Look for "Owner" or "Current Owner" labels
        if (/Owner/i.test(text) && !text.includes('Mailing')) {
          const nextCell = cell.nextElementSibling;
          if (nextCell && nextCell.textContent.trim()) {
            o = clean(nextCell.textContent);
          }
        }
        
        // Look for "Mailing Address" labels
        if (/Mailing.*Address/i.test(text)) {
          const nextCell = cell.nextElementSibling;
          if (nextCell && nextCell.textContent.trim()) {
            m = clean(nextCell.textContent);
          }
        }
      }
      
      return { owner: o, mailing: m };
    });

    return { success: true, owner_name: owner, mailing_address: mailing };

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
  const data = await fetchOwnerData(address);
  res.json(data);
});

// Root and health routes
app.get('/', (req, res) => res.send('Fulton Scraper API running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
