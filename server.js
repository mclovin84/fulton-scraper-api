const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

function normalizeAddress(address) {
    const ABBREVIATIONS = {
        'STREET': 'ST', 'AVENUE': 'AVE', 'BOULEVARD': 'BLVD',
        'DRIVE': 'DR', 'ROAD': 'RD', 'LANE': 'LN', 'COURT': 'CT',
        'CIRCLE': 'CIR', 'PLACE': 'PL', 'PARKWAY': 'PKWY',
        'MARTIN LUTHER KING JR': 'M L KING JR',
        'MARTIN LUTHER KING': 'M L KING',
        'MLK': 'M L KING',
        'NORTH': 'N', 'SOUTH': 'S', 'EAST': 'E', 'WEST': 'W',
        'NORTHEAST': 'NE', 'NORTHWEST': 'NW', 'SOUTHEAST': 'SE', 'SOUTHWEST': 'SW'
    };
    
    let normalized = address.toUpperCase().replace(/[.,#]/g, '');
    
    for (const [longForm, abbr] of Object.entries(ABBREVIATIONS)) {
        const escapedLongForm = longForm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('\\b' + escapedLongForm + '\\b', 'g');
        normalized = normalized.replace(regex, abbr);
    }
    
    const parts = normalized.split(' ');
    const filteredParts = [];
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (['ATLANTA', 'AUGUSTA', 'COLUMBUS', 'MACON', 'SAVANNAH', 'ATHENS', 'GA', 'GEORGIA'].includes(part)) {
            break;
        }
        if (/^\d{5}(-\d{4})?$/.test(part)) {
            break;
        }
        if (part.trim()) {
            filteredParts.push(part);
        }
    }
    
    return filteredParts.join(' ').trim();
}

async function scrapeFultonProperty(address) {
    const browser = await puppeteer.connect({
        browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
    });
    
    try {
        const page = await browser.newPage();
        
        // Navigate to the updated Fulton County search page
        await page.goto('https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait for the page to load completely
        await page.waitForTimeout(3000);
        
        // Look for the address search input field (updated selector)
        // Based on the new structure, we need to find the location address input
        const addressInputSelector = 'input[placeholder*="address"], input[type="text"][name*="address"], input[type="text"][id*="address"]';
        
        try {
            await page.waitForSelector(addressInputSelector, { timeout: 10000 });
        } catch (error) {
            // If specific selector fails, try more general approach
            await page.waitForSelector('input[type="text"]', { timeout: 10000 });
        }
        
        const normalizedAddress = normalizeAddress(address);
        console.log(`Normalized address: ${normalizedAddress}`);
        
        // Try to find and fill the address input field
        const addressInput = await page.$('input[type="text"]');
        if (addressInput) {
            await addressInput.click();
            await addressInput.type(normalizedAddress);
            
            // Look for and click the search button
            const searchButton = await page.$('button[type="submit"], input[type="submit"], button:contains("Search")');
            if (searchButton) {
                await searchButton.click();
            } else {
                // If no button found, try pressing Enter
                await addressInput.press('Enter');
            }
        }
        
        // Wait for results page
        await page.waitForTimeout(5000);
        
        // Look for property results and extract owner information
        const ownerData = await page.evaluate(() => {
            // Look for owner information in various possible locations
            const textContent = document.body.textContent;
            
            // Try to find owner name patterns
            let ownerName = 'Not found';
            let mailingAddress = 'Not found';
            
            // Look for "Owner" or "Current Owner" sections
            const ownerElements = document.querySelectorAll('*');
            for (let element of ownerElements) {
                const text = element.textContent;
                if (text && (text.includes('Owner') || text.includes('OWNER'))) {
                    const parent = element.closest('table, div, section, tr');
                    if (parent) {
                        const parentText = parent.textContent;
                        // Extract owner information from parent element
                        const lines = parentText.split('\n').map(line => line.trim()).filter(line => line);
                        if (lines.length > 0) {
                            ownerName = lines[0];
                            if (lines.length > 1) {
                                mailingAddress = lines.slice(1).join(', ');
                            }
                        }
                        break;
                    }
                }
            }
            
            return { owner_name: ownerName, mailing_address: mailingAddress };
        });
        
        return {
            success: true,
            owner_name: ownerData.owner_name,
            mailing_address: ownerData.mailing_address
        };
        
    } catch (error) {
        console.error('Scraping error:', error);
        return {
            success: false,
            error: error.message,
            owner_name: 'Error occurred',
            mailing_address: 'Error occurred'
        };
    } finally {
        await browser.close();
    }
}

app.post('/fulton-property-search', async (req, res) => {
    try {
        const { address } = req.body;
        
        if (!address) {
            return res.status(400).json({ 
                success: false, 
                error: 'Address is required' 
            });
        }
        
        console.log(`Processing address: ${address}`);
        const result = await scrapeFultonProperty(address);
        
        res.json(result);
        
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/', (req, res) => {
    res.send('Fulton Scraper API is running!');
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Fulton County scraper running on port ${PORT}`);
});
