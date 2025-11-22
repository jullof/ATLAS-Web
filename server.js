require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');


const ADMIN_SECRET = process.env.ADMIN_SECRET || 'dev-secret';

const app = express();
const PORT = 3000;

// --- STATIC DOSYALAR ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(cors());
app.use(express.json());

// --- MULTER (MEMORY STORAGE) ---
const storage = multer.memoryStorage();
const upload = multer({ storage });

// --- DOCUMENTS.JSON ---
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

// --- GET ALL DOCUMENTS ---
app.get('/api/documents', (req, res) => {
  try {
    const docs = readDocuments();
    res.json(docs);
  } catch (err) {
    console.error('GET /api/documents error:', err);
    res.status(500).json({ error: 'Cannot read documents.json' });
  }
});

// --- UPLOAD DOCUMENT (Supabase) ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { title, description, date, type, secret } = req.body;

    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    const safeOriginalName = req.file.originalname.replace(/\s+/g, '_');
    const fileName = `${Date.now()}-${safeOriginalName}`;

    // --- Supabase upload (bucket: atlas-documents) ---
    const { error: uploadError } = await supabase.storage
      .from('atlas-documents')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype || 'application/pdf',
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload to Supabase' });
    }

    // Public URL
    const { data: urlData } = supabase.storage
      .from('atlas-documents')
      .getPublicUrl(fileName);

    const docs = readDocuments();
    const newId = (docs[docs.length - 1]?.id || 0) + 1;

    const newDoc = {
      id: newId,
      title: title || req.file.originalname,
      description: description || '',
      date: date || new Date().toISOString().slice(0, 10),
      type: type || 'PDF',
      file: fileName,
      url: urlData.publicUrl || ''
    };

    docs.push(newDoc);
    writeDocuments(docs);

    res.json({ success: true, document: newDoc });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// --- UPDATE DOCUMENT ---
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

// --- DELETE DOCUMENT (Supabase) ---
app.post('/api/documents/delete', async (req, res) => {
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

    // --- Supabase delete ---
    if (removed && removed.file) {
      const { error: delError } = await supabase.storage
        .from('atlas-documents')
        .remove([removed.file]);

      if (delError) {
        console.warn('Warning: could not delete file from Supabase', delError);
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
