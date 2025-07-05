// server.js – Fulton County Property Owner Lookup API

const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

function normalizeAddress(address) {
  const ABBREV = {
    'STREET':'ST','AVENUE':'AVE','BOULEVARD':'BLVD','DRIVE':'DR',
    'ROAD':'RD','LANE':'LN','COURT':'CT','CIRCLE':'CIR','PLACE':'PL',
    'PARKWAY':'PKWY','TRAIL':'TRL','TERRACE':'TER','PLAZA':'PLZ',
    'ALLEY':'ALY','BRIDGE':'BRG','BYPASS':'BYP','CAUSEWAY':'CSWY',
    'CENTER':'CTR','CROSSING':'XING','EXPRESSWAY':'EXPY','EXTENSION':'EXT',
    'FREEWAY':'FWY','HEIGHTS':'HTS','HIGHWAY':'HWY','JUNCTION':'JCT',
    'NORTH':'N','SOUTH':'S','EAST':'E','WEST':'W',
    'NORTHEAST':'NE','NORTHWEST':'NW','SOUTHEAST':'SE','SOUTHWEST':'SW',
    'MARTIN LUTHER KING JR':'M L KING JR','MARTIN LUTHER KING':'M L KING','MLK':'M L KING'
  };
  let s = address.toUpperCase().replace(/[.,#]/g,' ');
  for (const [k,v] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  }
  s = s.replace(/\b(ATLANTA|AUGUSTA|COLUMBUS|MACON|SAVANNAH|ATHENS|GA|GEORGIA)\b.*$/,'').trim();
  return s.replace(/\s+/g,' ');
}

async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    // 1) Navigate to search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );

    // 2) Accept terms if present
    try {
      const agreeBtn = await page.$('input[type="button"][value*="Agree"], input[type="submit"][value*="Agree"], button:has-text("Accept"), button:has-text("Agree")');
      if (agreeBtn) {
        await agreeBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      // Continue if no agreement button
    }

    // 3) Debug: Log what's on the page
    console.log('Page loaded, looking for input fields...');
    
    // 4) Try multiple strategies to find the address input
    const norm = normalizeAddress(address);
    let inputFound = false;

    // Strategy 1: Try finding a single address input field
    const singleAddressSelectors = [
      'input[placeholder*="address"]',
      'input[placeholder*="Address"]',
      'input[aria-label*="address"]',
      'input[aria-label*="Address"]',
      'input[id*="address"]',
      'input[id*="Address"]',
      'input[name*="address"]',
      'input[name*="Address"]'
    ];

    for (const selector of singleAddressSelectors) {
      try {
        const input = await page.$(selector);
        if (input) {
          console.log(`Found address input with selector: ${selector}`);
          await input.click({ clickCount: 3 });
          await input.type(norm);
          inputFound = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // Strategy 2: If no single input, try street number + street name
    if (!inputFound) {
      console.log('Trying split address approach...');
      const parts = norm.split(' ');
      const streetNumber = parts[0];
      const streetName = parts.slice(1).join(' ');

      // Try various selectors for street number
      const numberSelectors = [
        'input[name="txtStreetNumber"]',
        'input[name*="StreetNumber"]',
        'input[placeholder*="Street Number"]',
        'input[placeholder*="street number"]',
        'input[aria-label*="Street Number"]'
      ];

      const nameSelectors = [
        'input[name="txtStreetName"]',
        'input[name*="StreetName"]',
        'input[placeholder*="Street Name"]',
        'input[placeholder*="street name"]',
        'input[aria-label*="Street Name"]'
      ];

      let numberInput = null;
      let nameInput = null;

      for (const selector of numberSelectors) {
        numberInput = await page.$(selector);
        if (numberInput) break;
      }

      for (const selector of nameSelectors) {
        nameInput = await page.$(selector);
        if (nameInput) break;
      }

      if (numberInput && nameInput) {
        await numberInput.click({ clickCount: 3 });
        await numberInput.type(streetNumber);
        await nameInput.click({ clickCount: 3 });
        await nameInput.type(streetName);
        inputFound = true;
      }
    }

    // Strategy 3: Use XPath to find inputs by label text
    if (!inputFound) {
      console.log('Trying XPath approach...');
      try {
        // Look for any label containing "address" and get its associated input
        const addressLabels = await page.$x('//label[contains(translate(., "ADDRESS", "address"), "address")]');
        for (const label of addressLabels) {
          const forAttr = await page.evaluate(el => el.getAttribute('for'), label);
          if (forAttr) {
            const input = await page.$(`#${forAttr}`);
            if (input) {
              await input.click({ clickCount: 3 });
              await input.type(norm);
              inputFound = true;
              break;
            }
          }
        }
      } catch (e) {
        console.log('XPath approach failed:', e.message);
      }
    }

    if (!inputFound) {
      throw new Error('Could not find address input fields on the page');
    }

    // 5) Find and click the search button
    const searchSelectors = [
      'input[type="submit"][value="Search"]',
      'input[type="button"][value="Search"]',
      'button:has-text("Search")',
      'button[type="submit"]',
      'input[value*="Search"]',
      'button[aria-label*="Search"]'
    ];

    let searchClicked = false;
    for (const selector of searchSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          await btn.click();
          searchClicked = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!searchClicked) {
      console.log('No search button found, trying Enter key...');
      await page.keyboard.press('Enter');
    }

    // 6) Wait for results
    await page.waitForSelector('table.searchResultsGrid a, div.searchResults a, a[href*="Parcel"]', { timeout: 15000 });
    
    // Click first result
    const firstResult = await page.$('table.searchResultsGrid a, div.searchResults a, a[href*="Parcel"]');
    await firstResult.click();

    // 7) Wait for owner info
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return text.includes('Most Current Owner') || text.includes('Owner Name') || text.includes('Current Owner');
      },
      { timeout: 15000 }
    );

    // 8) Extract owner & mailing address
    const result = await page.evaluate(() => {
      const clean = txt => txt.replace(/\s+/g, ' ').trim();
      let owner = 'Not found';
      let mailing = 'Not found';
      
      // Try different patterns
      const cells = Array.from(document.querySelectorAll('td, div'));
      
      for (let i = 0; i < cells.length; i++) {
        const cellText = cells[i].textContent || '';
        
        // Owner patterns
        if (/Most Current Owner|Owner Name|Current Owner/i.test(cellText)) {
          if (cells[i + 1]) {
            owner = clean(cells[i + 1].textContent);
          } else if (cells[i].nextElementSibling) {
            owner = clean(cells[i].nextElementSibling.textContent);
          }
        }
        
        // Mailing patterns
        if (/Mailing Address/i.test(cellText)) {
          if (cells[i + 1]) {
            mailing = clean(cells[i + 1].textContent);
          } else if (cells[i].nextElementSibling) {
            mailing = clean(cells[i].nextElementSibling.textContent);
          }
        }
      }
      
      return { owner, mailing };
    });

    return {
      success: true,
      owner_name: result.owner,
      mailing_address: result.mailing
    };

  } catch (err) {
    console.error('Scrape error:', err);
    
    // Take a screenshot for debugging
    try {
      await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
      console.log('Screenshot saved as error-screenshot.png');
    } catch (screenshotErr) {
      console.log('Could not save screenshot');
    }
    
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// API endpoints
app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ success: false, error: 'address field required' });
  }
  console.log(`Searching for address: ${address}`);
  const data = await fetchOwnerData(address);
  res.json(data);
});

// Root and health routes
app.get('/', (req, res) => res.send('Fulton Scraper API running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
