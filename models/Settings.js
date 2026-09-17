// models/Settings.js
// Singleton document holding the shop's live pricing and UPI details.
// There is only ever one Settings document; server.js upserts it.

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    // A fixed key lets us always find "the one" settings doc with findOne({ key: 'shop' })
    key: { type: String, default: 'shop', unique: true },

    shopName: { type: String, default: 'Quick Print Xerox' },

    bw_price_per_page: { type: Number, default: 2 }, // ₹ per page, black & white
    color_price_per_page: { type: Number, default: 10 }, // ₹ per page, color

    owner_upi_id: { type: String, default: 'shopowner@upi' },
    owner_display_name: { type: String, default: 'Quick Print Xerox' },

    // Simple on/off switch so the owner can pause new orders (e.g. shop closed)
    acceptingOrders: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
