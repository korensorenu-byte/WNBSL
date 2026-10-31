import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import memberRoutes from './routes/members.js';
import savingsRoutes from './routes/savings.js';
import loanRoutes from './routes/loans.js';
import investmentRoutes from './routes/investments.js';
import adminRoutes from './routes/admin.js';
import invitationRoutes from './routes/invitations.js';
import onboardingRoutes from './routes/onboarding.js';
import marketplaceRoutes from './routes/marketplace.js';
import portalRoutes from './routes/portal.js';
import loanProductRoutes from './routes/loanProducts.js';
import studentRoutes from './routes/students.js';
import investmentProductRoutes from './routes/investmentProducts.js';
import integrationRoutes from './routes/integrations.js';
import { startScheduler } from './lib/jobs.js';
import { errorHandler } from './middleware/auth.js';

const app = express();
const port = Number(process.env.PORT) || 4000;

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || 'http://localhost:5173' }));

// Basic hardening headers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
// Invitations and onboarding are mounted before the admin router, which applies auth to everything it serves.
app.use('/api/invitations', invitationRoutes);
app.use('/api', onboardingRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/loan-products', loanProductRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/investment-products', investmentProductRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/savings', savingsRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/investments', investmentRoutes);
app.use('/api', adminRoutes);

// In production the API also serves the built web app (web/dist), so one service runs everything.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(here, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist, { index: 'index.html', maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

app.listen(port, () => {
  console.log(`WNBSLS API listening on port ${port}`);
  startScheduler();
});
