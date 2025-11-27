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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage });

/**
 * Admin işlemlerini event_logs tablosuna yazan helper
 * action örnekleri:
 *  - ADMIN_UPLOAD_OK / ADMIN_UPLOAD_DENIED
 *  - ADMIN_UPDATE_OK / ADMIN_UPDATE_DENIED
 *  - ADMIN_DELETE_OK / ADMIN_DELETE_DENIED
 */
async function logAdminEvent(req, { action, fileName = null, extra = null }) {
  try {
    const ip = getClientIp(req);
    const path = req.originalUrl || '/admin';

    const { error } = await supabase
      .from('event_logs')
      .insert({
        ip_address: ip || null,
        path,
        action,
        file_name: fileName,
        extra
      });

    if (error) {
      console.error('logAdminEvent error:', error);
    }
  } catch (err) {
    console.error('logAdminEvent unexpected error:', err);
  }
}


// --- IP HELPER ---
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || null;
}


// --- GET ALL DOCUMENTS ---
app.get('/api/documents', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      console.error('GET /api/documents Supabase error:', error);
      return res.status(500).json({ error: 'Cannot read documents' });
    }

    res.json(data || []);
  } catch (err) {
    console.error('GET /api/documents error:', err);
    res.status(500).json({ error: 'Cannot read documents' });
  }
});


// --- UPLOAD DOCUMENT (Supabase + DB) ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { title, description, date, type, secret } = req.body;

    // Yanlış şifre denemesini logla
    if (secret !== ADMIN_SECRET) {
      await logAdminEvent(req, {
        action: 'ADMIN_UPLOAD_DENIED',
        extra: {
          reason: 'wrong secret',
          originalName: req.file?.originalname || null
        }
      });
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

    const publicUrl = urlData?.publicUrl || '';

    // --- METADATA'YI documents TABLOSUNA YAZ ---
    const { data: inserted, error: insertError } = await supabase
      .from('documents')
      .insert({
        title: title || req.file.originalname,
        description: description || '',
        date: date || new Date().toISOString().slice(0, 10),
        type: type || 'PDF',
        file: fileName,
        url: publicUrl
      })
      .select()
      .single();

    if (insertError) {
      console.error('Insert documents error:', insertError);
      return res.status(500).json({ error: 'Failed to save document metadata' });
    }

    // --- BAŞARILI UPLOAD LOGU ---
    await logAdminEvent(req, {
      action: 'ADMIN_UPLOAD_OK',
      fileName,
      extra: {
        id: inserted.id,
        title: inserted.title
      }
    });

    res.json({ success: true, document: inserted });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});


// --- UPDATE DOCUMENT (Supabase DB) ---
app.put('/api/documents/:id', async (req, res) => {
  try {
    const { secret, title, description, date, type } = req.body;
    const docId = Number(req.params.id);

    // Yanlış şifre DENEMESİNİ logla
    if (secret !== ADMIN_SECRET) {
      await logAdminEvent(req, {
        action: 'ADMIN_UPDATE_DENIED',
        extra: { docId, reason: 'wrong secret' }
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data, error } = await supabase
      .from('documents')
      .update({ title, description, date, type })
      .eq('id', docId)
      .select()
      .single();

    if (error) {
      console.error('Update document error:', error);
      return res.status(500).json({ error: 'Failed to update document' });
    }

    // Başarılı UPDATE’i de logla
    await logAdminEvent(req, {
      action: 'ADMIN_UPDATE_OK',
      fileName: data.file || null,
      extra: { docId, title: data.title }
    });

    res.json({ success: true, document: data });
  } catch (err) {
    console.error('PUT /api/documents/:id error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});


// --- DELETE DOCUMENT (Supabase DB + Storage) ---
app.post('/api/documents/delete', async (req, res) => {
  try {
    const { id, secret } = req.body;
    const docId = Number(id);

    // Yanlış şifre denemesini logla
    if (secret !== ADMIN_SECRET) {
      await logAdminEvent(req, {
        action: 'ADMIN_DELETE_DENIED',
        extra: { docId, reason: 'wrong secret' }
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Önce veritabanındaki kaydı bul
    const { data: doc, error: fetchError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', docId)
      .single();

    if (fetchError || !doc) {
      console.error('Fetch document before delete error:', fetchError);
      return res.status(404).json({ error: 'Document not found' });
    }

    // Storage'tan dosyayı sil
    if (doc.file) {
      const { error: delError } = await supabase.storage
        .from('atlas-documents')
        .remove([doc.file]);

      if (delError) {
        console.warn('Warning: could not delete file from Supabase', delError);
      }
    }

    // Tablo kaydını sil
    const { error: deleteRowError } = await supabase
      .from('documents')
      .delete()
      .eq('id', docId);

    if (deleteRowError) {
      console.error('Delete row error:', deleteRowError);
      return res.status(500).json({ error: 'Failed to delete metadata' });
    }

    // Başarılı DELETE logu
    await logAdminEvent(req, {
      action: 'ADMIN_DELETE_OK',
      fileName: doc.file || null,
      extra: { docId, title: doc.title }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/documents/delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});


// --- GENERIC LOG ENDPOINT (frontend logger.js kullanıyor) ---
app.post('/api/log', async (req, res) => {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  const { action, path: reqPath, fileName, extra } = req.body || {};

  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }

  try {
    const { error } = await supabase
      .from('event_logs')
      .insert({
        ip_address: ip,
        path: reqPath || null,
        action,
        file_name: fileName || null,
        extra: { userAgent, ...(extra || {}) }
      });

    if (error) {
      console.error('Log insert error:', error);
      return res.status(500).json({ error: 'log insert failed' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/log error:', err);
    res.status(500).json({ error: 'server error' });
  }
});


app.listen(PORT, () => {
  console.log(`ATLAS server running at http://localhost:${PORT}`);
});
