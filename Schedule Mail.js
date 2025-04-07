const express = require('express');
const mongoose = require('mongoose');
const { Agenda } = require('agenda');
const postmark = require('postmark');
const path = require('path');
require('dotenv').config();

// Initialize Express app
const app = express();
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB with error handling
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/email-scheduler')
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Initialize Postmark client
const client = new postmark.ServerClient(process.env.POSTMARK_API_KEY);

// Initialize Agenda (job scheduler)
const agenda = new Agenda({
  db: { address: process.env.MONGODB_URI || 'mongodb://localhost/email-scheduler' }
});

// Email Schedule Schema
const EmailScheduleSchema = new mongoose.Schema({
  to: { type: String, required: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
  scheduledDate: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  lastAttempt: { type: Date },
  error: { type: String },
  attempts: { type: Number, default: 0 }
});

const EmailSchedule = mongoose.model('EmailSchedule', EmailScheduleSchema);

// Define Agenda job
agenda.define('send email', async (job) => {
  const { to, subject, text, _id } = job.attrs.data;
  
  try {
    const result = await client.sendEmail({
      From: process.env.FROM_EMAIL,
      To: to,
      Subject: subject,
      TextBody: text
    });
    
    console.log('Email sent successfully:', result);
    await EmailSchedule.findByIdAndUpdate(_id, { 
      status: 'sent',
      lastAttempt: new Date(),
      error: null
    });
  } catch (error) {
    console.error('Failed to send email:', error);
    await EmailSchedule.findByIdAndUpdate(_id, { 
      status: 'failed',
      lastAttempt: new Date(),
      error: error.message || 'Failed to send email'
    });
    throw error;
  }
});

// Start Agenda
(async function() {
  await agenda.start();
})();

// Helper function to handle schedule operations
const handleScheduleOperation = async (req, res, operation) => {
  try {
    const result = await operation();
    res.json(result);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Routes
app.post('/api/schedules', async (req, res) => {
  await handleScheduleOperation(req, res, async () => {
    const { to, subject, text, scheduledDate } = req.body;
    const emailSchedule = new EmailSchedule({ to, subject, text, scheduledDate });
    await emailSchedule.save();
    await agenda.schedule(scheduledDate, 'send email', { to, subject, text, _id: emailSchedule._id });
    return emailSchedule;
  });
});

app.get('/api/schedules', async (req, res) => {
  await handleScheduleOperation(req, res, async () => {
    return await EmailSchedule.find();
  });
});

app.get('/api/schedules/failed', async (req, res) => {
  await handleScheduleOperation(req, res, async () => {
    return await EmailSchedule.find({ status: 'failed' }).sort({ lastAttempt: -1 });
  });
});

app.get('/api/schedules/pending', async (req, res) => {
  await handleScheduleOperation(req, res, async () => {
    return await EmailSchedule.find({ status: 'pending' }).sort({ scheduledDate: 1 });
  });
});

app.delete('/api/schedules/:id', async (req, res) => {
  await handleScheduleOperation(req, res, async () => {
    const schedule = await EmailSchedule.findById(req.params.id);
    if (!schedule) throw new Error('Schedule not found');
    await agenda.cancel({ 'data._id': schedule._id });
    await EmailSchedule.findByIdAndDelete(req.params.id);
    return { message: 'Schedule deleted successfully' };
  });
});

app.post('/api/schedules/:id/reschedule', async (req, res) => {
  await handleScheduleOperation(req, res, async () => {
    const { scheduledDate } = req.body;
    const schedule = await EmailSchedule.findById(req.params.id);
    if (!schedule) throw new Error('Schedule not found');
    await agenda.cancel({ 'data._id': schedule._id });
    schedule.scheduledDate = scheduledDate;
    schedule.status = 'pending';
    schedule.error = null;
    schedule.attempts = 0;
    await schedule.save();
    await agenda.schedule(scheduledDate, 'send email', {
      to: schedule.to,
      subject: schedule.subject,
      text: schedule.text,
      _id: schedule._id
    });
    return schedule;
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
