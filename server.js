const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { google } = require('googleapis');
const multer = require('multer');
const sharp = require('sharp');

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

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
    storage: multer.diskStorage({
        destination: function (_req, _file, cb) {
            cb(null, uploadDir);
        },
        filename: function (_req, file, cb) {
            const safeName = (file.originalname || 'photo').replace(/[^a-zA-Z0-9.-]/g, '-');
            const extension = path.extname(safeName) || '.jpg';
            cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) return cb(null, true);
        cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp)'));
    }
});

async function uploadPhotoToImgBB(file) {
    const apiKey = process.env.IMG_BB_KEY;
    if (!apiKey) {
        console.warn('IMG_BB_KEY not configured, will use local storage');
        return '';
    }
    if (!file || !file.path) return '';

    try {
        const formData = new FormData();
        formData.append('image', fs.createReadStream(file.path));

        const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            console.error('ImgBB upload failed with status:', response.status);
            return '';
        }

        const payload = await response.json();
        return payload?.data?.url || '';
    } catch (error) {
        console.error('Failed to upload photo to ImgBB:', error.message);
        return '';
    }
}

async function createPhotoUrl(file) {
    if (!file || !file.path) return '';

    try {
        const remoteUrl = await uploadPhotoToImgBB(file);
        if (remoteUrl) {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
            return remoteUrl;
        }

        const outputName = `${path.basename(file.filename, path.extname(file.filename || ''))}.webp`;
        const outputPath = path.join(uploadDir, outputName);

        await sharp(file.path)
            .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 70 })
            .toFile(outputPath);

        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }

        return `/uploads/${outputName}`;
    } catch (error) {
        console.error('Failed to save uploaded photo:', error);
        return '';
    }
}

let auth;
console.log('Vercel GOOGLE_CREDENTIALS present:', !!process.env.GOOGLE_CREDENTIALS);
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
app.use('/uploads', express.static(uploadDir));
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
            id: String(row[0] || '').trim(),
            location: row[1] || '',
            category: row[2] || '',
            asset: row[3] || '',
            quantity: parseInt(String(row[4] || '').trim(), 10) || 0,
            photoUrl: row[5] || '',
            purchaseDate: row[6] || '',
            deliveryDate: row[7] || '',
            putInUseDate: row[8] || '',
            price: row[9] || '',
            depreciationRate: row[10] || '',
            rowNumber: index + 2 
        })).filter(item => item.id);
    } catch (error) {
        console.error("Error reading from Google Sheets:", error);
        return [];
    }
}

async function findSheetRowNumberById(id) {
    const targetId = String(id || '').trim();
    if (!targetId) return null;

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A2:K',
        });
        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(row => String(row[0] || '').trim() === targetId);
        return rowIndex >= 0 ? rowIndex + 2 : null;
    } catch (error) {
        console.error('Error locating sheet row by ID:', error);
        return null;
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

app.get('/api/inventory', async (req, res) => {
    const inventory = await getInventoryFromSheet();
    res.json(inventory);
}); 

app.get('/api/envstatus', (req, res) => {
    res.json({
        hasGoogleCredentials: !!process.env.GOOGLE_CREDENTIALS,
        googleCredentialsLength: process.env.GOOGLE_CREDENTIALS ? process.env.GOOGLE_CREDENTIALS.length : 0,
        usingCredentialsFile: !process.env.GOOGLE_CREDENTIALS,
        vercelEnv: process.env.VERCEL ? 'vercel' : 'local',
        nodeEnv: process.env.NODE_ENV || 'unset'
    });
});

app.post('/api/inventory', upload.single('photoFile'), async (req, res) => {
    console.log('📝 POST /api/inventory - Body:', {
        location: req.body.location,
        asset: req.body.asset,
        hasFile: !!req.file
    });
    
    // Validate required fields
    if (!req.body.location?.trim()) {
        console.warn('❌ Missing location');
        return res.status(400).json({ success: false, error: 'Location is required' });
    }
    if (!req.body.asset?.trim()) {
        console.warn('❌ Missing asset name');
        return res.status(400).json({ success: false, error: 'Asset name is required' });
    }

    let finalPhotoUrl = "";
    if (req.file) {
        console.log('📸 Processing file:', req.file.filename);
        finalPhotoUrl = await createPhotoUrl(req.file);
        console.log('✅ Photo URL:', finalPhotoUrl);
    }

    const newItem = {
        id: Date.now(),
        location: req.body.location.trim(),
        category: req.body.category?.trim() || "General",
        asset: req.body.asset.trim(),
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
        console.log('✅ Item saved:', newItem.id);
        const updatedInventory = await getInventoryFromSheet();
        liveClients.forEach(client => client.write(`data: ${JSON.stringify(updatedInventory)}\n\n`));
        res.status(201).json({ success: true, item: newItem });
    } catch (error) {
        console.error('❌ POST /api/inventory failed:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Failed to save inventory item' });
    }
});

