// index.js

require('dotenv').config(); // Load environment variables at the very top

const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const { sql } = require('@vercel/postgres'); // Use the sql function

const app = express();
const PORT = process.env.PORT || 3015;

let ws = null;
const currentBoundingBox = [
  [-38.88, 31.03], [-20.88, 42.74],  // Durban area
  [[-33.895056, 18.410718], [-34.013399, 18.452209]], // Cape Town
  [[-34.017609, 25.612232], [-33.964904, 25.689558]]  // Port Elizabeth
];

let connectionState = {
  lastConnectionTimestamp: null,
  isConnected: false
};

app.use(cors());
app.use(express.json());

// In-memory cache for ship data
const shipDataCache = new Map();

// Initialize database and create indexes
async function initializeDatabase() {
  try {
    console.log('Initializing database...');

    await sql`
      CREATE TABLE IF NOT EXISTS ships (
        mmsi VARCHAR(9) PRIMARY KEY,
        lat NUMERIC(9,6),
        lon NUMERIC(9,6),
        speed REAL,
        course REAL,
        timestamp TIMESTAMP
      )
    `;
    console.log('Ships table is ready.');

    await sql`
      CREATE INDEX IF NOT EXISTS idx_ships_mmsi ON ships (mmsi)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ships_timestamp ON ships (timestamp)
    `;
    console.log('Indexes created.');
  } catch (err) {
    console.error('Error initializing database:', err);
    process.exit(1); // Exit if database cannot be initialized
  }
}

// WebSocket connection to AIS stream
function connectAISStream() {
  if (ws) {
    ws.close(); // Close the current WebSocket connection if it exists
  }

  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.onopen = () => {
    console.log('WebSocket connection opened.');
    connectionState.isConnected = true;  // Mark connection as active
    connectionState.lastConnectionTimestamp = new Date().toISOString();  // Record connection time

    const subscriptionMessage = {
      APIKey: process.env.AIS_API_KEY, // Use your AIS API Key from environment variable
      BoundingBoxes: [currentBoundingBox], // Use the dynamic bounding box
      FilterMessageTypes: ['PositionReport'],
    };

    ws.send(JSON.stringify(subscriptionMessage));
  };

  ws.onmessage = (message) => {
    const data = JSON.parse(message.data.toString());

    if (data.Message && data.Message.PositionReport) {
      const mmsi = data.MetaData.MMSI_String;
      const shipData = {
        mmsi: mmsi,
        lat: data.Message.PositionReport.Latitude,
        lon: data.Message.PositionReport.Longitude,
        speed: data.Message.PositionReport.Sog || 0,
        course: data.Message.PositionReport.Cog || 0,
        timestamp: new Date(data.MetaData.time_utc),
      };

      // Update in-memory cache
      shipDataCache.set(mmsi, shipData);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket connection closed');
    connectionState.isConnected = false;  // Mark connection as closed
    setTimeout(connectAISStream, 1000); // Reconnect after 1 second
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    connectionState.isConnected = false;  // Mark as disconnected on error
  };
}

// Function to batch insert/update ship data
async function flushShipDataCache() {
  if (shipDataCache.size === 0) return;

  const shipsToUpdate = Array.from(shipDataCache.values());
  shipDataCache.clear();

  const mmsis = shipsToUpdate.map((ship) => ship.mmsi);
  const lats = shipsToUpdate.map((ship) => ship.lat);
  const lons = shipsToUpdate.map((ship) => ship.lon);
  const speeds = shipsToUpdate.map((ship) => ship.speed);
  const courses = shipsToUpdate.map((ship) => ship.course);
  const timestamps = shipsToUpdate.map((ship) => ship.timestamp);

  try {
    await sql`
      INSERT INTO ships (mmsi, lat, lon, speed, course, timestamp)
      SELECT
        UNNEST(${mmsis}::varchar[]),
        UNNEST(${lats}::numeric[]),
        UNNEST(${lons}::numeric[]),
        UNNEST(${speeds}::real[]),
        UNNEST(${courses}::real[]),
        UNNEST(${timestamps}::timestamp[])
      ON CONFLICT (mmsi)
      DO UPDATE SET
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        speed = EXCLUDED.speed,
        course = EXCLUDED.course,
        timestamp = EXCLUDED.timestamp
    `;
    console.log(`Batch updated ${shipsToUpdate.length} ships.`);
  } catch (err) {
    console.error('Error batch updating ship data:', err);
  }
}

// Flush cache every 5 minutes
setInterval(flushShipDataCache, 300000);

// Function to delete records older than 24 hours
async function deleteOldRecords() {
  try {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - 1); // 24 hours ago

    await sql`
      DELETE FROM ships
      WHERE timestamp < ${thresholdDate}
    `;
    console.log('Deleted records older than 24 hours.');
  } catch (err) {
    console.error('Error deleting old records:', err);
  }
}

