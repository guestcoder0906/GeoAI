import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { google } from "googleapis";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // API routes
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
