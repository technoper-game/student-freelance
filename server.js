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
const JWT_SECRET = 'super-secret-key-change-in-production';

// === YOUR LIVE CREDENTIALS ===
const GMAIL_EMAIL = 'technophonk42211@gmail.com'; 
const GMAIL_APP_PASSWORD = 'icll ecpd ekuk wxfv'; 
// =============================

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_EMAIL, pass: GMAIL_APP_PASSWORD } });

// --- WHATSAPP BOT SETUP ---
const waClient = new Client({ 
    authStrategy: new LocalAuth(),
    puppeteer: { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
});
waClient.on('qr', (qr) => {
    console.log('\n==================================================');
    console.log('SCAN THIS QR WITH YOUR WHATSAPP TO ENABLE FREE OTPS');
    console.log('==================================================\n');
    qrcode.generate(qr, { small: true });
});
waClient.on('ready', () => console.log('WhatsApp Bot is successfully connected and ready to send OTPs!'));
waClient.initialize();

app.use(cors()); 
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, uploadDir), filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)) }) });

const db = new sqlite3.Database('./marketplace.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, phone TEXT UNIQUE, password TEXT, role TEXT, dob DATE, schoolName TEXT, gradeOrYear TEXT, idCardUrl TEXT, upiId TEXT, walletBalance INTEGER DEFAULT 0, isEmailVerified BOOLEAN DEFAULT 0, verificationToken TEXT, phoneOtp TEXT, isPhoneVerified BOOLEAN DEFAULT 0, resetToken TEXT, resetTokenExpiry DATETIME, isVerified BOOLEAN DEFAULT 0, isReverify BOOLEAN DEFAULT 0, isRejected BOOLEAN DEFAULT 0, isAdmin BOOLEAN DEFAULT 0,
        parent_name TEXT, parent_email TEXT, parent_phone TEXT, parent_upi_id TEXT, parent_id_image_path TEXT, parent_verification_status TEXT DEFAULT 'PENDING', is_parent_verified BOOLEAN DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, buyerId INTEGER, developerId INTEGER, title TEXT, description TEXT, budget INTEGER, status TEXT DEFAULT 'open', deliverableUrl TEXT, reviewScore INTEGER, reviewText TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
    // Add new UTR tracking columns to existing jobs table safely
    db.run("ALTER TABLE jobs ADD COLUMN fundedUtr TEXT", (err) => {});
    db.run("ALTER TABLE jobs ADD COLUMN paidOutUtr TEXT", (err) => {});
    db.run("ALTER TABLE jobs ADD COLUMN payoutRequested INTEGER DEFAULT 0", (err) => {});

    db.run(`CREATE TABLE IF NOT EXISTS bids (id INTEGER PRIMARY KEY AUTOINCREMENT, jobId INTEGER, developerId INTEGER, amount INTEGER, message TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reportedUserId INTEGER, reporterId INTEGER, reason TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, jobId INTEGER, senderId INTEGER, text TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS feedbacks (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, type TEXT, message TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS follows (followerId INTEGER, followingId INTEGER, PRIMARY KEY(followerId, followingId))`);

    bcrypt.hash('Dharshan@2012', 10, (err, hash) => {
        db.run(`INSERT OR IGNORE INTO users (email, phone, password, name, role, isAdmin, isVerified, isEmailVerified, isPhoneVerified) VALUES ('admin@system.com', '0000000000', ?, 'System Admin', 'admin', 1, 1, 1, 1)`, [hash]);
    });
});

const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => { if (err) return res.sendStatus(403); req.user = user; next(); });
};
const requireAdmin = (req, res, next) => req.user.isAdmin ? next() : res.status(403).json({ error: 'Admin required' });

function calculateAge(dobString) { 
    const today = new Date(); const birthDate = new Date(dobString); 
    let age = today.getFullYear() - birthDate.getFullYear(); 
    const m = today.getMonth() - birthDate.getMonth(); 
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--; 
    return age; 
}