// Run cleanup every hour
setInterval(deleteOldRecords, 3600000);

// API endpoint to serve ship data to external services with query parameters
app.get('/api/ships', async (req, res) => {
  // Extract query parameters
  const {
    mmsi,
    latMin,
    latMax,
    lonMin,
    lonMax,
    speedMin,
    speedMax,
    courseMin,
    courseMax,
    timestampMin,
    timestampMax,
    page = 1,
    limit = 100,
  } = req.query;

  const conditions = [];
  const values = [];

  if (mmsi) {
    conditions.push(`mmsi = $${values.length + 1}`);
    values.push(mmsi);
  }
  if (latMin) {
    conditions.push(`lat >= $${values.length + 1}`);
    values.push(parseFloat(latMin));
  }
  if (latMax) {
    conditions.push(`lat <= $${values.length + 1}`);
    values.push(parseFloat(latMax));
  }
  if (lonMin) {
    conditions.push(`lon >= $${values.length + 1}`);
    values.push(parseFloat(lonMin));
  }
  if (lonMax) {
    conditions.push(`lon <= $${values.length + 1}`);
    values.push(parseFloat(lonMax));
  }
  if (speedMin) {
    conditions.push(`speed >= $${values.length + 1}`);
    values.push(parseFloat(speedMin));
  }
  if (speedMax) {
    conditions.push(`speed <= $${values.length + 1}`);
    values.push(parseFloat(speedMax));
  }
  if (courseMin) {
    conditions.push(`course >= $${values.length + 1}`);
    values.push(parseFloat(courseMin));
  }
  if (courseMax) {
    conditions.push(`course <= $${values.length + 1}`);
    values.push(parseFloat(courseMax));
  }
  if (timestampMin) {
    conditions.push(`timestamp >= $${values.length + 1}`);
    values.push(new Date(timestampMin));
  }
  if (timestampMax) {
    conditions.push(`timestamp <= $${values.length + 1}`);
    values.push(new Date(timestampMax));
  }

  const offset = (page - 1) * limit;
  const limitValue = parseInt(limit);
  const offsetValue = parseInt(offset);

  let whereClause = '';
  if (conditions.length > 0) {
    whereClause = 'WHERE ' + conditions.join(' AND ');
  }

  const queryText = `
    SELECT * FROM ships
    ${whereClause}
    ORDER BY mmsi
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `;
  values.push(limitValue, offsetValue);

  try {
    const result = await sql.query(queryText, values);

    const totalResults = result.rowCount;

    const responsePayload = {
      data: result.rows,
      isConnected: connectionState.isConnected,
      lastConnectionTimestamp: connectionState.lastConnectionTimestamp,
      totalResults: totalResults,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalResults / limit),
    };

    res.status(200).json(responsePayload);
  } catch (err) {
    console.error('Error querying ships data:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start the server and initialize connections
(async () => {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  connectAISStream();
})();

// Handle application shutdown
process.on('exit', async () => {
  await flushShipDataCache();
  console.log('Flushed ship data cache on exit.');
});

process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});