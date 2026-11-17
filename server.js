const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a random string of at least 32 characters.');
}
if (process.env.NODE_ENV === 'production' && !process.env.APP_BASE_URL) {
    throw new Error('APP_BASE_URL must be set to the public HTTPS site URL in production.');
}
if (Boolean(process.env.ADMIN_EMAIL) !== Boolean(process.env.ADMIN_PASSWORD)) {
    throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD to create the administrator account.');
}

const GMAIL_EMAIL = process.env.GMAIL_EMAIL;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'marketplace.sqlite');
const transporter = GMAIL_EMAIL && GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_EMAIL, pass: GMAIL_APP_PASSWORD } })
    : null;

function sendEmail(message) {
    if (!transporter) throw new Error('Email is not configured. Set GMAIL_EMAIL and GMAIL_APP_PASSWORD.');
    return transporter.sendMail({ from: GMAIL_EMAIL, ...message });
}

// --- WHATSAPP BOT SETUP ---
let waReady = false;
const puppeteerOptions = process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {};
const waClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerOptions
});
waClient.on('qr', (qr) => {
    console.log('\n==================================================');
    console.log('SCAN THIS QR WITH YOUR WHATSAPP TO ENABLE FREE OTPS');
    console.log('==================================================\n');
    qrcode.generate(qr, { small: true });
});
waClient.on('ready', () => {
    waReady = true;
    console.log('WhatsApp Bot is successfully connected and ready to send OTPs!');
});
waClient.on('disconnected', () => { waReady = false; });
if (process.env.WHATSAPP_ENABLED !== 'false') {
    waClient.initialize().catch((err) => console.error('WhatsApp client failed to initialize:', err));
}

app.use(cors()); 
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            return cb(new Error('Only JPEG, PNG, and WebP ID images are accepted.'));
        }
        cb(null, true);
    }
});

const db = new sqlite3.Database(DB_PATH);
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

