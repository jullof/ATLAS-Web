const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// Admin şifresi artık environment'tan okunuyor
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'dev-secret';

const app = express();
const PORT = 3000;

// --- STATIC DOSYALAR ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(cors());
app.use(express.json());

// --- MULTER (UPLOAD) ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

// --- DOCUMENTS JSON HELPER ---
const docsPath = path.join(__dirname, 'documents.json');

function readDocuments() {
  if (!fs.existsSync(docsPath)) {
    fs.writeFileSync(docsPath, '[]', 'utf8');
  }
  const raw = fs.readFileSync(docsPath, 'utf8') || '[]';
  return JSON.parse(raw);
}

function writeDocuments(docs) {
  fs.writeFileSync(docsPath, JSON.stringify(docs, null, 2), 'utf8');
}

// --- GET: TÜM DOKÜMANLAR ---
app.get('/api/documents', (req, res) => {
  try {
    const docs = readDocuments();
    res.json(docs);
  } catch (err) {
    console.error('GET /api/documents error:', err);
    res.status(500).json({ error: 'Cannot read documents.json' });
  }
});

// --- POST: UPLOAD YENİ DOKÜMAN ---
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const { title, description, date, type, secret } = req.body;

    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    const docs = readDocuments();
    const newId = (docs[docs.length - 1]?.id || 0) + 1;

    const newDoc = {
      id: newId,
      title: title || req.file.originalname,
      description: description || '',
      date: date || new Date().toISOString().slice(0, 10),
      type: type || 'PDF',
      file: req.file.filename
    };

    docs.push(newDoc);
    writeDocuments(docs);

    res.json({ success: true, document: newDoc });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// --- PUT: DOKÜMAN METADATA GÜNCELLE ---
app.put('/api/documents/:id', (req, res) => {
  try {
    const { secret, title, description, date, type } = req.body;
    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const docId = Number(req.params.id);
    const docs = readDocuments();
    const index = docs.findIndex(d => d.id === docId);

    if (index === -1) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (title !== undefined) docs[index].title = title;
    if (description !== undefined) docs[index].description = description;
    if (date !== undefined) docs[index].date = date;
    if (type !== undefined) docs[index].type = type;

    writeDocuments(docs);
    res.json({ success: true, document: docs[index] });
  } catch (err) {
    console.error('PUT /api/documents/:id error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// --- POST: DOKÜMAN SİL ---
app.post('/api/documents/delete', (req, res) => {
  try {
    const { id, secret } = req.body;
    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const docId = Number(id);
    const docs = readDocuments();
    const index = docs.findIndex(d => d.id === docId);

    if (index === -1) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const [removed] = docs.splice(index, 1);
    writeDocuments(docs);

    // PDF dosyasını da silmeye çalış
    if (removed && removed.file) {
      const filePath = path.join(__dirname, 'uploads', removed.file);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (fileErr) {
        console.warn('Warning: could not delete file', filePath, fileErr);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/documents/delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.listen(PORT, () => {
  console.log(`ATLAS server running at http://localhost:${PORT}`);
});
