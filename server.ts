import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { google } from "googleapis";
import * as cheerio from "cheerio";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // API routes
  app.post("/api/web/browse", async (req, res) => {
    const { url, selector } = req.body;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const html = await response.text();
      const $ = cheerio.load(html);
      
      // Remove scripts, styles, and other non-content tags
      $('script, style, noscript, iframe, svg').remove();
      
      if (selector) {
        // Extract specific content
        let content = $(selector).text().trim();
        content = content.replace(/\s+/g, ' ').substring(0, 15000); // limit to 15k chars
        res.json({ content });
      } else {
        // Return page structure
        const title = $('title').text().trim();
        
        const headings: { level: string, text: string }[] = [];
        $('h1, h2, h3').each((_, el) => {
          const text = $(el).text().trim().replace(/\s+/g, ' ');
          if (text) headings.push({ level: el.tagName.toLowerCase(), text });
        });

        const links: { text: string, href: string }[] = [];
        $('a').each((_, el) => {
          let href = $(el).attr('href');
          const text = $(el).text().trim().replace(/\s+/g, ' ').substring(0, 100);
          if (href && text) {
            // Resolve relative URLs
            if (href.startsWith('/')) {
              try {
                const baseUrl = new URL(url);
                href = `${baseUrl.origin}${href}`;
              } catch (e) {}
            }
            if (href.startsWith('http')) {
              // Deduplicate links
              if (!links.find(l => l.href === href)) {
                links.push({ text, href });
              }
            }
          }
        });

        res.json({ 
          title, 
          headings: headings.slice(0, 30), 
          links: links.slice(0, 100) 
        });
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/api/web/search", async (req, res) => {
    const { query } = req.body;
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const results: { title: string, link: string, snippet: string }[] = [];
      $('.result').each((_, el) => {
        const title = $(el).find('.result__title').text().trim();
        const link = $(el).find('.result__url').attr('href');
        const snippet = $(el).find('.result__snippet').text().trim();
        
        if (title && link) {
          // DuckDuckGo sometimes uses relative URLs for its own services, but external links are absolute or redirect URLs.
          // We can try to extract the actual URL if it's a redirect.
          let actualLink = link;
          if (link.startsWith('//duckduckgo.com/l/?uddg=')) {
            try {
              actualLink = decodeURIComponent(link.split('uddg=')[1].split('&')[0]);
            } catch (e) {}
          } else if (link.startsWith('/')) {
            actualLink = `https://duckduckgo.com${link}`;
          } else if (!link.startsWith('http')) {
            actualLink = `https://${link}`;
          }
          
          results.push({ title, link: actualLink, snippet });
        }
      });

      res.json({ results: results.slice(0, 10) });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/api/earthengine/query", async (req, res) => {
    const { endpoint, payload } = req.body;
    
    if (!process.env.EE_PRIVATE_KEY || !process.env.EE_CLIENT_EMAIL) {
      return res.status(400).json({ 
        error: "Earth Engine credentials not configured. Please set EE_PRIVATE_KEY and EE_CLIENT_EMAIL in your environment variables." 
      });
    }

    try {
      const auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: process.env.EE_CLIENT_EMAIL,
          private_key: process.env.EE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/earthengine'],
      });
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      
      const response = await fetch(`https://earthengine.googleapis.com/v1/${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