async function ensureColumn(table, column, definition) {
    const columns = await dbAll(`PRAGMA table_info(${table})`);
    if (!columns.some((item) => item.name === column)) {
        await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

async function initializeDatabase() {
    await dbRun(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, phone TEXT UNIQUE, password TEXT, role TEXT, dob DATE, schoolName TEXT, gradeOrYear TEXT, idCardUrl TEXT, upiId TEXT, walletBalance INTEGER DEFAULT 0, isEmailVerified BOOLEAN DEFAULT 0, verificationToken TEXT, phoneOtp TEXT, isPhoneVerified BOOLEAN DEFAULT 0, resetToken TEXT, resetTokenExpiry DATETIME, isVerified BOOLEAN DEFAULT 0, isReverify BOOLEAN DEFAULT 0, isRejected BOOLEAN DEFAULT 0, isAdmin BOOLEAN DEFAULT 0,
        parent_name TEXT, parent_email TEXT, parent_phone TEXT, parent_upi_id TEXT, parent_id_image_path TEXT, parent_verification_status TEXT DEFAULT 'PENDING', is_parent_verified BOOLEAN DEFAULT 0
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, buyerId INTEGER, developerId INTEGER, title TEXT, description TEXT, budget INTEGER, status TEXT DEFAULT 'open', deliverableUrl TEXT, reviewScore INTEGER, reviewText TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS bids (id INTEGER PRIMARY KEY AUTOINCREMENT, jobId INTEGER, developerId INTEGER, amount INTEGER, message TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reportedUserId INTEGER, reporterId INTEGER, reason TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, jobId INTEGER, senderId INTEGER, text TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS feedbacks (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, type TEXT, message TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS follows (followerId INTEGER, followingId INTEGER, PRIMARY KEY(followerId, followingId))`);

    await ensureColumn('users', 'phoneOtpExpiry', 'INTEGER');
    await ensureColumn('users', 'parentApprovalToken', 'TEXT');
    await ensureColumn('users', 'parentApprovalTokenExpiry', 'INTEGER');
    await ensureColumn('jobs', 'fundedUtr', 'TEXT');
    await ensureColumn('jobs', 'fundingVerified', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('jobs', 'paidOutUtr', 'TEXT');
    await ensureColumn('jobs', 'payoutRequested', 'INTEGER NOT NULL DEFAULT 0');

    await dbRun("DELETE FROM users WHERE email = 'admin@system.com' AND name = 'System Admin'");
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        if (process.env.ADMIN_PASSWORD.length < 12) {
            throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
        }
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
        await dbRun(
            `INSERT OR IGNORE INTO users (email, password, name, role, isAdmin, isVerified, isEmailVerified, isPhoneVerified)
             VALUES (?, ?, 'System Admin', 'admin', 1, 1, 1, 1)`,
            [process.env.ADMIN_EMAIL, hash]
        );
    }
}

const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => { if (err) return res.sendStatus(403); req.user = user; next(); });
};
const requireAdmin = (req, res, next) => req.user.isAdmin ? next() : res.status(403).json({ error: 'Admin required' });

function calculateAge(dobString) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dobString || '')) return null;
    const birthDate = new Date(`${dobString}T00:00:00Z`);
    if (Number.isNaN(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== dobString) return null;
    const today = new Date();
    let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
    const monthDifference = today.getUTCMonth() - birthDate.getUTCMonth();
    if (monthDifference < 0 || (monthDifference === 0 && today.getUTCDate() < birthDate.getUTCDate())) age--;
    return age;
}

function isValidUpi(value) {
    return /^[a-zA-Z0-9._-]{2,100}@[a-zA-Z][a-zA-Z0-9]{1,30}$/.test(value || '');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

// --- AUTH & REGISTRATION ROUTE ---
app.post('/api/register', upload.single('idCard'), async (req, res, next) => {
    try {
        const { name, email, phone, password, role, dob, schoolName, gradeOrYear, parent_name, parent_email, parent_upi_id } = req.body;
        const age = calculateAge(dob);
        if (!name?.trim() || !email?.trim() || !phone || !password || !['buyer', 'developer'].includes(role)) {
            return res.status(400).json({ error: 'Name, email, phone, password, and a valid account type are required.' });
        }
        if (!/^[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit WhatsApp number.' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        if (age === null || age < 0) return res.status(400).json({ error: 'Enter a valid date of birth.' });
        if (age < 18 && role !== 'developer') return res.status(400).json({ error: 'Users under 18 must register as a developer with parent consent.' });
        if (role === 'developer' && (!schoolName?.trim() || !gradeOrYear?.trim())) {
            return res.status(400).json({ error: 'School and grade/year are required for developers.' });
        }
        if (role === 'developer' && age >= 18 && !req.file) {
            return res.status(400).json({ error: 'Upload a school or college ID for verification.' });
        }
        if (age < 18 && (!parent_name?.trim() || !parent_email?.trim() || !isValidUpi(parent_upi_id))) {
            return res.status(400).json({ error: 'Parent name, email, and a valid parent UPI ID are required.' });
        }
        if (!transporter) return res.status(503).json({ error: 'Email verification is unavailable. Please try again later.' });
        if (!waReady) return res.status(503).json({ error: 'Phone verification is unavailable. Please try again when WhatsApp is connected.' });

        const hash = await bcrypt.hash(password, 12);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const phoneOtp = String(crypto.randomInt(1000, 10000));
        const parentApprovalToken = age < 18 ? crypto.randomBytes(32).toString('hex') : null;
        const parentApprovalTokenExpiry = age < 18 ? Date.now() + 7 * 24 * 60 * 60 * 1000 : null;
        const idCardUrl = req.file ? `/uploads/${req.file.filename}` : null;
        const finalSchool = role === 'buyer' && age > 16 ? 'N/A' : (schoolName || null);
        const isVerified = role === 'buyer' ? 1 : 0;
        const result = await dbRun(
            `INSERT INTO users (name, email, phone, password, role, dob, schoolName, gradeOrYear, idCardUrl, isVerified, verificationToken, phoneOtp, phoneOtpExpiry, parent_name, parent_email, parent_phone, parent_upi_id, parentApprovalToken, parentApprovalTokenExpiry)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name.trim(), email.trim().toLowerCase(), phone, hash, role, dob, finalSchool, gradeOrYear || null, idCardUrl, isVerified, verificationToken, phoneOtp, Date.now() + 10 * 60 * 1000, age < 18 ? parent_name.trim() : null, age < 18 ? parent_email.trim().toLowerCase() : null, null, age < 18 ? parent_upi_id.trim() : null, parentApprovalToken, parentApprovalTokenExpiry]
        );
        const userId = result.lastID;

        try {
            const emailVerificationUrl = `${APP_BASE_URL}/api/verify-email/${verificationToken}`;
            await sendEmail({
                to: email.trim(),
                subject: 'Verify Your Account',
                html: `<h3>Welcome!</h3><p>Click <a href="${emailVerificationUrl}">here</a> to verify your email address.</p>`
            });
            if (parentApprovalToken) {
                const approvalUrl = `${APP_BASE_URL}/api/parent-approve/${parentApprovalToken}`;
                await sendEmail({
                    to: parent_email.trim(),
                    subject: "Approve Your Child's Freelance Account",
                    html: `<p>${escapeHtml(name)} has registered to freelance on TechnoDev.</p><p><a href="${approvalUrl}">Review and approve the account</a>. Payouts will use the parent UPI ID provided during registration.</p>`
                });
            }
            await waClient.sendMessage(`91${phone}@c.us`, `Welcome to TechnoDev. Your phone verification code is: ${phoneOtp}`);
        } catch (error) {
            await dbRun('DELETE FROM users WHERE id = ?', [userId]);
            console.error('Registration verification delivery failed:', error);
            return res.status(503).json({ error: 'Could not deliver verification messages. Please try again later.' });
        }
        res.json({ success: true, message: 'Account created. Check your email and WhatsApp to verify it.' });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') return res.status(400).json({ error: 'Email or phone number already exists.' });
        next(error);
    }
});

app.get('/api/parent-approve/:token', (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) return res.status(400).send('Invalid or expired approval link.');
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Parent approval</title><body><h1>Parent approval</h1><p>Confirm that you approve this account.</p><form method="post" action="/api/parent-approve"><input type="hidden" name="token" value="${escapeHtml(req.params.token)}"><button type="submit">Approve account</button></form></body></html>`);
});

app.post('/api/parent-approve', async (req, res, next) => {
    try {
        const result = await dbRun(
            `UPDATE users SET parent_verification_status = 'APPROVED', is_parent_verified = 1, parentApprovalToken = NULL, parentApprovalTokenExpiry = NULL,
             isVerified = CASE WHEN isEmailVerified = 1 AND isPhoneVerified = 1 THEN 1 ELSE 0 END
             WHERE parentApprovalToken = ? AND parentApprovalTokenExpiry > ? AND role = 'developer' AND dob > date('now', '-18 years')`,
            [req.body.token, Date.now()]
        );
        if (!result.changes) return res.status(400).send('Invalid or expired approval link.');
        res.send('<h1>Account approved</h1><p>The account can be used after email and phone verification are complete.</p>');
    } catch (error) {
        next(error);
    }
});

app.get('/api/verify-email/:token', async (req, res, next) => {
    try {
        const result = await dbRun(
            `UPDATE users SET isEmailVerified = 1, verificationToken = NULL,
             isVerified = CASE WHEN role = 'developer' AND is_parent_verified = 1 AND isPhoneVerified = 1 THEN 1 ELSE isVerified END
             WHERE verificationToken = ?`,
            [req.params.token]
        );
        if (!result.changes) return res.status(400).send('Invalid or expired verification link.');
        res.send('<h1>Email verified</h1><p>You can now log in once phone verification is complete.</p>');
    } catch (error) {
        next(error);
    }
});

app.post('/api/verify-phone', async (req, res, next) => {
    try {
        if (!/^[0-9]{4}$/.test(req.body.otp || '')) return res.status(400).json({ error: 'Enter the 4-digit verification code.' });
        const result = await dbRun(
            `UPDATE users SET isPhoneVerified = 1, phoneOtp = NULL, phoneOtpExpiry = NULL,
             isVerified = CASE WHEN role = 'developer' AND is_parent_verified = 1 AND isEmailVerified = 1 THEN 1 ELSE isVerified END
             WHERE email = ? AND phoneOtp = ? AND phoneOtpExpiry > ?`,
            [req.body.email, req.body.otp, Date.now()]
        );
        if (!result.changes) return res.status(400).json({ error: 'Invalid or expired verification code.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/resend-phone-otp', async (req, res, next) => {
    try {
        const email = req.body.email?.trim().toLowerCase();
        const user = await dbGet(
            'SELECT id, phone, password, isPhoneVerified, phoneOtpExpiry FROM users WHERE email = ?',
            [email]
        );
        if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
            return res.status(400).json({ error: 'Invalid credentials.' });
        }
        if (user.isPhoneVerified) return res.status(400).json({ error: 'This phone number is already verified.' });
        if (user.phoneOtpExpiry > Date.now()) return res.status(429).json({ error: 'Wait for the current code to expire before requesting another.' });
        if (!waReady) return res.status(503).json({ error: 'Phone verification is unavailable. Please try again later.' });

        const otp = String(crypto.randomInt(1000, 10000));
        await dbRun(
            'UPDATE users SET phoneOtp = ?, phoneOtpExpiry = ? WHERE id = ? AND isPhoneVerified = 0',
            [otp, Date.now() + 10 * 60 * 1000, user.id]
        );
        try {
            await waClient.sendMessage(`91${user.phone}@c.us`, `Your TechnoDev phone verification code is: ${otp}`);
        } catch (error) {
            await dbRun('UPDATE users SET phoneOtp = NULL, phoneOtpExpiry = NULL WHERE id = ?', [user.id]);
            throw error;
        }
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/login', async (req, res, next) => {
    try {
        const user = await dbGet('SELECT * FROM users WHERE email = ?', [req.body.email?.trim().toLowerCase()]);
        if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
            return res.status(400).json({ error: 'Invalid credentials.' });
        }
        if (!user.isEmailVerified) return res.status(403).json({ error: 'needs_email' });
        if (!user.isPhoneVerified) return res.status(403).json({ error: 'needs_otp' });
        res.json({ token: jwt.sign({ id: user.id, role: user.role, isAdmin: user.isAdmin, isVerified: user.isVerified }, JWT_SECRET, { expiresIn: '7d' }) });
    } catch (error) {
        next(error);
    }
});

app.post('/api/forgot-password', async (req, res, next) => {
    try {
        if (!req.body.email || !transporter) {
            return res.status(503).json({ error: 'Password recovery is temporarily unavailable.' });
        }
        const resetToken = crypto.randomBytes(32).toString('hex');
        const result = await dbRun(
            'UPDATE users SET resetToken = ?, resetTokenExpiry = ? WHERE email = ?',
            [resetToken, Date.now() + 3600000, req.body.email.trim().toLowerCase()]
        );
        if (result.changes) {
            try {
                await sendEmail({
                    to: req.body.email.trim().toLowerCase(),
                    subject: 'Reset Your Password',
                    html: `<p>A password reset was requested for your TechnoDev account.</p><p><a href="${APP_BASE_URL}/?resetToken=${resetToken}">Reset your password</a>. This link expires in one hour.</p>`
                });
            } catch (error) {
                await dbRun('UPDATE users SET resetToken = NULL, resetTokenExpiry = NULL WHERE resetToken = ?', [resetToken]);
                throw error;
            }
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Password recovery delivery failed:', error);
        next(error);
    }
});

app.post('/api/reset-password', async (req, res, next) => {
    try {
        if (!/^[a-f0-9]{64}$/.test(req.body.token || '') || (req.body.newPassword || '').length < 8) {
            return res.status(400).json({ error: 'Use a valid reset link and a password of at least 8 characters.' });
        }
        const hash = await bcrypt.hash(req.body.newPassword, 12);
        const result = await dbRun(
            'UPDATE users SET password = ?, resetToken = NULL, resetTokenExpiry = NULL WHERE resetToken = ? AND resetTokenExpiry > ?',
            [hash, req.body.token, Date.now()]
        );
        if (!result.changes) return res.status(400).json({ error: 'Invalid or expired reset link.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// Profile Editing & Data
app.post('/api/profile/edit', authenticate, upload.single('idCard'), async (req, res, next) => {
    try {
        const { name, email, phone, dob, schoolName, gradeOrYear } = req.body;
        if (!name?.trim() || !email?.trim() || !/^[0-9]{10}$/.test(phone || '')) {
            return res.status(400).json({ error: 'Enter a name, valid email, and 10-digit phone number.' });
        }
        const user = await dbGet(
            'SELECT email, phone, dob, idCardUrl, schoolName, role, isVerified FROM users WHERE id = ?',
            [req.user.id]
        );
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if ((dob || null) !== user.dob) return res.status(400).json({ error: 'Date of birth cannot be changed after registration.' });
        const emailChanged = email.trim().toLowerCase() !== user.email;
        if (emailChanged && !transporter) return res.status(503).json({ error: 'Email verification is unavailable. Email was not changed.' });
        const phoneChanged = phone !== user.phone;
        if (phoneChanged && !waReady) return res.status(503).json({ error: 'Phone verification is unavailable. Phone was not changed.' });
        const verificationToken = emailChanged ? crypto.randomBytes(32).toString('hex') : null;
        const phoneOtp = phoneChanged ? String(crypto.randomInt(1000, 10000)) : null;
        const idCardUrl = req.file ? `/uploads/${req.file.filename}` : user.idCardUrl;
        const needsReverify = user.role === 'developer' && (schoolName !== user.schoolName || Boolean(req.file));
        const isVerified = needsReverify ? 0 : user.isVerified;
        await dbRun(
            `UPDATE users SET name=?, email=?, phone=?, schoolName=?, gradeOrYear=?, idCardUrl=?, isEmailVerified=?, verificationToken=?, isPhoneVerified=CASE WHEN ? THEN 0 ELSE isPhoneVerified END, phoneOtp=?, phoneOtpExpiry=?, isVerified=?, isReverify=?, isRejected=0 WHERE id=?`,
            [name.trim(), email.trim().toLowerCase(), phone, schoolName || null, gradeOrYear || null, idCardUrl, emailChanged ? 0 : 1, verificationToken, phoneChanged ? 1 : 0, phoneOtp, phoneChanged ? Date.now() + 10 * 60 * 1000 : null, isVerified, needsReverify ? 1 : 0, req.user.id]
        );
        if (phoneChanged) {
            try {
                await waClient.sendMessage(`91${phone}@c.us`, `Your TechnoDev phone verification code is: ${phoneOtp}`);
            } catch (error) {
                await dbRun('UPDATE users SET phoneOtp = NULL, phoneOtpExpiry = NULL WHERE id = ? AND phoneOtp = ?', [req.user.id, phoneOtp]);
                console.error('Phone verification delivery failed:', error);
                return res.status(503).json({ error: 'Phone was updated, but the verification code could not be sent. Log in and request a new code.' });
            }
        }
        if (emailChanged) {
            await sendEmail({
                to: email.trim().toLowerCase(),
                subject: 'Verify Your Updated Email',
                html: `<p>Verify your updated TechnoDev email address: <a href="${APP_BASE_URL}/api/verify-email/${verificationToken}">Verify email</a>.</p>`
            });
        }
        res.json({ success: true, emailChanged, phoneChanged, reverify: needsReverify });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') return res.status(400).json({ error: 'Email or phone number is already in use.' });
        next(error);
    }
});

app.post('/api/profile/password', authenticate, async (req, res, next) => {
    try {
        const user = await dbGet('SELECT password FROM users WHERE id = ?', [req.user.id]);
        if (!user || !(await bcrypt.compare(req.body.currentPassword || '', user.password))) {
            return res.status(400).json({ error: 'Incorrect current password.' });
        }
        if ((req.body.newPassword || '').length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters.' });
        }
        const hash = await bcrypt.hash(req.body.newPassword, 12);
        await dbRun('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id]);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/profile/upi', authenticate, async (req, res, next) => {
    try {
        if (!isValidUpi(req.body.upiId)) return res.status(400).json({ error: 'Enter a valid UPI ID.' });
        const user = await dbGet('SELECT name, parent_email, dob FROM users WHERE id = ?', [req.user.id]);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        const age = calculateAge(user.dob);
        await dbRun(
            'UPDATE users SET upiId = ?, parent_upi_id = CASE WHEN ? < 18 THEN ? ELSE parent_upi_id END WHERE id = ?',
            [req.body.upiId, age ?? 18, req.body.upiId, req.user.id]
        );
        if (age !== null && age < 18 && user.parent_email) {
            await sendEmail({
                to: user.parent_email,
                subject: 'Alert: Payout UPI ID Updated',
                html: `<p>The UPI ID for <b>${escapeHtml(user.name)}'s</b> account has been updated.</p><p>If you did not authorize this, contact support.</p>`
            });
        }
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/account', authenticate, async (req, res, next) => {
    try {
        await dbRun('DELETE FROM users WHERE id = ?', [req.user.id]);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get('/api/me', authenticate, async (req, res, next) => {
    try {
        const user = await dbGet(
            'SELECT id, name, email, phone, role, dob, schoolName, gradeOrYear, isVerified, isAdmin, upiId, parent_upi_id, isRejected, walletBalance FROM users WHERE id = ?',
            [req.user.id]
        );
        if (!user) return res.status(404).json({ error: 'User not found.' });
        const earnings = await dbGet(
            `SELECT COALESCE(SUM(budget - CAST(budget * 0.1 AS INTEGER)), 0) as totalEarned FROM jobs WHERE developerId = ? AND status = 'completed'`,
            [req.user.id]
        );
        user.age = calculateAge(user.dob);
        user.upiId = user.upiId || user.parent_upi_id;
        res.json({ ...user, escrowUpiId: process.env.ESCROW_UPI_ID || null, totalEarned: earnings?.totalEarned || 0 });
    } catch (error) {
        next(error);
    }
});

app.get('/api/profile/:id', authenticate, (req, res) => {
    db.get('SELECT id, name, schoolName, gradeOrYear, role FROM users WHERE id = ?', [req.params.id], (err, user) => {
        if(!user) return res.status(404).json({error: 'User not found'});
        db.all('SELECT title, reviewScore, reviewText FROM jobs WHERE developerId = ? AND status = "completed"', [req.params.id], (err, reviews) => {
            const avgRating = reviews.length > 0 ? (reviews.reduce((acc, r) => acc + r.reviewScore, 0) / reviews.length).toFixed(1) : 0;
            db.get('SELECT COUNT(*) as followers FROM follows WHERE followingId = ?', [req.params.id], (err, f1) => {
                db.get('SELECT COUNT(*) as following FROM follows WHERE followerId = ?', [req.params.id], (err, f2) => {
                    db.get('SELECT 1 FROM follows WHERE followerId = ? AND followingId = ?', [req.user.id, req.params.id], (err, isF) => {
                        res.json({ ...user, reviews, avgRating, followers: f1?.followers || 0, following: f2?.following || 0, isFollowing: !!isF });
                    });
                });
            });
        });
    });
});

app.post('/api/follow/:id', authenticate, (req, res) => {
    if (req.user.id == req.params.id) return res.json({success: false});
    db.get('SELECT 1 FROM follows WHERE followerId = ? AND followingId = ?', [req.user.id, req.params.id], (err, row) => {
        if (row) db.run('DELETE FROM follows WHERE followerId = ? AND followingId = ?', [req.user.id, req.params.id], () => res.json({ action: 'unfollowed' }));
        else db.run('INSERT INTO follows (followerId, followingId) VALUES (?, ?)', [req.user.id, req.params.id], () => res.json({ action: 'followed' }));
    });
});

// --- STATISTICS & COMMUNITY ---
app.get('/api/stats', authenticate, (req, res) => {
    if (req.user.role === 'developer') {
        db.get("SELECT COALESCE(SUM(budget - CAST(budget * 0.1 AS INTEGER)), 0) as earnings FROM jobs WHERE developerId = ? AND status = 'completed'", [req.user.id], (err, row1) => {
            db.get("SELECT COUNT(*) as ongoing FROM jobs WHERE developerId = ? AND status IN ('in_progress', 'in_review')", [req.user.id], (err, row2) => {
                db.get("SELECT COUNT(*) as proposals FROM bids WHERE developerId = ?", [req.user.id], (err, row3) => {
                    res.json({ earnings: row1?.earnings || 0, ongoing: row2?.ongoing || 0, proposals: row3?.proposals || 0 });
                });
            });
        });
    } else {
        db.get("SELECT COUNT(*) as posted FROM jobs WHERE buyerId = ?", [req.user.id], (err, row1) => {
            db.get("SELECT SUM(budget) as moneyGiven FROM jobs WHERE buyerId = ? AND status = 'completed'", [req.user.id], (err, row2) => {
                res.json({ posted: row1?.posted || 0, moneyGiven: row2?.moneyGiven || 0 });
            });
        });
    }
});
app.get('/api/my-proposals', authenticate, (req, res) => { db.all(`SELECT bids.*, jobs.title as jobTitle, jobs.status as jobStatus FROM bids JOIN jobs ON bids.jobId = jobs.id WHERE bids.developerId = ? ORDER BY bids.createdAt DESC`, [req.user.id], (err, rows) => res.json(rows || [])); });
app.get('/api/users-list', authenticate, (req, res) => { db.all("SELECT id, name, role, schoolName FROM users WHERE role != 'admin' AND isVerified = 1 AND id != ?", [req.user.id], (err, rows) => res.json(rows || [])); });

// --- CORE JOB LOGIC ---
app.post('/api/jobs', authenticate, async (req, res, next) => {
    try {
        const title = req.body.title?.trim();
        const description = req.body.description?.trim();
        const budget = Number(req.body.budget);
        if (req.user.role !== 'buyer') return res.status(403).json({ error: 'Only buyers can post projects.' });
        if (!title || title.length > 120 || !description || description.length > 5000 || !Number.isSafeInteger(budget) || budget <= 0) {
            return res.status(400).json({ error: 'Enter a title, description, and positive whole-number budget.' });
        }
        await dbRun('INSERT INTO jobs (buyerId, title, description, budget) VALUES (?, ?, ?, ?)', [req.user.id, title, description, budget]);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});
app.delete('/api/jobs/:id', authenticate, (req, res) => { db.run(`DELETE FROM jobs WHERE id = ? AND buyerId = ? AND status = 'open'`, [req.params.id, req.user.id], function(err) { if(this.changes === 0) return res.status(400).json({error: 'Cannot delete.'}); res.json({ success: true }); }); });

app.get('/api/my-jobs', authenticate, (req, res) => {
    if(req.user.role === 'buyer') db.all(`SELECT jobs.*, COUNT(bids.id) as bidCount FROM jobs LEFT JOIN bids ON jobs.id = bids.jobId WHERE jobs.buyerId = ? GROUP BY jobs.id ORDER BY jobs.createdAt DESC`, [req.user.id], (err, rows) => res.json(rows || []));
    else db.all(`SELECT jobs.*, users.name as buyerName FROM jobs JOIN users ON jobs.buyerId = users.id WHERE jobs.developerId = ? ORDER BY jobs.createdAt DESC`, [req.user.id], (err, rows) => res.json(rows || []));
});
app.get('/api/jobs', authenticate, (req, res) => { db.all(`SELECT jobs.*, users.name as buyerName, users.schoolName as buyerSchool FROM jobs JOIN users ON jobs.buyerId = users.id WHERE status = 'open' ORDER BY createdAt DESC`, (err, rows) => res.json(rows || [])); });

app.post('/api/bids', authenticate, async (req, res, next) => {
    try {
        if (req.user.role !== 'developer') return res.status(403).json({ error: 'Only developers can place bids.' });
        const amount = Number(req.body.amount);
        const message = req.body.message?.trim();
        if (!Number.isSafeInteger(amount) || amount <= 0 || !message || message.length > 2000) {
            return res.status(400).json({ error: 'Enter a positive whole-number bid and a message.' });
        }
        const developer = await dbGet(
            'SELECT isVerified, upiId, parent_upi_id FROM users WHERE id = ? AND role = ?',
            [req.user.id, 'developer']
        );
        if (!developer?.isVerified) return res.status(403).json({ error: 'Developer verification is required to bid.' });
        if (!developer.upiId && !developer.parent_upi_id) return res.status(400).json({ error: 'Add a payout UPI ID before bidding.' });
        const job = await dbGet('SELECT buyerId, budget, status FROM jobs WHERE id = ?', [req.body.jobId]);
        if (!job || job.status !== 'open' || job.buyerId === req.user.id) {
            return res.status(400).json({ error: 'This project is not accepting bids.' });
        }
        if (amount > job.budget) return res.status(400).json({ error: 'Bid cannot exceed the project budget.' });
        await dbRun('INSERT INTO bids (jobId, developerId, amount, message) VALUES (?, ?, ?, ?)', [req.body.jobId, req.user.id, amount, message]);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});
app.get('/api/jobs/:id/bids', authenticate, async (req, res, next) => {
    try {
        const job = await dbGet('SELECT buyerId FROM jobs WHERE id = ?', [req.params.id]);
        if (!job || job.buyerId !== req.user.id || req.user.role !== 'buyer') return res.status(403).json({ error: 'Only the project buyer can view bids.' });
        const rows = await dbAll(
            `SELECT bids.*, users.name as devName, users.schoolName as devSchool FROM bids JOIN users ON bids.developerId = users.id WHERE jobId = ? ORDER BY bids.createdAt ASC`,
            [req.params.id]
        );
        res.json(rows);
    } catch (error) {
        next(error);
    }
});

app.post('/api/bids/:id/accept', authenticate, async (req, res, next) => {
    try {
        if (req.user.role !== 'buyer') return res.status(403).json({ error: 'Only buyers can accept bids.' });
        const bid = await dbGet(
            `SELECT bids.jobId, bids.developerId, bids.amount, jobs.buyerId, jobs.status
             FROM bids JOIN jobs ON jobs.id = bids.jobId WHERE bids.id = ?`,
            [req.params.id]
        );
        if (!bid || bid.buyerId !== req.user.id || bid.status !== 'open') {
            return res.status(400).json({ error: 'This bid is no longer available.' });
        }
        const result = await dbRun(
            `UPDATE jobs SET status = 'awaiting_payment', developerId = ?, budget = ?
             WHERE id = ? AND buyerId = ? AND status = 'open'`,
            [bid.developerId, bid.amount, bid.jobId, req.user.id]
        );
        if (!result.changes) return res.status(409).json({ error: 'The project has already been awarded.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// Buyer funds specific project via UTR
app.post('/api/jobs/:id/fund-utr', authenticate, async (req, res, next) => {
    try {
        if (req.user.role !== 'buyer' || !/^[0-9]{12}$/.test(req.body.utr || '')) {
            return res.status(400).json({ error: 'Enter a valid 12-digit UTR.' });
        }
        const result = await dbRun(
            `UPDATE jobs SET fundedUtr = ? WHERE id = ? AND buyerId = ? AND status = 'awaiting_payment' AND fundedUtr IS NULL`,
            [req.body.utr, req.params.id, req.user.id]
        );
        if (!result.changes) return res.status(400).json({ error: 'This project is not awaiting a funding confirmation.' });
        res.json({ success: true, message: 'UTR submitted for admin verification.' });
    } catch (error) {
        next(error);
    }
});

// --- WORKSPACE & COMPLETION ---
app.get('/api/jobs/:id/workspace', authenticate, (req, res) => {
    db.get(`SELECT * FROM jobs WHERE id = ? AND (buyerId = ? OR developerId = ?)`, [req.params.id, req.user.id, req.user.id], (err, job) => {
        if (!job) return res.status(404).json({ error: 'Workspace not found or access denied.' });
        db.all(`SELECT messages.*, users.name as senderName FROM messages JOIN users ON messages.senderId = users.id WHERE jobId = ? ORDER BY messages.createdAt ASC`, [job.id], (err, messages) => res.json({ job, messages }));
    });
});
app.post('/api/jobs/:id/messages', authenticate, async (req, res, next) => {
    try {
        const text = req.body.text?.trim();
        if (!text || text.length > 2000) return res.status(400).json({ error: 'Message must contain 1–2,000 characters.' });
        const result = await dbRun(
            `INSERT INTO messages (jobId, senderId, text)
             SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND (buyerId = ? OR developerId = ?))`,
            [req.params.id, req.user.id, text, req.params.id, req.user.id, req.user.id]
        );
        if (!result.changes) return res.status(404).json({ error: 'Workspace not found or access denied.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});
app.post('/api/jobs/:id/submit', authenticate, async (req, res, next) => {
    try {
        let deliverable;
        try {
            deliverable = new URL(req.body.url);
        } catch {
            return res.status(400).json({ error: 'Enter a valid HTTPS delivery URL.' });
        }
        if (deliverable.protocol !== 'https:') return res.status(400).json({ error: 'Delivery URLs must use HTTPS.' });
        const result = await dbRun(
            `UPDATE jobs SET status = 'in_review', deliverableUrl = ? WHERE id = ? AND developerId = ? AND status = 'in_progress'`,
            [deliverable.href, req.params.id, req.user.id]
        );
        if (!result.changes) return res.status(400).json({ error: 'This project is not ready for delivery.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// Job Completed - Project-Based Accounting (No generic wallet additions)
app.post('/api/jobs/:id/complete', authenticate, async (req, res, next) => {
    try {
        const score = Number(req.body.score);
        const review = req.body.review?.trim();
        if (req.user.role !== 'buyer' || !Number.isInteger(score) || score < 1 || score > 5 || !review || review.length > 2000) {
            return res.status(400).json({ error: 'Select a 1–5 star rating and enter a review.' });
        }
        const result = await dbRun(
            `UPDATE jobs SET status = 'completed', reviewScore = ?, reviewText = ?
             WHERE id = ? AND buyerId = ? AND status = 'in_review' AND fundingVerified = 1`,
            [score, review, req.params.id, req.user.id]
        );
        if (!result.changes) return res.status(400).json({ error: 'Only a funded project under review can be completed.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// Developer specific project payout request
app.post('/api/jobs/:id/request-payout', authenticate, async (req, res, next) => {
    try {
        if (req.user.role !== 'developer') return res.status(403).json({ error: 'Only developers can request payouts.' });
        const result = await dbRun(
            `UPDATE jobs SET payoutRequested = 1 WHERE id = ? AND developerId = ? AND status = 'completed' AND fundingVerified = 1 AND payoutRequested = 0`,
            [req.params.id, req.user.id]
        );
        if (!result.changes) return res.status(400).json({ error: 'Payout is unavailable or has already been requested.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// --- ADMIN, REPORTS & FEEDBACKS ---
app.post('/api/feedbacks', authenticate, (req, res) => { db.run('INSERT INTO feedbacks (userId, type, message) VALUES (?, ?, ?)', [req.user.id, req.body.type, req.body.message], () => res.json({ success: true })); });
app.post('/api/report', authenticate, (req, res) => { db.run('INSERT INTO reports (reportedUserId, reporterId, reason) VALUES (?, ?, ?)', [req.body.reportedUserId, req.user.id, req.body.reason], () => res.json({ success: true })); });

app.get('/api/admin/pending', authenticate, requireAdmin, (req, res) => { 
    // Admin only verifies Adults now (minors are auto-verified via parent email)
    db.all("SELECT id, name, email, dob, schoolName, gradeOrYear, idCardUrl, isReverify FROM users WHERE role = 'developer' AND isVerified = 0 AND parent_email IS NULL", (err, rows) => res.json(rows || [])); 
});
app.post('/api/admin/verify/:id', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const result = await dbRun(
            `UPDATE users SET isVerified = 1, isReverify = 0, isRejected = 0
             WHERE id = ? AND role = 'developer' AND parent_email IS NULL AND dob <= date('now', '-18 years')`,
            [req.params.id]
        );
        if (!result.changes) return res.status(400).json({ error: 'This account is not eligible for admin verification.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});
app.post('/api/admin/reject/:id', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const result = await dbRun(
            `UPDATE users SET isRejected = 1, isVerified = 0, isReverify = 0
             WHERE id = ? AND role = 'developer' AND parent_email IS NULL`,
            [req.params.id]
        );
        if (!result.changes) return res.status(400).json({ error: 'This account cannot be rejected from the admin queue.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});
app.delete('/api/admin/users/:id', authenticate, requireAdmin, (req, res) => { db.run("DELETE FROM users WHERE id = ?", [req.params.id], () => res.json({ success: true })); });

app.get('/api/admin/reports', authenticate, requireAdmin, (req, res) => { db.all(`SELECT reports.*, reporter.name as reporterName, reported.name as reportedName, reported.email as reportedEmail FROM reports JOIN users as reporter ON reports.reporterId = reporter.id JOIN users as reported ON reports.reportedUserId = reported.id ORDER BY reports.createdAt DESC`, (err, rows) => res.json(rows || [])); });
app.get('/api/admin/feedbacks', authenticate, requireAdmin, (req, res) => { db.all(`SELECT feedbacks.*, users.name, users.email FROM feedbacks JOIN users ON feedbacks.userId = users.id ORDER BY feedbacks.createdAt DESC`, (err, rows) => res.json(rows || [])); });
app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => { db.all(`SELECT id, name, email, phone, role, isVerified, isEmailVerified, isPhoneVerified, upiId, parent_upi_id, isRejected FROM users WHERE role != 'admin' ORDER BY id DESC`, (err, rows) => {
    rows.forEach(r => r.upiId = r.upiId || r.parent_upi_id);
    res.json(rows || []);
});});

// Admin Banking & Project Escrow Trackers
app.get('/api/admin/banking', authenticate, requireAdmin, (req, res) => {
    Promise.all([
        dbGet(`SELECT COALESCE(SUM(budget), 0) as volume, COALESCE(SUM(CAST(budget * 0.1 AS INTEGER)), 0) as profit FROM jobs WHERE fundingVerified = 1 AND status = 'completed'`),
        dbAll(`SELECT jobs.id, jobs.title, jobs.budget, dev.name as devName, dev.upiId, dev.parent_upi_id
               FROM jobs JOIN users as dev ON jobs.developerId = dev.id
               WHERE jobs.payoutRequested = 1 AND jobs.status = 'completed' AND jobs.fundingVerified = 1`),
        dbAll(`SELECT jobs.id, jobs.title, jobs.budget, jobs.fundedUtr, jobs.fundingVerified, buyer.name as buyerName, dev.name as devName, jobs.status
               FROM jobs JOIN users as buyer ON jobs.buyerId = buyer.id
               LEFT JOIN users as dev ON jobs.developerId = dev.id
               WHERE jobs.fundedUtr IS NOT NULL AND jobs.payoutRequested != 2`)
    ]).then(([stats, pendingPayouts, escrowFunds]) => {
        pendingPayouts.forEach((job) => { job.upiId = job.upiId || job.parent_upi_id; });
        res.json({ volume: stats.volume, profit: stats.profit, pendingPayouts, escrowFunds });
    }).catch((error) => {
        console.error('Could not load admin banking data:', error);
        res.status(500).json({ error: 'Could not load banking data.' });
    });
});

app.post('/api/admin/verify-funding/:id', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const result = await dbRun(
            `UPDATE jobs SET fundingVerified = 1,
             status = CASE WHEN status = 'awaiting_payment' THEN 'in_progress' ELSE status END
             WHERE id = ? AND status IN ('awaiting_payment', 'in_progress', 'in_review', 'completed')
             AND fundedUtr IS NOT NULL AND fundingVerified = 0`,
            [req.params.id]
        );
        if (!result.changes) return res.status(400).json({ error: 'This project has no pending funding confirmation.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/admin/pay-job/:id', authenticate, requireAdmin, async (req, res, next) => {
    try {
        if (!/^[0-9]{12}$/.test(req.body.utr || '')) return res.status(400).json({ error: 'Enter a valid 12-digit payout UTR.' });
        const result = await dbRun(
            `UPDATE jobs SET paidOutUtr = ?, payoutRequested = 2
             WHERE id = ? AND status = 'completed' AND fundingVerified = 1 AND payoutRequested = 1`,
            [req.body.utr, req.params.id]
        );
        if (!result.changes) return res.status(400).json({ error: 'This payout is not pending or has already been paid.' });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'ID image must be 5 MB or smaller.' });
    if (err.message?.startsWith('Only JPEG')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'An unexpected server error occurred.' });
});

initializeDatabase()
    .then(() => app.listen(PORT, () => console.log(`Marketplace running on port ${PORT}`)))
    .catch((error) => {
        console.error('Database initialization failed:', error);
        process.exitCode = 1;
    });