const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const { listerJournal, marquerVu, toutMarquerVu } = require("../controllers/journalEquipe.controller");

const router = express.Router();

// Réservé à l'administrateur.
router.use(authentifier, autoriser("ADMIN"));

router.get("/", listerJournal);
router.post("/tout-lu", toutMarquerVu); // avant "/:id/lu" par clarté
router.post("/:id/lu", marquerVu);

module.exports = router;