app.put('/api/inventory/:id', upload.single('photoFile'), async (req, res) => {
    const idToEdit = req.params.id;
    console.log('📝 PUT /api/inventory/:id - ID:', idToEdit);
    
    // Validate required fields
    if (!req.body.location?.trim()) {
        console.warn('❌ Missing location');
        return res.status(400).json({ success: false, error: 'Location is required' });
    }
    if (!req.body.asset?.trim()) {
        console.warn('❌ Missing asset name');
        return res.status(400).json({ success: false, error: 'Asset name is required' });
    }
    
    try {
        const inventory = await getInventoryFromSheet();
        const existingItem = inventory.find(i => String(i.id) === String(idToEdit));
        if (!existingItem) {
            console.warn('❌ Item not found:', idToEdit);
            return res.status(404).json({ success: false, error: 'Inventory item not found' });
        }

        const rowNumber = await findSheetRowNumberById(idToEdit);
        if (rowNumber === null) {
            console.warn('❌ Row not found:', idToEdit);
            return res.status(404).json({ success: false, error: 'Failed to locate item in database' });
        }

        let finalPhotoUrl = existingItem.photoUrl;
        if (req.file) {
            console.log('📸 Processing file:', req.file.filename);
            finalPhotoUrl = await createPhotoUrl(req.file);
            console.log('✅ Photo URL:', finalPhotoUrl);
        }

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Sheet1!A${rowNumber}:K${rowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[idToEdit, req.body.location.trim(), req.body.category?.trim() || "General", req.body.asset.trim(), req.body.quantity, finalPhotoUrl, req.body.purchaseDate || "", req.body.deliveryDate || "", req.body.putInUseDate || "", req.body.price || "", req.body.depreciationRate || ""]] },
        });

        console.log('✅ Item updated:', idToEdit);
        const updatedInventory = await getInventoryFromSheet();
        liveClients.forEach(client => client.write(`data: ${JSON.stringify(updatedInventory)}\n\n`));
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('❌ PUT /api/inventory failed:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Failed to update inventory item' });
    }
});

app.delete('/api/inventory/:id', async (req, res) => {
    const idToDelete = req.params.id;
    try {
        const inventory = await getInventoryFromSheet();
        const existingItem = inventory.find(i => String(i.id) === String(idToDelete));
        
        if (!existingItem) return res.status(404).json({ success: false, error: 'Inventory item not found' });

        const rowNumber = await findSheetRowNumberById(idToDelete);
        if (rowNumber === null) return res.status(404).json({ success: false, error: 'Failed to locate item in database' });

        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `Sheet1!A${rowNumber}:K${rowNumber}`
        });

        const updatedInventory = await getInventoryFromSheet();
        liveClients.forEach(client => client.write(`data: ${JSON.stringify(updatedInventory)}\n\n`));
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('DELETE /api/inventory failed:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to delete inventory item' });
    }
});

// Error handling middleware (MUST be after all routes)
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'FILE_TOO_LARGE') {
            return res.status(400).json({ success: false, error: 'File is too large. Maximum size is 5MB' });
        }
        return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    } else if (err) {
        console.error('Unhandled error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
    }
    next();
});

// 🔥 RENDER FIX 2: We need an actual server listening on a port to keep the stream alive!
app.listen(port, () => {
    console.log(`\n🚀 RTIH Controller Engaged on Port ${port}`);
});