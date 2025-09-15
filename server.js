const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const app = express();

// 🔐 Load .env config
dotenv.config();

// 🛡️ Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 📁 Excel storage folder
const EXPORTS_DIR = path.join(__dirname, "exports");
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR);
}
const SALES_EXCEL_PATH = path.join(EXPORTS_DIR, "sales.xlsx");

// ----------------------
// 🔗 MongoDB Connection
// ----------------------
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error", err));

// ----------------------
// 🧬 Mongoose Models
// ----------------------
const Product = mongoose.model("Product", new mongoose.Schema({
  name: String,
  sku: String,
  quantity: { type: Number, default: 0 },
  location: String,
  supplier: String,
  createdAt: { type: Date, default: Date.now },
}));

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
app.get("/api/products", async (req, res) => {
  const products = await Product.find();
  res.json(products);
});

app.post("/api/products", async (req, res) => {
  const { name, sku, quantity, location, supplier } = req.body;
  const newProduct = new Product({ name, sku, quantity, location, supplier });
  await newProduct.save();
  res.json(newProduct);
});

app.put("/api/products/:id", async (req, res) => {
  const { quantity } = req.body;
  const updated = await Product.findByIdAndUpdate(
    req.params.id,
    { $set: { quantity } },
    { new: true }
  );
  res.json(updated);
});

app.delete("/api/products/:id", async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ message: "Product deleted" });
});

// ----------------------
// 🛒 SALES ROUTES
// ----------------------
app.post("/api/sales", async (req, res) => {
  try {
    const { channel, items, date } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    // Validate and check stock
    for (let item of items) {
      if (!mongoose.Types.ObjectId.isValid(item.productId)) {
        return res.status(400).json({ error: `Invalid productId: ${item.productId}` });
      }
      const product = await Product.findById(item.productId);
      if (!product || product.quantity < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${product?.name || 'Unknown'}` });
      }
    }

    // Decrease stock
    for (let item of items) {
      await Product.findByIdAndUpdate(item.productId, {
        $inc: { quantity: -item.quantity },
      });
    }

    // Save to DB
    const sale = new Sale({
      channel,
      items,
      date: date ? new Date(date) : new Date(),
    });
    await sale.save();

    // Save to Excel
    const workbook = new ExcelJS.Workbook();
    if (fs.existsSync(SALES_EXCEL_PATH)) {
      await workbook.xlsx.readFile(SALES_EXCEL_PATH);
    }
    const sheet = workbook.getWorksheet("Sales") || workbook.addWorksheet("Sales");

    if (sheet.rowCount === 0) {
      sheet.addRow(["Date", "Channel", "Product", "SKU", "Quantity"]);
    }

    for (let item of items) {
      const product = await Product.findById(item.productId);
      sheet.addRow([
        new Date(sale.date).toLocaleDateString("en-GB"),
        channel,
        product?.name || "Unknown",
        product?.sku || "-",
        item.quantity,
      ]);
    }

    await workbook.xlsx.writeFile(SALES_EXCEL_PATH);
    res.json(sale);
  } catch (err) {
    console.error("🔥 Error recording sale:", err);
    res.status(500).json({ error: err.message });
  }
});

// 📤 Download Excel
app.get("/api/sales/download", (req, res) => {
  if (!fs.existsSync(SALES_EXCEL_PATH)) {
    return res.status(404).send("No sales records found");
  }
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Disposition", `attachment; filename="sales.xlsx"`);
  res.download(SALES_EXCEL_PATH, "sales.xlsx");
});

// 📊 Sales summary per day
app.get("/api/sales/summary/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const start = new Date(date);
    if (isNaN(start)) return res.status(400).json({ error: "Invalid date format" });

    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    const channelSummary = await Sale.aggregate([
      { $match: { date: { $gte: start, $lte: end } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$channel",
          totalQuantity: { $sum: "$items.quantity" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const overall = await Sale.aggregate([
      { $match: { date: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalQuantity: { $sum: { $sum: "$items.quantity" } },
        },
      },
    ]);

    res.json({
      date,
      channels: channelSummary,
      overall: overall[0] || { totalOrders: 0, totalQuantity: 0 },
    });
  } catch (err) {
    console.error("🔥 Sales summary error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 📁 Export all sales as Excel
app.get("/api/sales/export", async (req, res) => {
  try {
    const sales = await Sale.find().populate("items.productId", "name sku");

    if (!sales.length) {
      return res.status(404).json({ message: "No sales found" });
    }

    const data = [];
    sales.forEach((sale) => {
      sale.items.forEach((item) => {
        data.push({
          Channel: sale.channel,
          Date: new Date(sale.date).toLocaleDateString("en-GB"),
          Product: item.productId?.name || "Unknown",
          SKU: item.productId?.sku || "-",
          Quantity: item.quantity,
        });
      });
    });

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sales");

    const exportPath = path.join(EXPORTS_DIR, "sales_export.xlsx");
    XLSX.writeFile(workbook, exportPath);

    res.json({ message: "Excel generated", filePath: "/exports/sales_export.xlsx" });
  } catch (err) {
    console.error("❌ Excel export error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 🚀 START SERVER
// ----------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
