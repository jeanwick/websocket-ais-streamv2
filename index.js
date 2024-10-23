const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3015;

let shipsData = [];
let ws = null; // Track the WebSocket instance
// let currentBoundingBox = [[-25.7205, 32.8762], [-25.9626, 32.0822]]; // Default bounding box (Durban)
let currentBoundingBox = [[-38.88, 31.03], [-20.88, 42.74]];

app.use(cors());
app.use(express.json()); // To parse JSON bodies

// WebSocket connection to AIS stream
function connectAISStream() {
  if (ws) {
    ws.close(); // Close the current WebSocket connection if exists
  }

  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.onopen = () => {
    console.log('WebSocket connection opened.');
    const subscriptionMessage = {
      APIKey: 'd19b998ef294b9e5e4889c8df050742eddf303bc',
      BoundingBoxes: [currentBoundingBox], // Use the dynamic bounding box
      FilterMessageTypes: ['PositionReport'],
    };

    ws.send(JSON.stringify(subscriptionMessage));
  };

  ws.onmessage = (message) => {
    const data = JSON.parse(message.data.toString()); // Decode the buffer to a string and parse as JSON
    console.log('Message received from AIS stream:', data);
  
    if (data.Message && data.Message.PositionReport) {
      const shipData = {
        mmsi: data.MetaData.MMSI_String,
        lat: data.Message.PositionReport.Latitude,
        lon: data.Message.PositionReport.Longitude,
        speed: data.Message.PositionReport.Sog || 0,
        course: data.Message.PositionReport.Cog || 0,
        timestamp: data.MetaData.time_utc,  // Add timestamp
      };
  
      // Add or update ships data
      const existingIndex = shipsData.findIndex((ship) => ship.mmsi === shipData.mmsi);
      if (existingIndex !== -1) {
        shipsData[existingIndex] = shipData;
      } else {
        shipsData.push(shipData);
      }
    }
  };

  ws.onclose = () => {
    console.log('WebSocket connection closed');
    setTimeout(connectAISStream, 1000); // Reconnect after 1 second
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

// Initial WebSocket connection
connectAISStream();

// Enable CORS (for frontend connection)
app.use(cors());

// API endpoint to serve ship data to frontend
app.get('/api/ships', (req, res) => {
  res.json(shipsData);
});

// New endpoint to update the bounding box
app.post('/api/update-bounding-box', (req, res) => {
  const { boundingBox } = req.body;
  if (boundingBox && Array.isArray(boundingBox) && boundingBox.length === 2) {
    console.log('Received new bounding box:', boundingBox);
    currentBoundingBox = boundingBox; // Update the current bounding box
    connectAISStream(); // Reconnect WebSocket with new bounding box
    res.status(200).json({ message: 'Bounding box updated and WebSocket reconnected.' });
  } else {
    res.status(400).json({ error: 'Invalid bounding box format.' });
  }
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});