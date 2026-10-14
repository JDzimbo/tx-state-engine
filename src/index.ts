import express from 'express';
import dotenv from 'dotenv';
import { query } from './db/client';
import { eventsRouter } from './routes/events';
import { transactionsRouter } from './routes/transactions';

dotenv.config();

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'tx-state-engine' });
});

app.get('/health/db', async (_req, res) => {
  try {
    const rows = await query<{ now: Date }>('SELECT NOW() as now');
    res.json({ status: 'ok', db_time: rows[0].now });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use(eventsRouter);
app.use(transactionsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});