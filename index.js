// index.js

const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
require('dotenv').config(); // To load environment variables from .env

const app = express();
const PORT = process.env.PORT || 3015;

let shipsData = [];

let ws = null;
let currentBoundingBox = [
  [-38.88, 31.03], [-20.88, 42.74],  // Durban (but big)
  [[-33.895056, 18.410718], [-34.013399, 18.452209]], // Cape Town
  [[-34.017609, 25.612232], [-33.964904, 25.689558]]  // Port Elizabeth
];

let connectionState = {
  lastConnectionTimestamp: null,  // Track the last successful WebSocket connection
  isConnected: false              // Indicates whether the WebSocket is currently connected
};

app.use(cors());
app.use(express.json()); // To parse JSON bodies

// Load shipsData from Blob storage if it exists
async function loadShipsData() {
  try {
    const response = await fetch('https://blob.vercel-storage.com/shipsData.json', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.VERCEL_BLOB_READ_WRITE_TOKEN}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      shipsData = data;
      console.log('Loaded shipsData from Blob storage.');
    } else if (response.status === 404) {
      console.log('shipsData.json not found in Blob storage. Starting with empty data.');
      shipsData = [];
    } else {
      throw new Error(`Failed to fetch shipsData.json: ${response.statusText}`);
    }
  } catch (err) {
    console.error('Error reading shipsData from Blob storage:', err);
  }
}

// Call loadShipsData at startup
loadShipsData();

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
      APIKey: 'd19b998ef294b9e5e4889c8df050742eddf303bc', // Your API Key
      BoundingBoxes: [currentBoundingBox], // Use the dynamic bounding box
      FilterMessageTypes: ['PositionReport'],
    };

    ws.send(JSON.stringify(subscriptionMessage));
  };

  ws.onmessage = (message) => {
    const data = JSON.parse(message.data.toString());
    console.log('Message received from AIS stream:', data);
    
    if (data.Message && data.Message.PositionReport) {
      const shipData = {
        mmsi: data.MetaData.MMSI_String,
        lat: data.Message.PositionReport.Latitude,
        lon: data.Message.PositionReport.Longitude,
        speed: data.Message.PositionReport.Sog || 0,
        course: data.Message.PositionReport.Cog || 0,
        timestamp: data.MetaData.time_utc,  // Added timestamp
      };

      // Update existing ship data or add new ship data
      const existingIndex = shipsData.findIndex((ship) => ship.mmsi === shipData.mmsi);
      if (existingIndex !== -1) {
        shipsData[existingIndex] = { ...shipsData[existingIndex], ...shipData }; // Update ship
      } else {
        shipsData.push(shipData);  // Add new ship
      }

      // Write shipsData to Blob storage
      (async () => {
        try {
          const response = await fetch('https://blob.vercel-storage.com/shipsData.json', {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${process.env.VERCEL_BLOB_READ_WRITE_TOKEN}`,
              'Content-Type': 'application/json',
              'x-vercel-blob-access': 'public',
            },
            body: JSON.stringify(shipsData),
          });

          if (response.ok) {
            console.log('shipsData updated in Blob storage');
          } else {
            throw new Error(`Failed to update shipsData.json: ${response.statusText}`);
          }
        } catch (err) {
          console.error('Error writing shipsData to Blob storage:', err);
        }
      })();
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

// Initial WebSocket connection
connectAISStream();

// API endpoint to serve ship data to external services
app.get('/api/ships', async (req, res) => {
  // If shipsData is empty, try to load it from Blob storage
  if (!shipsData.length) {
    await loadShipsData();
  }

  const responsePayload = {
    data: shipsData,
    isConnected: connectionState.isConnected,
    lastConnectionTimestamp: connectionState.lastConnectionTimestamp,
  };

  if (!connectionState.isConnected) {
    console.log(`Connection down, serving data from: ${connectionState.lastConnectionTimestamp}`);
    res.status(200).json({
      message: `Connection is down, showing last known data from ${connectionState.lastConnectionTimestamp}`,
      ...responsePayload
    });
  } else {
    res.status(200).json(responsePayload); // Send live data if connected
  }
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});