// --- AUTH & REGISTRATION ROUTE ---
app.post('/api/register', upload.single('idCard'), async (req, res) => {
    const { name, email, phone, password, role, dob, schoolName, gradeOrYear, parent_name, parent_email, parent_phone, parent_upi_id } = req.body;
    
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing core required fields' });

    const hash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const phoneOtp = Math.floor(1000 + Math.random() * 9000).toString(); 
    
    let idCardUrl = null; 
    let isVerified = role === 'buyer' ? 1 : 0; 
    let finalSchool = schoolName; 
    const age = calculateAge(dob);
    
    if (role === 'buyer' && age > 16) finalSchool = 'N/A';
    
    if (role === 'developer') {
        if (!req.file) return res.status(400).json({ error: 'ID Card is required for developers.' });
        idCardUrl = `/uploads/${req.file.filename}`;
    }

    db.run(`INSERT INTO users (name, email, phone, password, role, dob, schoolName, gradeOrYear, idCardUrl, isVerified, verificationToken, phoneOtp, parent_name, parent_email, parent_phone, parent_upi_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
        [name, email, phone, hash, role, dob, finalSchool, gradeOrYear, idCardUrl, isVerified, verificationToken, phoneOtp, parent_name, parent_email, parent_phone, parent_upi_id], async function(err) {
            if (err) return res.status(400).json({ error: 'Email or Phone already exists' });
            
            const host = req.get('host');
            
            // If minor developer, trigger parent approval email instead of admin approval
            if (role === 'developer' && age <= 18 && parent_email) {
                const approveLink = `http://${host}/api/parent-approve/${this.lastID}`;
                await transporter.sendMail({
                    from: GMAIL_EMAIL, to: parent_email, subject: "Approve Your Child's Freelance Account",
                    html: `<p><b>${name}</b> has registered to do freelance coding on TechnoDev.</p><p>Please click <a href="${approveLink}">here</a> to approve their account. Payouts will be sent to your UPI ID: <b>${parent_upi_id}</b>.</p>`
                }).catch(console.error);
            }

            const verifyLink = `http://${host}/api/verify-email/${verificationToken}`;
            await transporter.sendMail({
                from: GMAIL_EMAIL, to: email, subject: 'Verify Your Account',
                html: `<h3>Welcome!</h3><p>Click <a href="${verifyLink}">here</a> to verify your email address.</p>`
            }).catch(console.error);

            const waNumber = `91${phone}@c.us`; 
            const otpMessage = `Welcome! 🚀\n\nYour phone verification OTP is: *${phoneOtp}*\n\nPlease enter this on the website to login.`;
            waClient.sendMessage(waNumber, otpMessage).catch(e => console.error('WhatsApp Error:', e));

            res.json({ success: true, message: 'Account created. Check your WhatsApp for OTP and email for verification.' });
    });
});

app.get('/api/parent-approve/:id', (req, res) => {
    db.run(`UPDATE users SET parent_verification_status = 'APPROVED', is_parent_verified = 1, isVerified = 1 WHERE id = ?`, [req.params.id], function(err) {
        if (this.changes === 0) return res.status(400).send('Invalid or already approved.');
        res.send('<h1>Account Approved!</h1><p>The developer account is now active. All project payouts will be routed to your provided UPI ID.</p>');
    });
});

app.get('/api/verify-email/:token', (req, res) => {
    db.run(`UPDATE users SET isEmailVerified = 1, verificationToken = NULL WHERE verificationToken = ?`, [req.params.token], function(err) {
        if (this.changes === 0) return res.status(400).send('Invalid token.'); res.send('<h1>Email Verified!</h1><p>You can close this tab and log in.</p>');
    });
});
app.post('/api/verify-phone', (req, res) => {
    db.run(`UPDATE users SET isPhoneVerified = 1, phoneOtp = NULL WHERE email = ? AND phoneOtp = ?`, [req.body.email, req.body.otp], function(err) {
        if (this.changes === 0) return res.status(400).json({ error: 'Invalid OTP' }); res.json({ success: true });
    });
});
app.post('/api/login', (req, res) => {
    db.get('SELECT * FROM users WHERE email = ?', [req.body.email], async (err, user) => {
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });
        if (!user.isPhoneVerified) return res.status(403).json({ error: 'needs_otp' });
        res.json({ token: jwt.sign({ id: user.id, role: user.role, isAdmin: user.isAdmin, isVerified: user.isVerified }, JWT_SECRET) });
    });
});

app.post('/api/forgot-password', (req, res) => {
    const resetToken = crypto.randomBytes(32).toString('hex');
    db.run(`UPDATE users SET resetToken = ?, resetTokenExpiry = ? WHERE email = ?`, [resetToken, Date.now() + 3600000, req.body.email], function(err) {
        if (this.changes > 0) console.log(`\n=== PASSWORD RESET TOKEN ===\n${resetToken}\n===========================\n`);
        res.json({ success: true });
    });
});
app.post('/api/reset-password', async (req, res) => {
    const hash = await bcrypt.hash(req.body.newPassword, 10);
    db.run(`UPDATE users SET password = ?, resetToken = NULL, resetTokenExpiry = NULL WHERE resetToken = ? AND resetTokenExpiry > ?`, [hash, req.body.token, Date.now()], function(err) {
        if (this.changes === 0) return res.status(400).json({ error: 'Invalid or expired token.' }); res.json({ success: true });
    });
});

