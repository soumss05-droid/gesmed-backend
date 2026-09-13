require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const stocksRoutes = require("./routes/stocks.routes");
const requisitionsRoutes = require("./routes/requisitions.routes");
const distributionRoutes = require("./routes/distribution.routes");
const ecartsRoutes = require("./routes/ecarts.routes");
const rapportsRoutes = require("./routes/rapports.routes");
const produitsRoutes = require("./routes/produits.routes");
const adminRoutes = require("./routes/admin.routes");
const receptionsRoutes = require("./routes/receptions.routes");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ statut: "ok" }));

app.use("/auth", authRoutes);
app.use("/stocks", stocksRoutes);
app.use("/requisitions", requisitionsRoutes);
app.use("/distribution", distributionRoutes);
app.use("/ecarts", ecartsRoutes);
app.use("/rapports", rapportsRoutes);
app.use("/produits", produitsRoutes);
app.use("/admin", adminRoutes);
app.use("/receptions", receptionsRoutes);

// Gestion simple des erreurs non prévues.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erreur: "Une erreur inattendue est survenue." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API GesMed démarrée sur le port ${PORT}`);
});