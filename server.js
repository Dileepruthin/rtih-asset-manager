const express = require('express');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const multer = require('multer'); 

const app = express();
const port = process.env.PORT || 3000; 

// THE MAGIC CONNECTION FIX: FORCES CHROME TO ALLOW THE SYNC
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

const SPREADSHEET_ID = '1XlYosWoHnu9zEvw5bJkGBcEMtrhAhsszA84obI3YzOg'; 

// 🔥 THE VERCEL FIX: We only write to the temporary folder! No 'mkdirSync' allowed.
const uploadDir = '/tmp';

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir) },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-')); }
});
const upload = multer({ storage: storage });

let auth;
if (process.env.GOOGLE_CREDENTIALS) {
    const keys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({
        credentials: { client_email: keys.client_email, private_key: keys.private_key },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
} else {
    auth = new google.auth.GoogleAuth({
        keyFile: 'credentials.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
}

const sheets = google.sheets({ version: 'v4', auth });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let liveClients = [];

async function getInventoryFromSheet() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A2:K', 
        });
        const rows = response.data.values || [];
        return rows.map((row, index) => ({
            id: row[0],
            location: row[1],
            category: row[2],
            asset: row[3],
            quantity: parseInt(row[4]) || 0,
            photoUrl: row[5] || "",
            purchaseDate: row[6] || "",
            deliveryDate: row[7] || "",
            putInUseDate: row[8] || "",
            price: row[9] || "",
            depreciationRate: row[10] || "",
            rowNumber: index + 2 
        })).filter(item => item.id);
    } catch (error) {
        console.error("Error reading from Google Sheets:", error);
        return [];
    }
}

app.get('/api/inventory/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    const currentData = await getInventoryFromSheet();
    res.write(`data: ${JSON.stringify(currentData)}\n\n`);
    liveClients.push(res);
    req.on('close', () => { liveClients = liveClients.filter(client => client !== res); });
});

app.post('/api/inventory', upload.single('photoFile'), async (req, res) => {
    let finalPhotoUrl = "";
    if (req.file) finalPhotoUrl = '/uploads/' + req.file.filename;

    const newItem = {
        id: Date.now(),
        location: req.body.location,
        category: req.body.category || "General",
        asset: req.body.asset,
        quantity: parseInt(req.body.quantity) || 0,
        photoUrl: finalPhotoUrl,
        purchaseDate: req.body.purchaseDate || "",
        deliveryDate: req.body.deliveryDate || "",
        putInUseDate: req.body.putInUseDate || "",
        price: req.body.price || "",
        depreciationRate: req.body.depreciationRate || ""
    };
    
    try {
       await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:A', 
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS', 
            requestBody: { values: [[newItem.id, newItem.location, newItem.category, newItem.asset, newItem.quantity, newItem.photoUrl, newItem.purchaseDate, newItem.deliveryDate, newItem.putInUseDate, newItem.price, newItem.depreciationRate]] },
        });
        const updatedInventory = await getInventoryFromSheet();
        liveClients.forEach(client => client.write(`data: ${JSON.stringify(updatedInventory)}\n\n`));
        res.status(201).json({ success: true, item: newItem });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.put('/api/inventory/:id', upload.single('photoFile'), async (req, res) => {
    const idToEdit = req.params.id;
    try {
        const inventory = await getInventoryFromSheet();
        const existingItem = inventory.find(i => i.id == idToEdit);
        if (!existingItem) return res.status(404).json({ success: false });

        let finalPhotoUrl = existingItem.photoUrl;
        if (req.file) finalPhotoUrl = '/uploads/' + req.file.filename;

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Sheet1!A${existingItem.rowNumber}:K${existingItem.rowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[idToEdit, req.body.location, req.body.category, req.body.asset, req.body.quantity, finalPhotoUrl, req.body.purchaseDate, req.body.deliveryDate, req.body.putInUseDate, req.body.price, req.body.depreciationRate]] },
        });

        const updatedInventory = await getInventoryFromSheet();
        liveClients.forEach(client => client.write(`data: ${JSON.stringify(updatedInventory)}\n\n`));
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/inventory/:id', async (req, res) => {
    const idToDelete = req.params.id;
    try {
        const inventory = await getInventoryFromSheet();
        const existingItem = inventory.find(i => i.id == idToDelete);
        
        if (!existingItem) return res.status(404).json({ success: false });

        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `Sheet1!A${existingItem.rowNumber}:K${existingItem.rowNumber}`
        });

        const updatedInventory = await getInventoryFromSheet();
        liveClients.forEach(client => client.write(`data: ${JSON.stringify(updatedInventory)}\n\n`));
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

module.exports = app;
