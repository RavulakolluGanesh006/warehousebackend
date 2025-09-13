const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Connect MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log("MongoDB Connected ✅"))
  .catch((err) => console.error("MongoDB Error ❌", err));

// ✅ Product Schema
const Product = mongoose.model("Product", new mongoose.Schema({
  name: String,
  sku: String,
  quantity: { type: Number, default: 0 },
  location: String,
  supplier: String,
  createdAt: { type: Date, default: Date.now },
}));

// ✅ Sale Schema & Model

const saleSchema = new mongoose.Schema({
  channel: String,
  items: [
    {
      productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
      quantity: Number,
    },
  ],
  date: { type: Date, default: Date.now },
});

const Sale = mongoose.model("Sale", saleSchema);



// ----------------------
// 📦 PRODUCT ROUTES
// ----------------------

// Get all products
app.get("/api/products", async (req, res) => {
  const products = await Product.find();
  res.json(products);
});

// Add new product
app.post("/api/products", async (req, res) => {
  const { name, sku, quantity, location, supplier } = req.body;
  const newProduct = new Product({ name, sku, quantity, location, supplier });
  await newProduct.save();
  res.json(newProduct);
});

// Update quantity
app.put("/api/products/:id", async (req, res) => {
  const { quantity } = req.body;
  const updated = await Product.findByIdAndUpdate(
    req.params.id,
    { $set: { quantity } },
    { new: true }
  );
  res.json(updated);
});

// Delete product
app.delete("/api/products/:id", async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ message: "Product deleted" });
});

// ----------------------
// 🛒 SALES ROUTES
// ----------------------

// Record a sale (Amazon/Flipkart)
app.post("/api/sales", async (req, res) => {
  try {
    const { channel, items, date } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    // Reduce stock for each product
    for (let item of items) {
      await Product.findByIdAndUpdate(item.productId, {
        $inc: { quantity: -item.quantity },
      });
    }

    // Save sale with given date OR default to now
    const sale = new Sale({
      channel,
      items,
      date: date ? new Date(date) : new Date(),
    });

    await sale.save();
    res.json(sale);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get sales by channel with optional date filter
// Get sales by channel with optional date filter
app.get("/api/sales/:channel", async (req, res) => {
  try {
    const { channel } = req.params;
    const { start, end } = req.query;

    const query = { channel };

    if (start && end) {
      query.date = {
        $gte: new Date(start),
        $lte: new Date(end),
      };
    }

    const sales = await Sale.find(query)
      .populate("items.productId", "name sku")
      .sort({ date: -1 });

    res.json(sales);
  } catch (err) {
    console.error("Error fetching sales:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});


// const mongoose = require("mongoose");

app.post("/api/sales", async (req, res) => {
  try {
    const { channel, items, date } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    // ✅ Validate productIds
    for (let item of items) {
      if (!mongoose.Types.ObjectId.isValid(item.productId)) {
        return res.status(400).json({ error: `Invalid productId: ${item.productId}` });
      }
    }

    // Reduce stock
    for (let item of items) {
      await Product.findByIdAndUpdate(item.productId, {
        $inc: { quantity: -item.quantity },
      });
    }

    // Save sale
    const sale = new Sale({
      channel,
      items,
      date: date ? new Date(date) : new Date(),
    });

    await sale.save();
    res.json(sale);
  } catch (err) {
    console.error("🔥 Error recording sale:", err);
    res.status(500).json({ error: err.message });
  }
});



app.get("/api/sales/summary/:date", async (req, res) => {
  try {
    const { date } = req.params;

    const start = new Date(date);
    if (isNaN(start)) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    // Per channel summary
    const channelSummary = await Sale.aggregate([
      { $match: { date: { $gte: start, $lte: end } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$channel",
          totalQuantity: { $sum: "$items.quantity" },
          totalOrders: { $sum: 1 }  // one per sale doc
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Overall totals
    

  const overall = await Sale.aggregate([
  { $match: { date: { $gte: start, $lte: end } } },
  {
    $group: {
      _id: null,
      totalOrders: { $sum: 1 },
      totalQuantity: { $sum: { $sum: "$items.quantity" } }
    }
  }
]);

res.json({
  date,
  channels: channelSummary,
  overall: overall[0] || { totalOrders: 0, totalQuantity: 0 }
});
  } catch (err) {
    console.error("🔥 Sales summary error:", err);
    res.status(500).json({ error: err.message });
  }
});








// ----------------------
// 🚀 START SERVER
// ----------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