// Profile Editing & Data
app.post('/api/profile/edit', authenticate, upload.single('idCard'), (req, res) => {
    const { name, email, phone, dob, schoolName, gradeOrYear } = req.body;
    db.get('SELECT email, phone, idCardUrl, schoolName FROM users WHERE id = ?', [req.user.id], (err, user) => {
        let newEmailVerified = req.body.email === user.email ? 1 : 0;
        let vToken = newEmailVerified ? null : crypto.randomBytes(32).toString('hex');
        let newIdCardUrl = req.file ? `/uploads/${req.file.filename}` : user.idCardUrl;
        let needsReverify = 0; let isVerified = req.user.isVerified;
        
        if (req.user.role === 'developer' && (schoolName !== user.schoolName || req.file)) { needsReverify = 1; isVerified = 0; }
        
        db.run(`UPDATE users SET name=?, email=?, phone=?, dob=?, schoolName=?, gradeOrYear=?, idCardUrl=?, isEmailVerified=?, verificationToken=?, isVerified=?, isReverify=?, isRejected=0 WHERE id=?`,
            [name, email, phone, dob, schoolName, gradeOrYear, newIdCardUrl, newEmailVerified, vToken, isVerified, needsReverify, req.user.id], async function(err) {
                if(err) return res.status(400).json({error: 'Email or Phone taken'});
                res.json({ success: true, emailChanged: !newEmailVerified, reverify: needsReverify });
        });
    });
});

