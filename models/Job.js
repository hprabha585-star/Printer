// models/Job.js
// Represents one customer print job, from upload through payment to physical printing.

const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema(
  {
    // Human-friendly short ID shown to the customer on the receipt (e.g. "PX-4821")
    tokenId: {
      type: String,
      required: true,
      unique: true,
    },

    // Original uploaded file details
    fileUrl: { type: String, required: true }, // path/URL the print agent downloads from
    fileName: { type: String, required: true }, // original file name (for the printer + owner view)
    fileType: { type: String }, // mime type, helps the agent decide how to print

    // What the customer asked for
    printType: { type: String, enum: ['bw', 'color'], required: true },
    copies: { type: Number, default: 1, min: 1 },
    pageRange: { type: String, default: 'all' }, // e.g. "all" or "1-3,5,7-9"
    totalPages: { type: Number, required: true, min: 1 },

    // Money
    pricePerPage: { type: Number, required: true },
    totalAmount: { type: Number, required: true },

    // Payment (UPI, verified manually by owner via UTR reference number)
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed'],
      default: 'pending',
    },
    utr: { type: String, default: null }, // UPI transaction reference the customer enters
    customerNote: { type: String, default: '' },

    // Physical print lifecycle, driven by the Python print_agent.py on the shop PC
    printStatus: {
      type: String,
      enum: ['awaiting_payment', 'queued', 'printing', 'completed', 'failed'],
      default: 'awaiting_payment',
    },
    printError: { type: String, default: null },
    printedAt: { type: Date, default: null },
  },
  { timestamps: true } // adds createdAt / updatedAt automatically
);

module.exports = mongoose.model('Job', jobSchema);
