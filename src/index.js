require("dotenv").config();
const express = require("express");
const cors = require("cors");
require("express-async-errors"); // Fait en sorte qu'une erreur dans une fonction async d'une route (ex. Prisma qui échoue) passe automatiquement par le middleware d'erreurs ci-dessous, au lieu de faire planter tout le serveur.

const authRoutes = require("./routes/auth.routes");
const stocksRoutes = require("./routes/stocks.routes");
const requisitionsRoutes = require("./routes/requisitions.routes");
const distributionRoutes = require("./routes/distribution.routes");
const ecartsRoutes = require("./routes/ecarts.routes");
const rapportsRoutes = require("./routes/rapports.routes");
const produitsRoutes = require("./routes/produits.routes");
const adminRoutes = require("./routes/admin.routes");
const inventairesRoutes = require("./routes/inventaires.routes");
const notificationsRoutes = require("./routes/notifications.routes");

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
app.use("/inventaires", inventairesRoutes);
app.use("/notifications", notificationsRoutes);

// Gestion simple des erreurs non prévues.
app.use((err, req, res, next) => {
  console.error(err);
  const messagePourClient =
    err.code === "P1001" || /Can't reach database server/.test(err.message || "")
      ? "Connexion à la base de données momentanément indisponible. Réessaie dans quelques secondes."
      : "Une erreur inattendue est survenue.";
  res.status(503).json({ erreur: messagePourClient });
});

// Filet de sécurité final : si une erreur asynchrone échappe malgré tout au
// middleware ci-dessus (ex. hors d'une requête HTTP), on la journalise sans
// jamais arrêter le processus — le serveur reste actif pour toutes les
// autres requêtes en cours.
process.on("unhandledRejection", (raison) => {
  console.error("Promesse rejetée non gérée :", raison);
});
process.on("uncaughtException", (erreur) => {
  console.error("Exception non interceptée :", erreur);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API GesMed démarrée sur le port ${PORT}`);
});