app.post('/api/profile/password', authenticate, (req, res) => {
    db.get('SELECT password FROM users WHERE id = ?', [req.user.id], async (err, user) => {
        if (!await bcrypt.compare(req.body.currentPassword, user.password)) return res.status(400).json({error: 'Incorrect current password'});
        const hash = await bcrypt.hash(req.body.newPassword, 10); db.run('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id], () => res.json({success: true}));
    });
});

app.post('/api/profile/upi', authenticate, (req, res) => { 
    db.get('SELECT name, parent_email FROM users WHERE id = ?', [req.user.id], (err, user) => {
        db.run(`UPDATE users SET upiId = ?, parent_upi_id = ? WHERE id = ?`, [req.body.upiId, req.body.upiId, req.user.id], async () => { 
            if (user && user.parent_email) {
                await transporter.sendMail({
                    from: GMAIL_EMAIL, to: user.parent_email, subject: 'Alert: Payout UPI ID Updated',
                    html: `<p>The UPI ID for <b>${user.name}'s</b> account has been updated to: <b>${req.body.upiId}</b></p><p>If you did not authorize this, please log in and change it immediately.</p>`
                }).catch(console.error);
            }
            res.json({ success: true }); 
        });
    });
});

app.delete('/api/account', authenticate, (req, res) => { db.run("DELETE FROM users WHERE id = ?", [req.user.id], () => res.json({ success: true })); });

app.get('/api/me', authenticate, (req, res) => {
    db.get('SELECT id, name, email, phone, role, dob, schoolName, gradeOrYear, isVerified, isAdmin, upiId, parent_upi_id, isRejected FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (!user) return res.status(404).json({ error: 'User not found.' }); 
        db.get('SELECT SUM(budget) as totalEarned FROM jobs WHERE developerId = ? AND status = ?', [req.user.id, 'completed'], (err, earnings) => {
            let userAge = 0; try { if (user.dob) userAge = calculateAge(user.dob); } catch(e) {}
            user.upiId = user.upiId || user.parent_upi_id; 
            res.json({ ...user, age: userAge, totalEarned: earnings?.totalEarned || 0 });
        });
    });
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
        db.get("SELECT SUM(budget) as earnings FROM jobs WHERE developerId = ? AND status = 'completed'", [req.user.id], (err, row1) => {
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
app.post('/api/jobs', authenticate, (req, res) => { db.run('INSERT INTO jobs (buyerId, title, description, budget) VALUES (?, ?, ?, ?)', [req.user.id, req.body.title, req.body.description, req.body.budget], () => res.json({ success: true })); });
app.delete('/api/jobs/:id', authenticate, (req, res) => { db.run(`DELETE FROM jobs WHERE id = ? AND buyerId = ? AND status = 'open'`, [req.params.id, req.user.id], function(err) { if(this.changes === 0) return res.status(400).json({error: 'Cannot delete.'}); res.json({ success: true }); }); });

app.get('/api/my-jobs', authenticate, (req, res) => {
    if(req.user.role === 'buyer') db.all(`SELECT jobs.*, COUNT(bids.id) as bidCount FROM jobs LEFT JOIN bids ON jobs.id = bids.jobId WHERE jobs.buyerId = ? GROUP BY jobs.id ORDER BY jobs.createdAt DESC`, [req.user.id], (err, rows) => res.json(rows || []));
    else db.all(`SELECT jobs.*, users.name as buyerName FROM jobs JOIN users ON jobs.buyerId = users.id WHERE jobs.developerId = ? ORDER BY jobs.createdAt DESC`, [req.user.id], (err, rows) => res.json(rows || []));
});
app.get('/api/jobs', authenticate, (req, res) => { db.all(`SELECT jobs.*, users.name as buyerName, users.schoolName as buyerSchool FROM jobs JOIN users ON jobs.buyerId = users.id WHERE status = 'open' ORDER BY createdAt DESC`, (err, rows) => res.json(rows || [])); });

app.post('/api/bids', authenticate, (req, res) => { db.run('INSERT INTO bids (jobId, developerId, amount, message) VALUES (?, ?, ?, ?)', [req.body.jobId, req.user.id, req.body.amount, req.body.message], () => res.json({ success: true })); });
app.get('/api/jobs/:id/bids', authenticate, (req, res) => { db.all(`SELECT bids.*, users.name as devName, users.schoolName as devSchool FROM bids JOIN users ON bids.developerId = users.id WHERE jobId = ? ORDER BY bids.createdAt ASC`, [req.params.id], (err, rows) => res.json(rows || [])); });

app.post('/api/bids/:id/accept', authenticate, (req, res) => {
    db.get(`SELECT jobId, developerId FROM bids WHERE id = ?`, [req.params.id], (err, bid) => {
        db.run(`UPDATE jobs SET status = 'awaiting_payment', developerId = ? WHERE id = ? AND buyerId = ?`, [bid.developerId, bid.jobId, req.user.id], () => res.json({ success: true }));
    });
});

// Buyer funds specific project via UTR
app.post('/api/jobs/:id/fund-utr', authenticate, (req, res) => { 
    db.run(`UPDATE jobs SET status = 'in_progress', fundedUtr = ? WHERE id = ? AND buyerId = ?`, [req.body.utr, req.params.id, req.user.id], () => res.json({ success: true })); 
});

// --- WORKSPACE & COMPLETION ---
app.get('/api/jobs/:id/workspace', authenticate, (req, res) => {
    db.get(`SELECT * FROM jobs WHERE id = ? AND (buyerId = ? OR developerId = ?)`, [req.params.id, req.user.id, req.user.id], (err, job) => {
        if (!job) return res.status(404).json({ error: 'Workspace not found or access denied.' });
        db.all(`SELECT messages.*, users.name as senderName FROM messages JOIN users ON messages.senderId = users.id WHERE jobId = ? ORDER BY messages.createdAt ASC`, [job.id], (err, messages) => res.json({ job, messages }));
    });
});
app.post('/api/jobs/:id/messages', authenticate, (req, res) => { db.run(`INSERT INTO messages (jobId, senderId, text) VALUES (?, ?, ?)`, [req.params.id, req.user.id, req.body.text], () => res.json({ success: true })); });
app.post('/api/jobs/:id/submit', authenticate, (req, res) => { db.run(`UPDATE jobs SET status = 'in_review', deliverableUrl = ? WHERE id = ? AND developerId = ?`, [req.body.url, req.params.id, req.user.id], () => res.json({ success: true })); });

// Job Completed - Project-Based Accounting (No generic wallet additions)
app.post('/api/jobs/:id/complete', authenticate, (req, res) => {
    db.get(`SELECT status FROM jobs WHERE id = ?`, [req.params.id], (err, job) => {
        if (!job || job.status === 'completed') return res.status(400).json({ error: 'Job already completed.' });
        db.run(`UPDATE jobs SET status = 'completed', reviewScore = ?, reviewText = ?, title = '[Completed & Archived]' WHERE id = ? AND buyerId = ?`, 
        [req.body.score, req.body.review, req.params.id, req.user.id], () => res.json({ success: true }));
    });
});

// Developer specific project payout request
app.post('/api/jobs/:id/request-payout', authenticate, (req, res) => {
    db.run(`UPDATE jobs SET payoutRequested = 1 WHERE id = ? AND developerId = ? AND status = 'completed'`, [req.params.id, req.user.id], () => res.json({ success: true }));
});

// --- ADMIN, REPORTS & FEEDBACKS ---
app.post('/api/feedbacks', authenticate, (req, res) => { db.run('INSERT INTO feedbacks (userId, type, message) VALUES (?, ?, ?)', [req.user.id, req.body.type, req.body.message], () => res.json({ success: true })); });
app.post('/api/report', authenticate, (req, res) => { db.run('INSERT INTO reports (reportedUserId, reporterId, reason) VALUES (?, ?, ?)', [req.body.reportedUserId, req.user.id, req.body.reason], () => res.json({ success: true })); });

app.get('/api/admin/pending', authenticate, requireAdmin, (req, res) => { 
    // Admin only verifies Adults now (minors are auto-verified via parent email)
    db.all("SELECT id, name, email, dob, schoolName, gradeOrYear, idCardUrl, isReverify FROM users WHERE role = 'developer' AND isVerified = 0 AND parent_email IS NULL", (err, rows) => res.json(rows || [])); 
});
app.post('/api/admin/verify/:id', authenticate, requireAdmin, (req, res) => { db.run("UPDATE users SET isVerified = 1, isReverify = 0 WHERE id = ?", [req.params.id], () => res.json({ success: true })); });
app.post('/api/admin/reject/:id', authenticate, requireAdmin, (req, res) => { db.run("UPDATE users SET isRejected = 1, isVerified = 0, isReverify = 0 WHERE id = ?", [req.params.id], () => res.json({ success: true })); });
app.delete('/api/admin/users/:id', authenticate, requireAdmin, (req, res) => { db.run("DELETE FROM users WHERE id = ?", [req.params.id], () => res.json({ success: true })); });

app.get('/api/admin/reports', authenticate, requireAdmin, (req, res) => { db.all(`SELECT reports.*, reporter.name as reporterName, reported.name as reportedName, reported.email as reportedEmail FROM reports JOIN users as reporter ON reports.reporterId = reporter.id JOIN users as reported ON reports.reportedUserId = reported.id ORDER BY reports.createdAt DESC`, (err, rows) => res.json(rows || [])); });
app.get('/api/admin/feedbacks', authenticate, requireAdmin, (req, res) => { db.all(`SELECT feedbacks.*, users.name, users.email FROM feedbacks JOIN users ON feedbacks.userId = users.id ORDER BY feedbacks.createdAt DESC`, (err, rows) => res.json(rows || [])); });
app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => { db.all(`SELECT id, name, email, phone, role, isVerified, isEmailVerified, isPhoneVerified, upiId, parent_upi_id, isRejected FROM users WHERE role != 'admin' ORDER BY id DESC`, (err, rows) => {
    rows.forEach(r => r.upiId = r.upiId || r.parent_upi_id);
    res.json(rows || []);
});});

// Admin Banking & Project Escrow Trackers
app.get('/api/admin/banking', authenticate, requireAdmin, (req, res) => {
    db.get(`SELECT SUM(budget) as totalVolume FROM jobs WHERE status = 'completed'`, (err, stats) => {
        const volume = stats?.totalVolume || 0; const profit = Math.floor(volume * 0.1); 
        
        // Fetch jobs where Dev requested payout
        db.all(`SELECT jobs.id, jobs.title, jobs.budget, dev.name as devName, dev.upiId, dev.parent_upi_id FROM jobs JOIN users as dev ON jobs.developerId = dev.id WHERE jobs.payoutRequested = 1 AND jobs.status = 'completed'`, (err, pendingPayouts) => {
            if(pendingPayouts) pendingPayouts.forEach(d => d.upiId = d.upiId || d.parent_upi_id); 
            
            // Fetch jobs funded by UTR but not yet paid out
            db.all(`SELECT jobs.id, jobs.title, jobs.budget, jobs.fundedUtr, buyer.name as buyerName, dev.name as devName, jobs.status FROM jobs JOIN users as buyer ON jobs.buyerId = buyer.id LEFT JOIN users as dev ON jobs.developerId = dev.id WHERE jobs.fundedUtr IS NOT NULL AND jobs.status != 'completed'`, (err, escrowFunds) => {
                res.json({ volume, profit, pendingPayouts: pendingPayouts || [], escrowFunds: escrowFunds || [] });
            });
        });
    });
});

// Admin confirms payout with UTR
app.post('/api/admin/pay-job/:id', authenticate, requireAdmin, (req, res) => { 
    db.run(`UPDATE jobs SET paidOutUtr = ?, payoutRequested = 2 WHERE id = ?`, [req.body.utr, req.params.id], () => res.json({ success: true })); 
});

app.listen(PORT, () => console.log(`Marketplace running on port ${PORT}`));